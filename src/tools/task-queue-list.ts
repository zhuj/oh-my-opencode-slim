import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { BackgroundTaskConcurrencyController } from '../utils/background-task-concurrency';
import type { BackgroundTaskLifecycleState } from '../utils/background-task-state';
import {
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import {
  requireQueueOrchestrator,
  type TaskQueueAuthorizationOptions,
  type TaskQueueToolContext,
} from './task-queue-auth';

const z = tool.schema;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PREVIOUS_SESSION_IDS = 20;

const LIFECYCLE_STATES = [
  'queued',
  'postponed',
  'starting',
  'running',
  'completed',
  'error',
  'cancelled',
] as const;

export interface TaskQueueListOptions extends TaskQueueAuthorizationOptions {
  readonly scheduler: BackgroundTaskConcurrencyController;
  readonly readRuntimeStatuses: () => Promise<RuntimeSessionStatusSnapshot>;
}

export interface TaskQueueListArgs {
  readonly admission_id?: string;
  readonly states?: readonly BackgroundTaskLifecycleState[];
  readonly model?: string;
  readonly provider?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export async function executeTaskQueueList(
  options: TaskQueueListOptions,
  args: TaskQueueListArgs,
  context: TaskQueueToolContext | undefined,
): Promise<string> {
  const parentSessionID = requireQueueOrchestrator(
    options,
    context,
    'task_queue_list',
  );
  const stateFilter = args.states ? new Set(args.states) : undefined;
  const admissionID = args.admission_id?.trim();
  const model = args.model?.trim();
  const provider = args.provider?.trim();
  const filtered = options.scheduler
    .listQueue(parentSessionID)
    .filter(
      ({ record }) =>
        (!admissionID || record.id === admissionID) &&
        (!stateFilter || stateFilter.has(record.state)) &&
        (!model || record.model === model) &&
        (!provider || record.provider === provider),
    );
  const offset = Math.max(0, args.offset ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, args.limit ?? DEFAULT_LIMIT));
  const page = filtered.slice(offset, offset + limit);
  const hasAssignedSession = page.some(
    ({ record }) => record.assignedSessionID !== undefined,
  );
  const liveStatuses = hasAssignedSession
    ? await options.readRuntimeStatuses()
    : undefined;
  const parentRecords = new Map(
    options.scheduler.list(parentSessionID).map((r) => [r.id, r]),
  );
  const admissions = page.map(({ record, queuePosition }) => {
    const previousSessionIDs = record.previousSessionIDs.slice(
      0,
      MAX_PREVIOUS_SESSION_IDS,
    );
    const unresolvedProjection = (() => {
      const proj: Array<{
        id: string | null;
        admission_id: string;
        lifecycle_state: BackgroundTaskLifecycleState | 'unknown';
      }> = [];
      for (const dep of record.dependsOn) {
        const depRec = parentRecords.get(dep);
        const isSameParent =
          depRec !== undefined && depRec.parentSessionID === parentSessionID;
        const state = isSameParent ? depRec.state : undefined;
        if (state === 'completed') continue;
        proj.push({
          id: isSameParent ? (depRec.logicalID ?? null) : null,
          admission_id: dep,
          lifecycle_state: state ?? 'unknown',
        });
      }
      return proj;
    })();
    return {
      admission_task_id: record.id,
      id: record.logicalID,
      admission_id: record.id,
      depends_on: record.dependsOn,
      dependency_error: record.dependencyError ?? null,
      lifecycle_state: record.state,
      model: record.model ?? null,
      provider: record.provider ?? null,
      parent_session_id: record.parentSessionID ?? null,
      assigned_session_id: record.assignedSessionID ?? null,
      previous_session_ids: previousSessionIDs,
      previous_session_count: record.previousSessionIDs.length,
      previous_session_ids_truncated:
        previousSessionIDs.length < record.previousSessionIDs.length,
      queue_position: queuePosition ?? null,
      timestamps: {
        created_at: toISOString(record.createdAt),
        queued_at: toISOString(record.queuedAt),
        postponed_at: toISOString(record.postponedAt),
        started_at: toISOString(record.startedAt),
        assigned_at: toISOString(record.assignedAt),
        updated_at: toISOString(record.updatedAt),
        completed_at: toISOString(record.completedAt),
      },
      live_session_status:
        liveStatuses && record.assignedSessionID
          ? (runtimeSessionStatus(liveStatuses, record.assignedSessionID) ??
            null)
          : null,
      waiting_on: unresolvedProjection.slice(0, 8),
      waiting_on_count: unresolvedProjection.length,
      waiting_on_truncated: unresolvedProjection.length > 8,
    };
  });
  return JSON.stringify({
    effect_scope: 'parent',
    parent_session_id: parentSessionID,
    admission_paused: options.scheduler.isAdmissionPaused(parentSessionID),
    pagination: {
      offset,
      limit,
      total: filtered.length,
      returned: admissions.length,
      truncated: offset + admissions.length < filtered.length,
    },
    live_status_error: liveStatuses?.error ?? null,
    admissions,
  });
}

export function createTaskQueueListTool(
  options: TaskQueueListOptions,
): Record<'task_queue_list', ToolDefinition> {
  const task_queue_list = tool({
    description:
      'List parent-owned background task admissions with queue positions, lifecycle metadata, session associations, and bounded live status.',
    args: {
      admission_id: z.string().optional(),
      states: z.array(z.enum(LIFECYCLE_STATES)).optional(),
      model: z
        .string()
        .optional()
        .describe(
          'Exact normalized provider/model filter for queue admissions; inline variants are not part of the admission identity',
        ),
      provider: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    },
    execute: (args, context) => executeTaskQueueList(options, args, context),
  });
  return { task_queue_list };
}

function toISOString(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}
