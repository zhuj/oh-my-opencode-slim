import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type {
  BackgroundTaskConcurrencyController,
  BackgroundTaskConcurrencyLimitUpdate,
  BackgroundTaskQueueAction,
} from '../utils/background-task-concurrency';
import { MAX_TASK_DEPENDENCIES } from '../utils/background-task-limits';
import {
  requireQueueOrchestrator,
  type TaskQueueAuthorizationOptions,
  type TaskQueueToolContext,
  TaskQueueToolInputError,
} from './task-queue-auth';

const z = tool.schema;

import { executeDependencyAction } from './task-queue-dependencies';

const MANAGE_ACTIONS = [
  'postpone',
  'resume',
  'cancel',
  'clear',
  'pause_admission',
  'resume_admission',
  'set_limit',
  'set_dependencies',
  'add_dependency',
  'remove_dependency',
  'clear_dependencies',
] as const;

const LIMIT_TIERS = ['default', 'provider', 'model'] as const;

type TaskQueueManageAction = (typeof MANAGE_ACTIONS)[number];
type TaskQueueLimitTier = (typeof LIMIT_TIERS)[number];

export interface TaskQueueManageOptions extends TaskQueueAuthorizationOptions {
  readonly scheduler: BackgroundTaskConcurrencyController;
}

export interface TaskQueueManageArgs {
  readonly action: TaskQueueManageAction;
  readonly admission_id?: string;
  readonly depends_on?: readonly string[];
  readonly dependency_id?: string;
  readonly tier?: TaskQueueLimitTier;
  readonly key?: string;
  readonly limit?: number;
  readonly confirm_global?: boolean;
}

export async function executeTaskQueueManage(
  options: TaskQueueManageOptions,
  args: TaskQueueManageArgs,
  context: TaskQueueToolContext | undefined,
): Promise<string> {
  if ((args.depends_on?.length ?? 0) > MAX_TASK_DEPENDENCIES)
    throw new TaskQueueToolInputError(
      `At most ${MAX_TASK_DEPENDENCIES} dependencies are allowed`,
    );
  const parentSessionID = requireQueueOrchestrator(
    options,
    context,
    'task_queue_manage',
  );
  switch (args.action) {
    case 'set_dependencies':
    case 'add_dependency':
    case 'remove_dependency':
    case 'clear_dependencies':
      return executeDependencyAction(options.scheduler, parentSessionID, {
        ...args,
        action: args.action,
      });
    case 'postpone':
    case 'resume':
    case 'cancel':
      return executeAdmissionAction(
        options,
        args.admission_id,
        args.action,
        parentSessionID,
      );
    case 'clear': {
      const affectedAdmissionIDs =
        options.scheduler.clearQueued(parentSessionID);
      return JSON.stringify({
        action: args.action,
        effect_scope: 'parent',
        parent_session_id: parentSessionID,
        affected_admission_ids: affectedAdmissionIDs,
        affected_count: affectedAdmissionIDs.length,
      });
    }
    case 'pause_admission':
      options.scheduler.pauseAdmissions(parentSessionID);
      return admissionPauseOutput(options, args.action, parentSessionID);
    case 'resume_admission':
      options.scheduler.resumeAdmissions(parentSessionID);
      return admissionPauseOutput(options, args.action, parentSessionID);
    case 'set_limit': {
      if (args.confirm_global !== true) {
        throw new TaskQueueToolInputError(
          'set_limit requires confirm_global: true',
        );
      }
      const limits = options.scheduler.updateLimit(limitUpdateFromArgs(args));
      return JSON.stringify({
        action: args.action,
        effect_scope: 'directory',
        limits: {
          default_concurrency: limits.defaultConcurrency,
          provider_concurrency: sortedRecord(limits.providerConcurrency),
          model_concurrency: sortedRecord(limits.modelConcurrency),
        },
      });
    }
    default: {
      const exhaustiveAction: never = args.action;
      return exhaustiveAction;
    }
  }
}

export function createTaskQueueManageTool(
  options: TaskQueueManageOptions,
): Record<'task_queue_manage', ToolDefinition> {
  const task_queue_manage = tool({
    description:
      'Manage parent-owned queued admissions, parent-scoped admission pause, or explicitly confirmed directory-wide concurrency limits without aborting running tasks.',
    args: {
      action: z.enum(MANAGE_ACTIONS),
      admission_id: z.string().optional(),
      depends_on: z.array(z.string()).max(MAX_TASK_DEPENDENCIES).optional(),
      dependency_id: z.string().optional(),
      tier: z.enum(LIMIT_TIERS).optional(),
      key: z.string().optional(),
      limit: z.number().int().min(0).optional(),
      confirm_global: z.boolean().optional(),
    },
    execute: (args, context) => executeTaskQueueManage(options, args, context),
  });
  return { task_queue_manage };
}

function executeAdmissionAction(
  options: TaskQueueManageOptions,
  admissionIDInput: string | undefined,
  action: BackgroundTaskQueueAction,
  parentSessionID: string,
): string {
  const admissionID = admissionIDInput?.trim();
  if (!admissionID) {
    throw new TaskQueueToolInputError(`${action} requires admission_id`);
  }
  const record = options.scheduler.manageAdmission(
    admissionID,
    parentSessionID,
    action,
  );
  return JSON.stringify({
    action,
    effect_scope: 'parent',
    parent_session_id: parentSessionID,
    admission_task_id: record.id,
    lifecycle_state: record.state,
  });
}

function admissionPauseOutput(
  options: TaskQueueManageOptions,
  action: 'pause_admission' | 'resume_admission',
  parentSessionID: string,
): string {
  return JSON.stringify({
    action,
    effect_scope: 'parent',
    parent_session_id: parentSessionID,
    admission_paused: options.scheduler.isAdmissionPaused(parentSessionID),
  });
}

function limitUpdateFromArgs(
  args: TaskQueueManageArgs,
): BackgroundTaskConcurrencyLimitUpdate {
  if (args.tier === undefined || args.limit === undefined) {
    throw new TaskQueueToolInputError('set_limit requires tier and limit');
  }
  switch (args.tier) {
    case 'default':
      return { tier: args.tier, limit: args.limit };
    case 'provider':
    case 'model': {
      const key = args.key?.trim();
      if (!key) {
        throw new TaskQueueToolInputError(
          `set_limit for ${args.tier} requires key`,
        );
      }
      return { tier: args.tier, key, limit: args.limit };
    }
    default: {
      const exhaustiveTier: never = args.tier;
      return exhaustiveTier;
    }
  }
}

function sortedRecord(
  record: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
