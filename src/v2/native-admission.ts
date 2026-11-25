import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { JsonSchema, Schema, SchemaRepresentation } from 'effect';
import { z } from 'zod';
import {
  createQueueMirrorPublisher,
  type QueueMirrorPublisher,
} from '../queue-mirror-publisher';
import { waitForAdmission } from '../utils/background-task-admission-wait';
import {
  BackgroundTaskConcurrency,
  type BackgroundTaskConcurrencyConfig,
  type BackgroundTaskConcurrencyTicket,
} from '../utils/background-task-concurrency';
import { taskDependencyFieldsSchema } from '../utils/background-task-dependencies';
import type { BackgroundTaskTerminalState } from '../utils/background-task-state';
import { getGlobalStore } from '../utils/global-store';
import { isRecord } from '../utils/guards';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import {
  hostRoundStateOf,
  hostRunningSince,
} from '../utils/session-runtime-status';
import {
  type NativeAdmissionRecovery,
  nativeAdmissionChildrenKey,
  nativeAdmissionRecoveryFor,
  registerNativeAdmissionRecovery,
} from './native-admission-recovery';
import type { V2Session } from './types';

const unlimited: BackgroundTaskConcurrencyConfig = {
  defaultConcurrency: 0,
  providerConcurrency: {},
  modelConcurrency: {},
};

type Execute = (input: unknown, context: unknown) => Promise<unknown>;
type WrapOptions = {
  session?: Pick<V2Session, 'list' | 'wait' | 'get'>;
  shouldManageSession?: (parentID: string) => boolean;
  resolveModel?: (
    input: Record<string, unknown>,
    parentSessionID: string,
  ) => string | undefined | Promise<string | undefined>;
};

type NativeToolContext = {
  sessionID: string;
  signal?: AbortSignal;
  progress(update: Record<string, unknown>): Promise<void>;
};

type Binding = {
  ticket: Pick<BackgroundTaskConcurrencyTicket, 'settle'>;
  scheduler: BackgroundTaskConcurrency;
  directory: string;
  removeLocalBinding: () => void;
  stopForwardingAbort: () => void;
  acceptingPrompt: boolean;
  newChild: boolean;
  recoveredBusyAt?: number;
  session?: WrapOptions['session'];
  accepted?: boolean;
  unidentifiedTerminal?: { seq: number; created?: number };
  reconcilingIdle?: boolean;
  childID?: string;
  inboxID?: string;
  enqueueSeq?: number;
  delivered?: boolean;
  finished?: boolean;
  settlement?: Promise<void>;
};

type ChildBindings = {
  calls: Set<Binding>;
  lastSeq: number;
  startedSeq?: number;
  observe: (event: Record<string, unknown>) => boolean;
};

// The Promise adapter enters the native Effect executor in this call's async
// context. Pinned Effect restores it across fiber yields and forks. Share it
// across loaded Slim locations and reloads because the child may have moved.
const promptAdmission = getGlobalStore(
  'oh-my-opencode-slim.native-admission',
  () => new AsyncLocalStorage<Binding>(),
);
const bindings = getGlobalStore(
  nativeAdmissionChildrenKey,
  () => new Map<string, ChildBindings>(),
);

/** Native fields are strings and optional strings, including the branded
 * Session.ID. Project their validators without mixing AST nodes from separate
 * Effect bundles. The host's Standard Schema path calls our single parser. */
