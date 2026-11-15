import { randomUUID } from 'node:crypto';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { RevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import {
  parentTaskParts,
  pluginDisposedMessage,
  readHostSession,
  readParentTranscript,
  resolveAgent,
} from '../hooks/task-session-manager/session-recovery';
import type { BackgroundJobLease } from '../utils/background-job-board';
import { getBackgroundJobLifecycleLedger } from '../utils/background-job-board';
import type { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { fetchChildTranscript, responseError } from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { log } from '../utils/logger';
import { getClient } from '../utils/opencode-client';
import {
  OperationTimeoutError,
  parseModelReference,
  SESSION_ID_PATTERN,
  withTimeout,
} from '../utils/session';
import { readLiveSession } from '../utils/session-runtime-status';
import type { ExperimentalV2 } from '../v2/client-shim';
import {
  assertManagedSession,
  cancelTrackedExecution,
  type TaskControlToolOptions,
} from './cancel-task';
import {
  idParamFor,
  readTaskRef,
  resolveTaskRecord,
  taskRefArgs,
} from './task-ref';

const z = tool.schema;
const DEFAULT_BASELINE_TIMEOUT_MS = 5_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 5_000;

class ReviveAdmissionDeadlineError extends Error {}

interface ReviveTimers {
  setTimeout: (callback: () => void, delay: number) => Timer | number;
  clearTimeout: (timer: Timer | number) => void;
}

export interface TaskReviveToolOptions extends TaskControlToolOptions {
  recoverRetainedSession: NonNullable<
    TaskControlToolOptions['recoverRetainedSession']
  >;
  backgroundJobSupervisor?: BackgroundJobSupervisor;
  revivedRunTracker: RevivedRunTracker;
  baselineTimeoutMs?: number;
  admissionTimeoutMs?: number;
  waitForIdleTimeoutMs?: number;
  idleWaitRuntime?: ReviveTimers & {
    now: () => number;
  };
  admissionTimers?: ReviveTimers;
  isDisposed?: () => boolean;
  isFallbackPending?: (taskID: string) => boolean;
  registerIntent?: (parentID: string, childID: string, agent: string) => void;
}

export function createTaskReviveTool(
  options: TaskReviveToolOptions,
): Record<'task_revive', ToolDefinition> {
  const revivedRunTracker = options.revivedRunTracker;
  const idParam = idParamFor(options.input);
  const task_revive = tool({
    description:
      'Revive a retained background task in its existing session with a new prompt. An untracked session ID (e.g. after a host restart) is verified against the host and re-adopted on demand.',
    args: {
      ...taskRefArgs(idParam),
      prompt: z.string().min(1).describe('Prompt for the revived task'),
      model: z
        .string()
        .optional()
        .describe(
          'Optional provider-qualified override using provider/model[#variant]. Colons belong to the model ID. v2 preserves variants; v1 promptAsync supports provider/model only.',
        ),
    },
    async execute(args, toolContext) {
      const parentSessionID = assertManagedSession(
        options,
        toolContext,
        'task_revive',
      );
      const requested = readTaskRef(args, idParam);
      const prompt = args.prompt.trim();
      if (!requested) throw new Error(`task_revive requires ${idParam}`);
      if (!prompt) throw new Error('task_revive requires prompt');
      const parsedModelReference =
        args.model === undefined ? undefined : parseModelReference(args.model);
      if (args.model !== undefined && !parsedModelReference) {
        throw new Error(
          'Invalid model reference: expected provider/model[#variant]',
        );
      }
      if (parsedModelReference && !parsedModelReference.providerID) {
        throw new Error(
          'Invalid model reference: provider is required for task_revive; use provider/model[#variant]',
        );
      }
      const modelReference = parsedModelReference?.providerID
        ? {
            providerID: parsedModelReference.providerID,
            modelID: parsedModelReference.modelID,
            ...(parsedModelReference.variant
              ? { variant: parsedModelReference.variant }
              : {}),
          }
        : undefined;

      const ref = await resolveTaskRecord(options, parentSessionID, requested);
      if (ref.kind === 'disposed') throw new Error(pluginDisposedMessage());
      if (ref.kind === 'refused') throw new Error(ref.reason);
      const { identity, canonical } = ref;
      let resolved = ref.job;
      if (resolved && resolved.parentSessionID !== parentSessionID) {
        throw new Error(`Unknown or unowned background task: ${requested}`);
      }
      let adopted = resolved?.recoveredWithoutPrompt === true;
      if (!resolved) {
        const guidance = await resolveOrAdoptUntrackedTask(
          options,
          parentSessionID,
          identity,
          SESSION_ID_PATTERN.test(requested),
        );
        if (guidance !== undefined) throw new Error(guidance);
        // undefined ⇒ adopted: the board now owns a fresh record for this
        // session, so the resolution below must be repeated.
        resolved = canonical
          ? options.backgroundJobBoard.get(identity)
          : options.backgroundJobBoard.resolve(parentSessionID, requested);
        adopted = true;
      }
      if (!resolved) {
        throw new Error(
          `task_revive adoption did not produce a tracked record for ${requested}`,
        );
      }

      let current = getCurrentReviveJob(
        options,
        parentSessionID,
        resolved.taskID,
        resolved.generation,
      );
      const captured = {
        taskID: current.taskID,
        generation: current.generation,
        agent: current.agent,
        deletionEpoch: getBackgroundJobLifecycleLedger(
          options.backgroundJobBoard,
        ).deletionEpochs.get(current.taskID),
        activityRevision: current.activityRevision,
        lastLiveBusyAt: current.lastLiveBusyAt,
      };
      const queuedRun = revivedRunTracker.promptMessageIDFor?.(
        current.taskID,
        current.generation,
      );
      if (queuedRun && current.state === 'running') {
        throw new Error(
          `Task ${requested} already has a queued continuation; do not retry task_revive. Use task_status to inspect it.`,
        );
      }
      // Establish a real verification mechanism before any destructive abort.
      // A historical session.get outcome is not a live-idle capability.
      const session = getClient(options.input).session;
      const hasStatusMap = typeof session.status === 'function';
      const channel = (options.input as { experimental_v2?: ExperimentalV2 })
        .experimental_v2?.waitForSessionIdle;
      const waitForIdle =
        !hasStatusMap && typeof channel === 'function' ? channel : undefined;
      // Restored uncertainty is not terminal evidence or abort ownership.
      // Recover only through the native idle + exact queued-input protocol.
      const recoverRetained =
        !hasStatusMap &&
        !!waitForIdle &&
        supportsQueuedContinuation(options) &&
        isRestoredUncertainJob(current);
      if (recoverRetained && args.model !== undefined) {
        throw new Error(
          'Restored uncertain recovery inherits the persisted session selection; omit model to recover. Explicit model/variant overrides are not supported on this recovery path; no prompt or model switch was sent',
        );
      }
      const hasRecoveryAuthority = () => {
        if (
          toolContext.sessionID !== parentSessionID ||
          !options.shouldManageSession(parentSessionID)
        )
          return false;
        const liveChannel = (
          options.input as { experimental_v2?: ExperimentalV2 }
        ).experimental_v2?.waitForSessionIdle;
        return (
          supportsQueuedContinuation(options) &&
          typeof liveChannel === 'function' &&
          liveChannel === waitForIdle &&
          typeof getClient(options.input).session.status !== 'function'
        );
      };
      const queueContinuation =
        supportsQueuedContinuation(options) &&
        (adopted || !!queuedRun || recoverRetained);
      const promptMessageID = queueContinuation
        ? `msg_omos_revive_${randomUUID().replaceAll('-', '')}`
        : undefined;
      if (queueContinuation && !waitForIdle) {
        throw new Error(
          'task_revive queued continuation requires waitForSessionIdle; no prompt was sent',
        );
      }
      if (!queueContinuation && !hasStatusMap && !waitForIdle) {
        throw new Error(
          'task_revive idle-verification capability unavailable: the host must expose session.status or waitForSessionIdle; no abort or prompt was sent',
        );
      }

      // Fail closed: verify identity before any destructive operation.
      const preCancelVerify = await verifyReviveIdentity(
        options,
        parentSessionID,
        captured.taskID,
        captured.generation,
      );
      if (!preCancelVerify.ok) {
        throw new Error(
          `Task ${requested} cannot be revived: identity unverified (${preCancelVerify.reason})`,
        );
      }
      if (recoverRetained) {
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          captured.taskID,
          captured.generation,
        );
        assertRetainedRecovery(options, current);
      }

      let cancelledForRevive = false;
      // Adoption does not grant ownership of the pre-existing execution.
      // V2 queues behind it; V1 retains the live-state verification below.
      if (current.state === 'running' && !adopted && !queueContinuation) {
        if (
          options.isFallbackPending?.(current.taskID) ||
          revivedRunTracker.isObservationPending(
            current.taskID,
            current.generation,
          ) ||
          revivedRunTracker.isFallbackRun(current.taskID, current.generation)
        ) {
          throw new Error(
            `Task ${requested} is recovering on a fallback model; wait for its result. Use task_cancel if it is obsolete.`,
          );
        }
        await cancelTrackedExecution(options, captured, 'revived');
        cancelledForRevive = true;
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          captured.taskID,
          captured.generation,
        );
      }

      if (
        !cancelledForRevive &&
        !adopted &&
        !recoverRetained &&
        !isReviveableRetainedJob(current)
      ) {
        throw new Error(
          `Task ${requested} cannot be revived: state ${current.state} is not a verified retained terminal session`,
        );
      }

      const relaunchLease = options.backgroundJobBoard.acquireLease(
        current.taskID,
        current.generation,
        'relaunch',
      );
      if (!relaunchLease) {
        throw new Error(
          `Task ${requested} cannot be revived: relaunch lease unavailable`,
        );
      }

      let admissionOwner: { settled: boolean } | undefined;
      let retainRelaunchLease = false;
      let launched:
        | ReturnType<
            TaskControlToolOptions['backgroundJobBoard']['registerLaunch']
          >
        | undefined;
      try {
        const observedLiveBusyAt = recoverRetained
          ? captured.lastLiveBusyAt
          : current.lastLiveBusyAt;
        const deletionEpoch = recoverRetained
          ? captured.deletionEpoch
          : getBackgroundJobLifecycleLedger(
              options.backgroundJobBoard,
            ).deletionEpochs.get(current.taskID);
        const baselineMessageID = queueContinuation
          ? undefined
          : await withTimeout(
              revivedRunTracker.captureBaseline(current.taskID),
              Math.max(
                1,
                options.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS,
              ),
              'Baseline capture deadline exceeded; the revive prompt was NOT sent',
            );
        if (!queueContinuation && waitForIdle) {
          await waitForNativeIdle(options, current.taskID, waitForIdle);
        } else if (!queueContinuation) {
          const live = await readLiveSession(options.input, current.taskID);
          if (live.kind === 'busy' || live.kind === 'retry') {
            throw new Error(
              `Task ${requested} is executing at the host (live status: ${live.kind}); the revive prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
            );
          }
          if (live.kind === 'unknown') {
            throw new Error(
              `Task ${requested} could not be verified against the live session map (${live.reason}); the revive prompt was NOT sent. Retry task_revive.`,
            );
          }
        }
        if (typeof session.promptAsync !== 'function') {
          throw new Error('The host session does not support promptAsync');
        }
        // Both reads above await network I/O. Revalidate immediately before
        // sending: live busy can restore running even under a relaunch lease.
        // A changed busy timestamp also fences activity that stopped again.
        current = getCurrentReviveJob(
          options,
          parentSessionID,
          captured.taskID,
          captured.generation,
        );
        // After async verification, fence generation/parent/agent again.
        const postAwaitVerify = await verifyReviveIdentity(
          options,
          parentSessionID,
          current.taskID,
          current.generation,
        );
        if (!postAwaitVerify.ok) {
          throw new Error(
            `Task ${requested} revive blocked after verification: identity unverified (${postAwaitVerify.reason})`,
          );
        }
        if (
          options.isDisposed?.() ||
          getBackgroundJobLifecycleLedger(
            options.backgroundJobBoard,
          ).deletionEpochs.get(current.taskID) !== deletionEpoch ||
          !options.backgroundJobBoard.validateLease(relaunchLease) ||
          // V1 adoption still requires live quiescence. The V2 identity-bound
          // queue path deliberately permits the existing execution to run.
          (!queueContinuation &&
            !adopted &&
            !isReviveableRetainedJob(current)) ||
          (!queueContinuation &&
            current.lastLiveBusyAt !== undefined &&
            current.lastLiveBusyAt !== observedLiveBusyAt)
        ) {
          throw new Error(
            `Task ${requested} became active again (${current.state}) before the revive prompt was sent; the prompt was NOT sent and no duplicate was launched. Use task_status to inspect it.`,
          );
        }
        // A remote resume can race this send. `queue` avoids steering an
        // in-flight run, but may enqueue a continuation after an independent
        // resume; it does not deduplicate. The v1 SDK ignores this client-side
        // hint (not part of the HTTP request); the v2 shim forwards it.
        const admissionStartedAt = Date.now();
        // Verify identity freshly before owning admission or sending prompt.
        const preLaunchVerify = await verifyReviveIdentity(
          options,
          parentSessionID,
          current.taskID,
          current.generation,
        );
        if (!preLaunchVerify.ok) {
          throw new Error(
            `Task ${requested} revive blocked: identity unverified (${preLaunchVerify.reason})`,
          );
        }
        if (queueContinuation && waitForIdle) {
          await waitForNativeIdle(options, current.taskID, waitForIdle);
          current = getCurrentReviveJob(
            options,
            parentSessionID,
            captured.taskID,
            captured.generation,
          );
          if (
            options.isDisposed?.() ||
            getBackgroundJobLifecycleLedger(
              options.backgroundJobBoard,
            ).deletionEpochs.get(current.taskID) !== deletionEpoch ||
            !options.backgroundJobBoard.validateLease(relaunchLease) ||
            current.lastLiveBusyAt !== observedLiveBusyAt
          ) {
            throw new Error(
              `Task ${requested} changed or became active while waiting for idle; the revive prompt was NOT sent`,
            );
          }
        }
        if (recoverRetained) {
          // Idle proves quiescence, not a historical outcome. Re-check host
          // identity after that await, then fence local mutations synchronously.
          const verified = await verifyReviveIdentity(
            options,
            parentSessionID,
            captured.taskID,
            captured.generation,
          );
          current = getCurrentReviveJob(
            options,
            parentSessionID,
            captured.taskID,
            captured.generation,
          );
          if (
            !verified.ok ||
            !hasRecoveryAuthority() ||
            verified.agent !== captured.agent ||
            verified.agent !== preLaunchVerify.agent ||
            options.isDisposed?.() ||
            getBackgroundJobLifecycleLedger(
              options.backgroundJobBoard,
            ).deletionEpochs.get(current.taskID) !== deletionEpoch ||
            !options.backgroundJobBoard.validateLease(relaunchLease) ||
            current.activityRevision !== captured.activityRevision ||
            current.lastLiveBusyAt !== observedLiveBusyAt
          ) {
            throw new Error(
              `Task ${requested} changed during retained recovery; the revive prompt was NOT sent`,
            );
          }
          assertRetainedRecovery(options, current);
        }
        if (promptMessageID) {
          // Own this one input before sending. A late acknowledgement must
          // never reinstall the tracker after it has delivered the answer.
          launched = options.backgroundJobBoard.registerLaunch({
            taskID: current.taskID,
            parentSessionID,
            agent: preLaunchVerify.agent,
            description: current.description,
            objective: current.objective,
            background: true,
            relaunchLease,
            ...(recoverRetained
              ? { pendingPromptAdmissionID: promptMessageID }
              : {}),
            now: admissionStartedAt,
            // Identity anchor: the client-chosen input id this revive sends
            // is the exact transcript message the new generation runs on.
            runInputMessageID: promptMessageID,
          });
          revivedRunTracker.register({
            taskID: launched.taskID,
            generation: launched.generation,
            parentSessionID,
            promptMessageID,
            admissionLease: relaunchLease,
            attemptStartedAt: admissionStartedAt,
            description: launched.description,
          });
          // A session-wide timeout abort could kill the preceding execution.
          // This input is observed by identity, without an automatic abort.
        }
        options.registerIntent?.(
          parentSessionID,
          current.taskID,
          preLaunchVerify.agent,
        );
        if (recoverRetained) {
          // No selection await is permitted after this fence. The inherited
          // shim path calls native prompt synchronously up to its admission.
          const authority = hasRecoveryAuthority();
          const pending = options.backgroundJobBoard.get(captured.taskID);
          const ownsUnchangedInput =
            launched !== undefined &&
            pending === launched &&
            pending.parentSessionID === parentSessionID &&
            pending.agent === captured.agent &&
            pending.activityRevision === 0 &&
            pending.lastLiveBusyAt === admissionStartedAt &&
            pending.pendingPromptAdmissionID === promptMessageID &&
            revivedRunTracker.promptMessageIDFor(
              pending.taskID,
              pending.generation,
            ) === promptMessageID &&
            !options.isFallbackPending?.(pending.taskID) &&
            !revivedRunTracker.isObservationPending(
              pending.taskID,
              pending.generation,
            ) &&
            !revivedRunTracker.isFallbackRun(
              pending.taskID,
              pending.generation,
            ) &&
            !pending.cancellationRequested &&
            !pending.timedOut &&
            !options.isDisposed?.() &&
            options.backgroundJobBoard.validateLease(relaunchLease) &&
            getBackgroundJobLifecycleLedger(
              options.backgroundJobBoard,
            ).deletionEpochs.get(captured.taskID) === deletionEpoch;
          if (!authority || !ownsUnchangedInput) {
            // No remote write exists. Roll back only this unchanged owned
            // provisional input; never overwrite observed activity/successors.
            if (ownsUnchangedInput && launched) {
              const refused = launched;
              if (
                options.backgroundJobBoard.abandonLaunch(refused, relaunchLease)
              ) {
                launched = undefined;
                revivedRunTracker.discard(refused.taskID, refused.generation);
              } else {
                retainRelaunchLease = true;
              }
            } else {
              // Observed activity or another owner prevents safe rollback.
              // Keep conservative exclusion without inventing a remote write.
              retainRelaunchLease = true;
            }
            throw new Error(
              'Retained recovery authority changed before submission; no prompt was sent',
            );
          }
        }
        const request = (
          session.promptAsync as (
            args: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          path: { id: current.taskID },
          query: { directory: options.input.directory },
          body: {
            agent: preLaunchVerify.agent,
            ...(promptMessageID ? { messageID: promptMessageID } : {}),
            ...(modelReference
              ? {
                  model: {
                    providerID: modelReference.providerID,
                    modelID: modelReference.modelID,
                    ...('hostFlavor' in options.input &&
                    options.input.hostFlavor === 'v2' &&
                    modelReference.variant
                      ? { variant: modelReference.variant }
                      : {}),
                  },
                }
              : {}),
            parts: [{ type: 'text', text: prompt }],
          },
          delivery: 'queue',
          ...(recoverRetained ? { modelSelection: 'inherit' } : {}),
        });
        // This captured owner, not the caller's deadline, owns settlement.
        // Keep exclusion while admission is unknown; never retry the write.
        const owner = { settled: false, transferred: false };
        admissionOwner = owner;
        const admission = Promise.resolve(request)
          .then((response) => {
            if (owner.settled) return;
            owner.settled = true;
            const apiError = responseError(response);
            if (apiError !== undefined) {
              // An explicit refusal admitted nothing. Release the queued
              // identity so the task neither waits for it nor fences retries.
              if (queueContinuation && launched) {
                const refused = launched;
                if (
                  options.backgroundJobBoard.abandonLaunch(
                    refused,
                    relaunchLease,
                  )
                ) {
                  launched = undefined;
                  revivedRunTracker.discard(refused.taskID, refused.generation);
                } else {
                  owner.transferred = true;
                  throw new Error(
                    `${errorText(apiError)}; rollback ownership changed; exclusion retained`,
                  );
                }
              }
              throw new Error(errorText(apiError));
            }
            // Retirement is not deletion. The accepted write is not resent
            // and is not compensated with abort. Settle only this lease.
            if (
              options.isDisposed?.() &&
              options.backgroundJobBoard.get(captured.taskID)
            ) {
              throw new Error(
                'the revive write was accepted, but this plugin instance is retired and will not track it',
              );
            }
            if (queueContinuation) {
              if (
                !launched ||
                options.backgroundJobBoard.get(captured.taskID)?.generation !==
                  launched.generation
              ) {
                owner.transferred = true;
                throw new Error(
                  'queued admission became stale; no interrupt sent and exclusion retained',
                );
              }
              const admitted = options.backgroundJobBoard.get(captured.taskID);
              if (
                recoverRetained &&
                admitted?.pendingPromptAdmissionID !== undefined
              ) {
                const acknowledgedInputID = admitted.pendingPromptAdmissionID;
                if (
                  admitted.parentSessionID !== parentSessionID ||
                  admitted.agent !== captured.agent ||
                  getBackgroundJobLifecycleLedger(
                    options.backgroundJobBoard,
                  ).deletionEpochs.get(captured.taskID) !== deletionEpoch ||
                  !options.backgroundJobBoard.validateLease(relaunchLease) ||
                  acknowledgedInputID !== promptMessageID ||
                  !isRecord(response) ||
                  response.id !== acknowledgedInputID ||
                  !options.backgroundJobBoard.confirmPromptAdmission(
                    captured.taskID,
                    launched.generation,
                    acknowledgedInputID,
                  )
                ) {
                  owner.transferred = true;
                  throw new ReviveAdmissionDeadlineError(
                    'Queued input admission is not attributable; exclusion retained',
                  );
                }
              }
              return;
            }
            // Deletion wins, but it leaves this write's lease alive. Only
            // that precise case may compensate; all stale owners/generations
            // still go through registerLaunch's existing rejection fence.
            if (
              !options.backgroundJobBoard.get(captured.taskID) &&
              options.backgroundJobBoard.validateLease(relaunchLease)
            ) {
              owner.transferred = true;
              // Starts synchronously under the lease, independently of the
              // admission race. Its abort is never awaited by this caller.
              void ownInvalidatedAdmission(options, relaunchLease);
              throw new Error(
                'admission accepted but invalidated by loss of the record; compensation initiated',
              );
            }
            if (current.terminalUnreconciled) {
              const acked = options.backgroundJobBoard.markReconciled(
                current.taskID,
                admissionStartedAt,
                current.generation,
                current.terminalRevision,
              );
              if (
                !acked ||
                acked.generation !== current.generation ||
                (acked.state !== 'reconciled' && acked.terminalUnreconciled)
              ) {
                throw new Error(
                  `Task ${requested} old round could not be acknowledged; no new generation was registered`,
                );
              }
            }
            launched = options.backgroundJobBoard.registerLaunch({
              taskID: current.taskID,
              parentSessionID,
              agent: preLaunchVerify.agent,
              description: current.description,
              objective: current.objective,
              background: true,
              relaunchLease,
              now: admissionStartedAt,
            });
            revivedRunTracker.register({
              taskID: launched.taskID,
              generation: launched.generation,
              parentSessionID,
              baselineMessageID,
              promptMessageID,
              attemptStartedAt: admissionStartedAt,
              description: launched.description,
            });
            options.backgroundJobSupervisor?.onLaunch(launched);
          })
          .catch((error: unknown) => {
            if (queueContinuation && !owner.settled) {
              // A rejected transport can still have admitted the input. Keep
              // identity and exclusion; never turn uncertainty into a retry.
              owner.transferred = true;
              throw new ReviveAdmissionDeadlineError(
                `Queued admission outcome unknown: ${errorText(error)}`,
              );
            }
            throw error;
          })
          .finally(() => {
            owner.settled = true;
            if (!owner.transferred)
              options.backgroundJobBoard.releaseLease(relaunchLease);
          });
        const observation = admission
          .then(async () => {
            if (!launched) return;
            try {
              await revivedRunTracker.probe(
                launched.taskID,
                launched.generation,
              );
            } catch (error) {
              log('[task-revive] observation failed', {
                taskID: current.taskID,
                error: errorText(error),
              });
            }
          })
          .catch((error: unknown) => {
            if (launched && !(recoverRetained && owner.transferred)) {
              options.backgroundJobBoard.markStatusUncertain(
                current.taskID,
                `task_revive failed: ${errorText(error)}`,
                launched.generation,
              );
            }
            log('[task-revive] admission failed', {
              taskID: current.taskID,
              error: errorText(error),
            });
          });
        const setAdmissionTimer =
          options.admissionTimers?.setTimeout ?? setTimeout;
        const clearAdmissionTimer =
          options.admissionTimers?.clearTimeout ??
          ((timer: Timer | number) => clearTimeout(timer));
        let admissionTimer: Timer | number | undefined;
        try {
          await Promise.race([
            admission,
            new Promise<never>((_, reject) => {
              admissionTimer = setAdmissionTimer(
                () =>
                  reject(
                    new ReviveAdmissionDeadlineError(
                      'Revive admission deadline exceeded',
                    ),
                  ),
                Math.max(
                  1,
                  options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
                ),
              );
            }),
          ]);
        } catch (error) {
          // Preserve the local race outcome, regardless of later settlement.
          // A timeout error from the transport is still an admission failure.
          if (error instanceof ReviveAdmissionDeadlineError) {
            return renderReviveOutput(
              idParam,
              queueContinuation ? (launched ?? current) : current,
              true,
            );
          }
          throw error;
        } finally {
          if (admissionTimer !== undefined) clearAdmissionTimer(admissionTimer);
        }
        // Observe fast completion without holding exclusion over the probe.
        await observation;
      } catch (error) {
        throw new Error(`Task ${requested} revive failed: ${errorText(error)}`);
      } finally {
        // Before a write exists there is no late admission to protect.
        if (!admissionOwner && !retainRelaunchLease)
          options.backgroundJobBoard.releaseLease(relaunchLease);
      }

      if (!launched) {
        throw new Error(`Task ${requested} revive did not launch`);
      }
      const latest = options.backgroundJobBoard.get(current.taskID);
      if (!latest || latest.generation !== launched.generation) {
        throw new Error(
          `Task ${requested} revive became stale before launch completed`,
        );
      }
      return renderReviveOutput(idParam, latest);
    },
  });

  return { task_revive };
}

/**
 * Owns a single compensating abort after deletion invalidates an accepted
 * admission. The board retains the token even without a job: no TTL, retry,
 * terminal publication, or recovery is allowed on this path.
 */
async function ownInvalidatedAdmission(
  options: TaskReviveToolOptions,
  lease: BackgroundJobLease,
): Promise<void> {
  const board = options.backgroundJobBoard;
  const { taskID, generation } = lease;
  const stillOwns = () => {
    const valid = board.validateLease(lease) && !board.get(taskID);
    if (!valid)
      log('[task-revive] compensation ownership lost', { taskID, generation });
    return valid;
  };
  try {
    const session = getClient(options.input).session;
    // No await between this fence and issuing the only compensating write.
    if (!stillOwns()) return;
    const response = await session.abort({ path: { id: taskID } });
    // No local abort timeout: an idle read cannot retire a token while the
    // remote write could still execute. Only actual settlement reaches here.
    if (!stillOwns()) return;
    const apiError = responseError(response);
    if (apiError !== undefined)
      throw new Error(`abort failed: ${errorText(apiError)}`);

    // Historical session.get outcomes cannot prove the accepted run stopped.
    // Take fresh live evidence after abort settlement, with a bounded budget.
    const live = await readLiveSession(options.input, taskID, {
      timeoutMs: options.verifyAbortMs ?? 1_500,
    });
    if (!stillOwns()) return;
    if (live.kind !== 'idle' && live.kind !== 'absent') {
      throw new Error(
        `live quiescence not verified: ${live.kind === 'unknown' ? live.reason : live.kind}`,
      );
    }

    // Valid idle/absence proves current quiescence, not purging queued work.
    // Revalidate above and release synchronously: never retire a successor.
    board.releaseLease(lease);
    log('[task-revive] compensation quiescence verified', {
      taskID,
      generation,
    });
  } catch (error) {
    // Explicit quarantine: retain exclusion without fabricating a cancelled
    // record or notifying a deleted parent. No automatic recovery/retry.
    log('[task-revive] compensation unconfirmed', {
      taskID,
      generation,
      error: errorText(error),
      leaseRetained: board.validateLease(lease),
    });
  }
}

function renderReviveOutput(
  idParam: string,
  record: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
  admissionUnknown = false,
): string {
  const state =
    record.state === 'reconciled'
      ? (record.terminalState ?? record.state)
      : record.state;
  const lines = [
    `${idParam}: ${record.taskID}`,
    `state: ${state}`,
    `status: ${admissionUnknown ? 'admission_unknown' : state === 'running' ? 'started' : state}`,
  ];
  if (record.statusUncertain) {
    lines.push(
      'status_uncertain: true',
      `observation: ${record.lastStatusError ?? 'Task termination is unconfirmed.'}`,
    );
  }
  if (admissionUnknown) {
    lines.push(
      'The host may have accepted the prompt. Admission is still pending; do not retry task_revive. Use task_status to inspect the session.',
    );
  } else if (record.resultSummary !== undefined) {
    const tag = state === 'completed' ? 'task_result' : 'task_error';
    lines.push('', `<${tag}>`, record.resultSummary, `</${tag}>`);
  }
  return lines.join('\n');
}

function getCurrentReviveJob(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  taskID: string,
  generation: number,
): NonNullable<ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>> {
  const current = options.backgroundJobBoard.get(taskID);
  if (!current || current.parentSessionID !== parentSessionID) {
    throw new Error(
      `Task ${taskID} is no longer tracked; refusing stale revive`,
    );
  }
  if (current.generation !== generation) {
    throw new Error(
      `Task ${taskID} run generation changed; refusing stale revive`,
    );
  }
  return current;
}

function isReviveableRetainedJob(
  job: NonNullable<
    ReturnType<TaskReviveToolOptions['backgroundJobBoard']['get']>
  >,
): boolean {
  if (job.statusUncertain) return false;
  if (job.state === 'stopped') return true;
  if (
    job.state === 'completed' ||
    job.state === 'error' ||
    job.state === 'cancelled'
  ) {
    return true;
  }
  return job.state === 'reconciled' && job.terminalState !== undefined;
}

function isRestoredUncertainJob(
  job: Parameters<typeof isReviveableRetainedJob>[0],
): boolean {
  return (
    job.externalOrigin === true &&
    job.state === 'stopped' &&
    job.statusUncertain === true &&
    job.pendingPromptAdmissionID === undefined &&
    !job.cancellationRequested &&
    !job.timedOut &&
    job.terminalState === undefined
  );
}

function assertRetainedRecovery(
  options: TaskReviveToolOptions,
  job: Parameters<typeof isReviveableRetainedJob>[0],
): void {
  if (
    !isRestoredUncertainJob(job) ||
    options.isFallbackPending?.(job.taskID) ||
    options.revivedRunTracker.isObservationPending(
      job.taskID,
      job.generation,
    ) ||
    options.revivedRunTracker.isFallbackRun(job.taskID, job.generation) ||
    options.revivedRunTracker.promptMessageIDFor(job.taskID, job.generation)
  ) {
    throw new Error(
      `Task ${job.taskID} retained recovery is blocked by changed state or pending admission; no prompt was sent`,
    );
  }
}

async function waitForNativeIdle(
  options: TaskReviveToolOptions,
  taskID: string,
  wait: NonNullable<ExperimentalV2['waitForSessionIdle']>,
): Promise<void> {
  const timeoutMs =
    options.waitForIdleTimeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid session idle wait timeout; no prompt was sent');
  }
  const now = options.idleWaitRuntime?.now ?? Date.now;
  const setTimer = options.idleWaitRuntime?.setTimeout ?? setTimeout;
  const clearTimer =
    options.idleWaitRuntime?.clearTimeout ??
    ((timer: Timer | number) => clearTimeout(timer));
  const message = 'Session idle wait timed out; the revive prompt was NOT sent';
  const deadline = now() + timeoutMs;
  const waiting = wait(taskID);
  if (!waiting || typeof waiting.then !== 'function') {
    throw new Error('Invalid session idle wait operation; no prompt was sent');
  }
  const expired = Promise.withResolvers<never>();
  const timer = setTimer(
    () => expired.reject(new OperationTimeoutError(message)),
    timeoutMs,
  );
  try {
    // The native adapter cannot abort this read. A late settlement only
    // settles the observed race loser; it never resumes the abandoned send.
    const completion = await Promise.race([waiting, expired.promise]);
    if (now() >= deadline) throw new OperationTimeoutError(message);
    if (completion !== undefined) {
      throw new Error('Invalid session idle wait result; no prompt was sent');
    }
  } finally {
    clearTimer(timer);
  }
}

/** Shared recovery verifies ownership and agent before adopting a continuation. */
async function resolveOrAdoptUntrackedTask(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  requested: string,
  allowExactAdoption: boolean,
): Promise<string | undefined> {
  const prefix = `Unknown or unowned background task: ${requested}`;
  const recovery = await options.recoverRetainedSession({
    parentSessionID,
    requested,
    purpose: 'revive',
    allowExactAdoption,
    allowQueuedContinuation: supportsQueuedContinuation(options),
  });
  if (recovery.kind === 'refused') return recovery.reason;
  if (options.isDisposed?.()) return 'Session recovery was disposed';
  if (recovery.kind !== 'adoptable') return undefined;
  const raced = options.backgroundJobBoard.get(recovery.taskID);
  if (raced)
    return raced.parentSessionID === parentSessionID
      ? undefined
      : `${prefix}. Tracking does not survive a host restart; verify whether the host restored it before re-dispatching.`;
  if (
    getBackgroundJobLifecycleLedger(
      options.backgroundJobBoard,
    ).deletionEpochs.get(recovery.taskID) !== recovery.deletionEpoch
  ) {
    return `Task ${requested} was deleted during recovery; no prompt was sent`;
  }
  const adopted = options.backgroundJobBoard.registerLaunch({
    taskID: recovery.taskID,
    parentSessionID,
    agent: recovery.agent,
    description: recovery.description,
    background: true,
    adopted: true,
    now: Date.now(),
  });
  // Until a continuation is accepted this row still represents recovered
  // host work, including across a refused pre-send attempt.
  adopted.recoveredWithoutPrompt = true;
  log('[task-revive] adopted untracked session', {
    taskID: recovery.taskID,
    parentSessionID,
    agent: recovery.agent,
  });
  return undefined;
}

function supportsQueuedContinuation(options: TaskReviveToolOptions): boolean {
  return (
    (options.input as { experimental_v2?: ExperimentalV2 }).experimental_v2
      ?.queuedPromptIdentity === true
  );
}

export async function verifyReviveIdentity(
  options: TaskReviveToolOptions,
  parentSessionID: string,
  taskID: string,
  expectedGeneration: number,
): Promise<
  { ok: true; agent: string; parentID: string } | { ok: false; reason: string }
> {
  // Board consistency: generation/parent must not have mutated.
  const board = options.backgroundJobBoard.get(taskID);
  if (!board || board.parentSessionID !== parentSessionID) {
    return { ok: false, reason: 'parent session mismatch or record lost' };
  }
  if (board.generation !== expectedGeneration) {
    return { ok: false, reason: 'generation changed' };
  }

  const client = getClient(options.input);
  const directory = options.input.directory;

  // Host identity must be established from session evidence, not persisted board.
  const hosted = await readHostSession(client, directory, taskID);
  if (hosted.kind !== 'ok') {
    return { ok: false, reason: hosted.reason || 'host session unavailable' };
  }
  if (hosted.parentID !== parentSessionID) {
    return { ok: false, reason: 'host parent mismatch' };
  }

  // Resolve agent strictly from host/transcript evidence; never use board.agent
  // as authority when host/transcript can supply it.
  let childTranscript: unknown;
  try {
    childTranscript = await withTimeout(
      fetchChildTranscript(client, taskID, directory),
      3_000,
      'transcript read timed out',
    );
  } catch {
    childTranscript = undefined;
  }
  let parentTranscript: unknown;
  try {
    parentTranscript = await withTimeout(
      readParentTranscript(
        client,
        directory,
        parentSessionID,
        (options.input as { hostFlavor?: string }).hostFlavor,
      ),
      3_000,
      'parent transcript timed out',
    );
  } catch {
    parentTranscript = undefined;
  }
  const agentResult = resolveAgent({
    sessionID: taskID,
    sessionAgent: hosted.agent,
    childTranscript,
    parentParts: parentTaskParts(parentTranscript ?? { data: [] }),
    parentSessionID,
  });
  if (agentResult.kind !== 'ok') {
    return { ok: false, reason: agentResult.reason || 'agent unverified' };
  }
  const verifiedAgent = agentResult.agent;

  // Fail closed on conflict with any persisted claim.
  if (board.agent !== undefined && board.agent !== verifiedAgent) {
    return { ok: false, reason: 'agent evidence conflicts' };
  }
  // No fallback to persisted agent when host/transcript is unavailable.
  if (verifiedAgent === undefined || verifiedAgent === 'unknown') {
    return { ok: false, reason: 'agent unverified' };
  }

  // After verification, re-fetch board to ensure it hasn't changed during I/O.
  const fresh = options.backgroundJobBoard.get(taskID);
  if (
    !fresh ||
    fresh.parentSessionID !== parentSessionID ||
    fresh.generation !== expectedGeneration
  ) {
    return {
      ok: false,
      reason: 'generation/parent mutated during verification',
    };
  }
  if (fresh.agent !== undefined && fresh.agent !== verifiedAgent) {
    return { ok: false, reason: 'agent mutated during verification' };
  }

  return { ok: true, agent: verifiedAgent, parentID: hosted.parentID };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
