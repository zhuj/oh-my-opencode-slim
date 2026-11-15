import { describe, expect, test } from 'bun:test';
import {
  BackgroundTaskConcurrency,
  BackgroundTaskConcurrencyQueueCancelledError,
  BackgroundTaskTransitionError,
} from '../utils/background-task-concurrency';
import { executeTaskQueueManage } from './task-queue-manage';

const CONFIG = {
  defaultConcurrency: 1,
  providerConcurrency: { anthropic: 3 },
  modelConcurrency: { 'openai/special': 2 },
};

const MANAGED_CONTEXT = {
  sessionID: 'parent-1',
  agent: 'custom-primary',
} as const;

describe('task_queue_manage', () => {
  test('rejects unauthorized sessions before mutation', async () => {
    // Given: a queued admission and an unadmitted caller.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    const queued = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When/Then: authorization fails and the task remains queued.
    await expect(
      executeTaskQueueManage(
        { scheduler, shouldManageSession: () => false },
        { action: 'cancel', admission_id: queued.id },
        { sessionID: 'parent-1', agent: 'fixer' },
      ),
    ).rejects.toThrow('task_queue_manage can only be used in managed sessions');
    expect(queued.snapshot().state).toBe('queued');
  });

  test('postpones resumes and cancels one owned queued admission', async () => {
    // Given: one active task holding capacity and one owned queued admission.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    const queued = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When: the owner postpones and resumes the admission.
    await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'postpone', admission_id: queued.id },
      MANAGED_CONTEXT,
    );
    expect(queued.snapshot().state).toBe('postponed');
    await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'resume', admission_id: queued.id },
      MANAGED_CONTEXT,
    );
    expect(queued.snapshot().state).toBe('queued');

    // When: the owner queue-cancels the admission.
    const output = await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'cancel', admission_id: queued.id },
      MANAGED_CONTEXT,
    );

    // Then: only queue state changes; the active admission remains untouched.
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(JSON.parse(output)).toMatchObject({
      action: 'cancel',
      effect_scope: 'parent',
      parent_session_id: 'parent-1',
      admission_task_id: queued.id,
      lifecycle_state: 'cancelled',
    });
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('rejects unowned and active admissions without interruption', async () => {
    // Given: one starting admission owned by another parent.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-2' });
    await active.ready;

    // When/Then: the caller cannot queue-cancel another parent's admission.
    await expect(
      executeTaskQueueManage(
        { scheduler, shouldManageSession: () => true },
        { action: 'cancel', admission_id: active.id },
        MANAGED_CONTEXT,
      ),
    ).rejects.toThrow('Unknown or unowned background task admission');

    // Given: the same active lifecycle state owned by the caller.
    const ownedScheduler = new BackgroundTaskConcurrency(CONFIG);
    const owned = ownedScheduler.acquire({ parentSessionID: 'parent-1' });
    await owned.ready;

    // When/Then: starting and running states reject without releasing capacity.
    await expect(
      executeTaskQueueManage(
        { scheduler: ownedScheduler, shouldManageSession: () => true },
        { action: 'cancel', admission_id: owned.id },
        MANAGED_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(BackgroundTaskTransitionError);
    owned.bind('child-owned');
    await expect(
      executeTaskQueueManage(
        { scheduler: ownedScheduler, shouldManageSession: () => true },
        { action: 'postpone', admission_id: owned.id },
        MANAGED_CONTEXT,
      ),
    ).rejects.toBeInstanceOf(BackgroundTaskTransitionError);
    expect(ownedScheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('clears only the callers queued and postponed admissions', async () => {
    // Given: waiting admissions owned by the caller and another parent.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    const queued = scheduler.acquire({ parentSessionID: 'parent-1' });
    const postponed = scheduler.acquire({ parentSessionID: 'parent-1' });
    const other = scheduler.acquire({ parentSessionID: 'parent-2' });
    scheduler.manageAdmission(postponed.id, 'parent-1', 'postpone');

    // When: the caller clears its queue.
    const output = await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'clear' },
      MANAGED_CONTEXT,
    );

    // Then: the result reports only caller-owned cancellations.
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    await expect(postponed.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(JSON.parse(output)).toMatchObject({
      action: 'clear',
      effect_scope: 'parent',
      parent_session_id: 'parent-1',
      affected_admission_ids: [queued.id, postponed.id],
      affected_count: 2,
    });
    expect(other.snapshot().state).toBe('queued');
  });

  test('pauses and resumes only the callers admissions', async () => {
    // Given: queued work from the caller and another parent.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    active.bind('child-active');
    const callerTask = scheduler.acquire({ parentSessionID: 'parent-1' });
    const otherTask = scheduler.acquire({ parentSessionID: 'parent-2' });

    // When: the caller pauses admission and capacity becomes available.
    const pausedOutput = await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'pause_admission' },
      MANAGED_CONTEXT,
    );
    scheduler.releaseTask('child-active', 'completed');
    await otherTask.ready;

    // Then: other work runs while caller-owned work stays queued.
    expect(JSON.parse(pausedOutput)).toMatchObject({
      action: 'pause_admission',
      effect_scope: 'parent',
      admission_paused: true,
    });
    expect(callerTask.snapshot().state).toBe('queued');

    // When: capacity is freed and the caller resumes admission.
    otherTask.bind('child-other');
    scheduler.releaseTask('child-other', 'completed');
    const resumedOutput = await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      { action: 'resume_admission' },
      MANAGED_CONTEXT,
    );
    await callerTask.ready;

    // Then: the parent-scoped control reports its effective state.
    expect(JSON.parse(resumedOutput)).toMatchObject({
      action: 'resume_admission',
      effect_scope: 'parent',
      admission_paused: false,
    });
  });

  test('requires global confirmation before changing a directory limit', async () => {
    // Given: one active admission, one waiter, and the original config.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-1' });
    await active.ready;
    const queued = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When/Then: missing confirmation rejects without mutating the scheduler.
    await expect(
      executeTaskQueueManage(
        { scheduler, shouldManageSession: () => true },
        { action: 'set_limit', tier: 'default', limit: 2 },
        MANAGED_CONTEXT,
      ),
    ).rejects.toThrow('set_limit requires confirm_global: true');
    expect(scheduler.configSnapshot()).toEqual(CONFIG);
    expect(queued.snapshot().state).toBe('queued');

    // When: the caller explicitly confirms the directory-global update.
    const output = await executeTaskQueueManage(
      { scheduler, shouldManageSession: () => true },
      {
        action: 'set_limit',
        tier: 'default',
        limit: 2,
        confirm_global: true,
      },
      MANAGED_CONTEXT,
    );
    await queued.ready;

    // Then: success reports directory scope and the complete effective limits.
    expect(JSON.parse(output)).toEqual({
      action: 'set_limit',
      effect_scope: 'directory',
      limits: {
        default_concurrency: 2,
        provider_concurrency: { anthropic: 3 },
        model_concurrency: { 'openai/special': 2 },
      },
    });
  });
});