export function extendNativeSubagentInput(input: unknown): unknown {
  const nativeSchema = Schema.isSchema(input) ? input : undefined;
  const source = nativeSchema
    ? Schema.toJsonSchemaDocument(nativeSchema, {
        onExcessProperty: 'error',
        referencePolicy: () => undefined,
      }).schema
    : input;
  if (
    !isRecord(source) ||
    source.type !== 'object' ||
    !isRecord(source.properties)
  ) {
    throw new Error(
      'OpenCode subagent input does not expose its object schema',
    );
  }
  const json = {
    ...source,
    properties: {
      ...source.properties,
      ...z.toJSONSchema(taskDependencyFieldsSchema).properties,
    },
  };
  // The pinned native fields have identical encoded and decoded values. Its
  // own `make` uses the host parser and keeps checks beyond their JSON form.
  const decodeNative = nativeSchema
    ? (value: unknown) => nativeSchema.make(value as never)
    : Schema.decodeUnknownSync(
        Schema.make<Schema.Codec<unknown>>(
          SchemaRepresentation.fromJsonSchemaDocument(
            JsonSchema.fromSchemaDraft2020_12(source),
            { patterns: 'apply' },
          ).ast,
        ),
      );
  return {
    '~standard': {
      version: 1,
      vendor: 'oh-my-opencode-slim',
      validate(value: unknown) {
        const queue = taskDependencyFieldsSchema.safeParse(value);
        if (!queue.success) return { issues: queue.error.issues };
        if (!isRecord(value))
          return { issues: [{ message: 'Expected subagent arguments' }] };
        const { id: _id, depends_on: _dependsOn, ...native } = value;
        try {
          const decoded = decodeNative(native);
          if (isRecord(decoded))
            return { value: { ...decoded, ...queue.data } };
          return {
            issues: [{ message: 'Expected native subagent arguments' }],
          };
        } catch (error) {
          return {
            issues: [
              {
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

const terminalStates = {
  'session.execution.succeeded': 'completed',
  'session.execution.failed': 'error',
  'session.execution.interrupted': 'cancelled',
} as const;

function appendAdmissionIdentity(
  result: unknown,
  ticket: BackgroundTaskConcurrencyTicket,
): unknown {
  if (!isRecord(result)) return result;
  const { id, logicalID } = ticket.snapshot();
  const suffix = `\nid: ${logicalID}\nadmission_id: ${id}`;
  const content = result.content;
  return {
    ...result,
    content:
      typeof content === 'string'
        ? content + suffix
        : [
            ...(Array.isArray(content) ? content : []),
            { type: 'text', text: suffix },
          ],
    metadata: {
      ...(result.metadata as object),
      id: logicalID,
      admission_id: id,
    },
  };
}

function createRuntime(
  directory: string,
  config: BackgroundTaskConcurrencyConfig,
) {
  let mirror: QueueMirrorPublisher | undefined;
  const scheduler = new BackgroundTaskConcurrency(config, {
    onQueueChange: () => mirror?.notify(),
  });
  const localBindings = new Set<Binding>();
  const runtimeID = randomUUID();
  let configAtAcquisition = config;
  let owners = 0;
  let mirrorOwners = 0;
  let teardown: ReturnType<typeof setTimeout> | undefined;
  let startupCensus: Promise<void> | undefined;
  let censusEvents: Map<string, number> | undefined;

  function registerChild(binding: Binding, childID: string): void {
    const child = bindings.get(childID) ?? {
      calls: new Set<Binding>(),
      lastSeq: -1,
      observe: observeEvent,
    };
    binding.childID = childID;
    child.calls.add(binding);
    localBindings.add(binding);
    bindings.set(childID, child);
  }

  function seedRecovered(
    session: WrapOptions['session'],
  ): Promise<void> | undefined {
    if (startupCensus || !session) return startupCensus;
    const config = scheduler.configSnapshot();
    if (
      ![
        config.defaultConcurrency,
        ...Object.values(config.providerConcurrency),
        ...Object.values(config.modelConcurrency),
      ].some((limit) => limit > 0)
    )
      return;
    const list = session.list;
    if (!list)
      throw new Error(
        'OpenCode session.list is required to verify configured admission limits',
      );
    const terminals = new Map<string, number>();
    censusEvents = terminals;
    startupCensus = (async () => {
      const candidates: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const result = await withTimeout(
          list.call(session, {
            directory,
            order: 'desc',
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
          1_000,
          'Native child occupancy lookup timed out',
        );
        if (scheduler.isDisposed()) return;
        if (
          !isRecord(result) ||
          !Array.isArray(result.data) ||
          result.data.length > 100 ||
          !isRecord(result.cursor)
        ) {
          throw new Error(
            'OpenCode returned an invalid native child occupancy page',
          );
        }
        for (const item of result.data) {
          if (
            isRecord(item) &&
            item.fork === undefined &&
            typeof item.id === 'string' &&
            SESSION_ID_PATTERN.test(item.id) &&
            typeof item.parentID === 'string' &&
            SESSION_ID_PATTERN.test(item.parentID) &&
            hostRunningSince(item) !== undefined
          )
            candidates.push(item);
        }
        const next = result.cursor.next;
        if (
          next !== undefined &&
          (typeof next !== 'string' || !next || seen.has(next))
        ) {
          throw new Error(
            'OpenCode returned an invalid native child occupancy cursor',
          );
        }
        if (next === undefined || result.data.length < 100) break;
        if (page === 4)
          throw new Error(
            'Could not verify configured admission limits within 500 native sessions',
          );
        seen.add(next);
        cursor = next;
      }
      for (const item of candidates) {
        const childID = item.id as string;
        const parentID = item.parentID as string;
        const busyAt = hostRunningSince(item);
        if (
          busyAt === undefined ||
          bindings.has(childID) ||
          (terminals.get(childID) ?? -1) >= busyAt
        )
          continue;
        const model =
          isRecord(item.model) &&
          typeof item.model.providerID === 'string' &&
          typeof item.model.id === 'string'
            ? `${item.model.providerID}/${item.model.id}`
            : undefined;
        const ticket = scheduler.restoreTask(childID, model, parentID, {
          occupancyOnly: true,
        });
        if (!ticket) continue;
        const binding: Binding = {
          ticket,
          directory,
          scheduler,
          newChild: false,
          acceptingPrompt: false,
          stopForwardingAbort: () => {},
          removeLocalBinding: () => localBindings.delete(binding),
          recoveredBusyAt: busyAt,
        };
        registerChild(binding, childID);
      }
    })()
      .finally(() => {
        censusEvents = undefined;
      })
      .catch((error: unknown) => {
        startupCensus = undefined;
        throw error;
      });
    return startupCensus;
  }

  function remove(binding: Binding) {
    binding.removeLocalBinding();
    if (!binding.childID) return;
    const child = bindings.get(binding.childID);
    if (!child) return;
    child.calls.delete(binding);
    if (!child.calls.size) bindings.delete(binding.childID);
  }

  function finish(binding: Binding, state: BackgroundTaskTerminalState) {
    if (binding.finished) return;
    binding.finished = true;
    remove(binding);
    binding.ticket.settle(state);
  }

  function reconcileUnidentifiedPrompt(binding: Binding): void {
    const { childID, unidentifiedTerminal: observed, session } = binding;
    if (
      !binding.accepted ||
      binding.inboxID !== undefined ||
      binding.reconcilingIdle ||
      !childID ||
      !observed ||
      !session?.wait ||
      !session.get
    )
      return;
    const { wait, get } = session;
    binding.reconcilingIdle = true;
    void (async () => {
      await withTimeout(
        wait.call(session, { sessionID: childID }),
        1_000,
        'Native child idle wait timed out',
      );
      const latest = await withTimeout(
        get.call(session, { sessionID: childID }),
        1_000,
        'Native child state read timed out',
      );
      const newerStart = bindings.get(childID)?.startedSeq;
      if (
        !isRecord(latest) ||
        latest.id !== childID ||
        (newerStart !== undefined && newerStart > observed.seq) ||
        hostRunningSince(latest) !== undefined
      )
        return;
      const round = hostRoundStateOf(latest);
      if (
        round.kind === 'terminal' &&
        (observed.created === undefined || round.idleAt >= observed.created)
      ) {
        // Release a verified idle reservation without claiming this prompt ran.
        finish(binding, 'error');
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        binding.reconcilingIdle = false;
        if (binding.unidentifiedTerminal !== observed && !binding.finished)
          reconcileUnidentifiedPrompt(binding);
      });
  }

  function settleAfterRecovery(
    binding: Binding,
    state: BackgroundTaskTerminalState,
    recovery: Promise<string | undefined> | undefined,
  ): void {
    if (!recovery && !binding.settlement) {
      finish(binding, state);
      return;
    }
    // A second subscriber can observe the next period while the first is
    // checking recovery. Process candidate verdicts in durable arrival order.
    const settlement = (binding.settlement ?? Promise.resolve()).then(
      async () => {
        if (binding.finished) return;
        const model = await recovery?.catch(() => undefined);
        if (!model) finish(binding, state);
      },
    );
    binding.settlement = settlement;
    void settlement.then(() => {
      if (binding.settlement === settlement) binding.settlement = undefined;
    });
  }

  function capturePrompt(event: unknown): void {
    const binding = promptAdmission.getStore();
    if (
      !binding?.acceptingPrompt ||
      binding.inboxID !== undefined ||
      !isRecord(event) ||
      typeof event.messageID !== 'string' ||
      binding.childID !== event.sessionID
    )
      return;
    binding.inboxID = event.messageID;
    binding.directory = directory;
    // The native executor admits the prompt and then registers its Job. Do
    // not interrupt between those operations from a parent tool-stop.
    binding.stopForwardingAbort();
  }

  function observeEvent(event: Record<string, unknown>): boolean {
    const { data, durable, type } = event;
    if (
      !isRecord(data) ||
      typeof data.sessionID !== 'string' ||
      typeof type !== 'string'
    )
      return false;
    const sessionID = data.sessionID;
    const child = bindings.get(sessionID);
    if (
      censusEvents &&
      (type === 'session.deleted' || Object.hasOwn(terminalStates, type)) &&
      data.reason !== 'shutdown' &&
      typeof event.created === 'number'
    ) {
      censusEvents.set(
        sessionID,
        Math.max(censusEvents.get(sessionID) ?? -1, event.created),
      );
      if (censusEvents.size > 512) {
        const oldest = censusEvents.keys().next().value;
        if (oldest !== undefined) censusEvents.delete(oldest);
      }
    }
    if (type === 'session.deleted') {
      if (child)
        for (const binding of child.calls) finish(binding, 'cancelled');
      if (scheduler.hasParentSessionID(sessionID)) {
        scheduler.clearQueued(sessionID);
        scheduler.resumeAdmissions(sessionID);
      }
      return false;
    }
    // OpenCode's one durable sequence per child orders the inbox and busy
    // period events, including overlapping subscribers during plugin reload.
    if (
      !child ||
      !isRecord(durable) ||
      durable.aggregateID !== sessionID ||
      typeof durable.seq !== 'number' ||
      !Number.isSafeInteger(durable.seq)
    )
      return false;
    const ownsFailure = type === 'session.execution.failed';
    if (durable.seq <= child.lastSeq) return ownsFailure;
    child.lastSeq = durable.seq;
    if (
      type === 'session.moved' &&
      isRecord(data.location) &&
      typeof data.location.directory === 'string'
    ) {
      for (const binding of child.calls)
        binding.directory = data.location.directory;
      return false;
    }
    if (
      type === 'session.model.selected' &&
      isRecord(data.model) &&
      typeof data.model.providerID === 'string' &&
      typeof data.model.id === 'string'
    ) {
      for (const owner of new Set(
        [...child.calls].map((binding) => binding.scheduler),
      )) {
        owner.migrateTask(
          sessionID,
          `${data.model.providerID}/${data.model.id}`,
        );
      }
      return false;
    }
    if (type === 'session.execution.started') {
      child.startedSeq = durable.seq;
      return false;
    }
    if (
      type === 'session.inbox.enqueued' ||
      type === 'session.inbox.delivered' ||
      type === 'session.inbox.cancelled'
    ) {
      for (const binding of child.calls) {
        if (binding.inboxID === undefined || binding.inboxID !== data.inboxID)
          continue;
        if (type === 'session.inbox.enqueued') binding.enqueueSeq = durable.seq;
        else if (type === 'session.inbox.delivered') binding.delivered = true;
        else finish(binding, 'cancelled');
      }
      return false;
    }
    if (!Object.hasOwn(terminalStates, type)) return false;
    const start = child.startedSeq;
    child.startedSeq = undefined;
    // A shutdown preserves the host execution claim and job recovery.
    if (type === 'session.execution.interrupted' && data.reason === 'shutdown')
      return false;
    const state = terminalStates[type as keyof typeof terminalStates];
    const owner = child.calls.values().next().value?.directory ?? directory;
    const resolver = ownsFailure
      ? nativeAdmissionRecoveryFor(event, owner)
      : undefined;
    const recovery =
      state === 'error' &&
      resolver &&
      isRecord(data.error) &&
      typeof data.error.message === 'string'
        ? resolver(event, sessionID, data.error.message)
        : undefined;
    for (const binding of child.calls) {
      // A follow-up can be enqueued while the preceding period is settling.
      // It belongs to that period only if the host actually promoted it.
      // A fresh child's first execution is started by this native submission;
      // a failure there may occur before its first inbox promotion.
      const freshPreDeliveryFailure =
        state !== 'completed' &&
        binding.newChild &&
        start !== undefined &&
        binding.enqueueSeq !== undefined &&
        start > binding.enqueueSeq;
      const recoveredVerdict =
        binding.recoveredBusyAt !== undefined &&
        (start !== undefined ||
          (typeof event.created === 'number' &&
            event.created >= binding.recoveredBusyAt));
      if (binding.delivered || freshPreDeliveryFailure || recoveredVerdict) {
        settleAfterRecovery(binding, state, recovery);
      } else if (
        binding.inboxID === undefined &&
        binding.recoveredBusyAt === undefined
      ) {
        binding.unidentifiedTerminal = {
          seq: durable.seq,
          created:
            typeof event.created === 'number' ? event.created : undefined,
        };
        reconcileUnidentifiedPrompt(binding);
      }
    }
    return ownsFailure && resolver !== undefined;
  }

  function wrap(
    execute: Execute,
    leaseSignal: AbortSignal,
    options: WrapOptions = {},
  ): Execute {
    return async (input, rawContext) => {
      const context = rawContext as NativeToolContext;
      if (
        !isRecord(input) ||
        options.shouldManageSession?.(context.sessionID) === false
      )
        return execute(input, rawContext);
      const { id, depends_on, ...native } = input;
      const { depends_on: dependsOn } = taskDependencyFieldsSchema.parse({
        id,
        depends_on,
      });
      const resumeID =
        typeof native.sessionID === 'string' ? native.sessionID : undefined;
      const plainFollowup =
        resumeID && id === undefined && dependsOn === undefined;
      // A plain follow-up to a tracked active child steers its existing run.
      if (plainFollowup && bindings.has(resumeID))
        return execute(native, rawContext);
      const waitSignal = context.signal
        ? AbortSignal.any([context.signal, leaseSignal])
        : leaseSignal;
      waitSignal.throwIfAborted();
      const census = seedRecovered(options.session);
      if (census) await waitForAdmission(census, waitSignal);
      if (plainFollowup && bindings.has(resumeID))
        return execute(native, rawContext);
      const selectedModel = (
        typeof native.model === 'string' && native.model !== ''
          ? native.model
          : await options.resolveModel?.(native, context.sessionID)
      )?.split('#', 1)[0];
      waitSignal.throwIfAborted();
      const ticket = scheduler.acquire({
        id: typeof id === 'string' ? id : undefined,
        dependsOn,
        model: selectedModel,
        parentSessionID: context.sessionID,
        previousSessionID: resumeID,
        retainRecord: true,
        shareCapacity: scheduler.holdsReservation(context.sessionID),
      });
      const launch = new AbortController();
      const forwardAbort = () => launch.abort(waitSignal.reason);
      const binding: Binding = {
        ticket,
        directory,
        scheduler,
        session: options.session,
        removeLocalBinding: () => localBindings.delete(binding),
        newChild: !resumeID,
        acceptingPrompt: true,
        stopForwardingAbort: () =>
          waitSignal.removeEventListener('abort', forwardAbort),
      };
      try {
        await waitForAdmission(ticket.ready, waitSignal);
        waitSignal.throwIfAborted();
        waitSignal.addEventListener('abort', forwardAbort, { once: true });
        const result = await promptAdmission.run(binding, () =>
          execute(native, {
            ...context,
            signal: launch.signal,
            async progress(update: Record<string, unknown>) {
              if (typeof update.sessionID === 'string' && !binding.childID) {
                registerChild(binding, update.sessionID);
                ticket.bind(update.sessionID, { share: true });
              }
              await context.progress(update);
            },
          }),
        );
        if (!binding.childID) {
          finish(binding, 'error');
          return result;
        }
        if (!binding.inboxID && !binding.finished) {
          ticket.noteObservationError(
            'OpenCode accepted the child, but its exact prompt was not observed',
          );
          binding.accepted = true;
          reconcileUnidentifiedPrompt(binding);
        }
        return appendAdmissionIdentity(result, ticket);
      } catch (error) {
        if (binding.enqueueSeq === undefined && !binding.delivered)
          finish(
            binding,
            launch.signal.aborted ||
              (binding.childID === undefined && waitSignal.aborted)
              ? 'cancelled'
              : 'error',
          );
        throw error;
      } finally {
        binding.acceptingPrompt = false;
        binding.stopForwardingAbort();
        ticket.releaseIfUnbound();
      }
    };
  }

  function enableMirror() {
    mirror ??= createQueueMirrorPublisher({
      projectDirectory: directory,
      publisherID: `process-${process.pid}`,
      runtimeID,
      source: scheduler,
    });
    mirror.notify();
    mirrorOwners += 1;
  }

  return {
    scheduler,
    capturePrompt,
    observeEvent,
    acquire(
      nextConfig: BackgroundTaskConcurrencyConfig,
      showMirror: boolean,
      recover?: NativeAdmissionRecovery,
    ) {
      if (teardown !== undefined) {
        clearTimeout(teardown);
        teardown = undefined;
      }
      owners += 1;
      if (showMirror) enableMirror();
      const controller = new AbortController();
      const unregisterRecovery = recover
        ? registerNativeAdmissionRecovery(directory, recover)
        : undefined;
      // Preserve runtime limit changes across an unchanged plugin reload.
      if (JSON.stringify(nextConfig) !== JSON.stringify(configAtAcquisition)) {
        configAtAcquisition = nextConfig;
        scheduler.updateConfig(nextConfig);
      }
      let released = false;
      return {
        scheduler,
        ownsSession: (id: string) =>
          scheduler.hasParentSessionID(id) ||
          [...(bindings.get(id)?.calls ?? [])].some(
            (binding) => binding.scheduler === scheduler,
          ),
        capturePrompt,
        wrap: (execute: Execute, options?: WrapOptions) =>
          wrap(execute, controller.signal, options),
        observeEvent,
        queueMirrorPublisher: mirror,
        async release() {
          if (released) return;
          released = true;
          controller.abort();
          unregisterRecovery?.();
          if (showMirror) mirrorOwners -= 1;
          owners -= 1;
          if (mirrorOwners === 0 && owners > 0) {
            mirror?.dispose();
            mirror = undefined;
          }
          if (owners === 0) {
            teardown = setTimeout(() => {
              mirror?.dispose();
              scheduler.dispose();
              for (const binding of localBindings) remove(binding);
              runtimes.delete(directory);
            }, 0);
            teardown.unref?.();
          }
        },
      };
    },
  };
}

const runtimes = new Map<string, ReturnType<typeof createRuntime>>();

export function acquireNativeAdmissionRuntime(
  directory: string,
  config: Partial<BackgroundTaskConcurrencyConfig> = {},
  options: { mirror?: boolean; recover?: NativeAdmissionRecovery } = {},
) {
  const limits = { ...unlimited, ...config };
  let runtime = runtimes.get(directory);
  if (!runtime) {
    runtime = createRuntime(directory, limits);
    runtimes.set(directory, runtime);
  }
  return runtime.acquire(limits, options.mirror === true, options.recover);
}
