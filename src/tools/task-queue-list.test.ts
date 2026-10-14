import { describe, expect, mock, test } from 'bun:test';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { executeTaskQueueList } from './task-queue-list';

const CONFIG = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('task_queue_list', () => {
  test('rejects non-orchestrator sessions', async () => {
    // Given: a queue reader whose session is managed but not an orchestrator.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);

    // When/Then: authorization rejects the read before inspecting state.
    await expect(
      executeTaskQueueList(
        {
          scheduler,
          shouldManageSession: () => true,
          readRuntimeStatuses: async () => ({
            statuses: new Map(),
            malformedSessionIDs: new Set(),
          }),
        },
        {},
        { sessionID: 'parent-1', agent: 'fixer' },
      ),
    ).rejects.toThrow('task_queue_list can only be used by orchestrator');
  });

  test('rejects sessions not classified as orchestrator sessions', async () => {
    // Given: an orchestrator-labelled call whose session is not managed.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);

    // When/Then: session metadata authorization rejects the read.
    await expect(
      executeTaskQueueList(
        {
          scheduler,
          shouldManageSession: () => false,
          readRuntimeStatuses: async () => ({
            statuses: new Map(),
            malformedSessionIDs: new Set(),
          }),
        },
        {},
        { sessionID: 'parent-1', agent: 'orchestrator' },
      ),
    ).rejects.toThrow(
      'task_queue_list can only be used in orchestrator sessions',
    );
  });

  test('filters parent-owned records and includes session and live status data', async () => {
    // Given: one assigned admission, one postponed admission, and another parent.
    const scheduler = new BackgroundTaskConcurrency(CONFIG, { now: () => 100 });
    const assigned = scheduler.acquire({
      model: 'openai/gpt-5.6-sol',
      parentSessionID: 'parent-1',
      previousSessionID: 'child-previous',
    });
    await assigned.ready;
    assigned.bind('child-current');
    const postponed = scheduler.acquire({
      model: 'openai/gpt-5.6-sol',
      parentSessionID: 'parent-1',
    });
    scheduler.manageAdmission(postponed.id, 'parent-1', 'postpone');
    scheduler.acquire({
      model: 'anthropic/claude-fable-5',
      parentSessionID: 'parent-2',
    });
    const readRuntimeStatuses = mock(async () => ({
      statuses: new Map([['child-current', 'busy' as const]]),
      malformedSessionIDs: new Set<string>(),
    }));

    // When: the caller filters its records to one running model/provider.
    const output = await executeTaskQueueList(
      {
        scheduler,
        shouldManageSession: () => true,
        readRuntimeStatuses,
      },
      {
        admission_id: assigned.id,
        states: ['running'],
        model: 'openai/gpt-5.6-sol',
        provider: 'openai',
        offset: 0,
        limit: 10,
      },
      { sessionID: 'parent-1', agent: 'orchestrator' },
    );

    // Then: deterministic JSON contains required associations and timestamps.
    expect(JSON.parse(output)).toEqual({
      effect_scope: 'parent',
      parent_session_id: 'parent-1',
      admission_paused: false,
      pagination: {
        offset: 0,
        limit: 10,
        total: 1,
        returned: 1,
        truncated: false,
      },
      live_status_error: null,
      admissions: [
        {
          admission_task_id: assigned.id,
          admission_id: assigned.id,
          id: assigned.id,
          depends_on: [],
          dependency_error: null,
          lifecycle_state: 'running',
          model: 'openai/gpt-5.6-sol',
          provider: 'openai',
          parent_session_id: 'parent-1',
          assigned_session_id: 'child-current',
          previous_session_ids: ['child-previous'],
          previous_session_count: 1,
          previous_session_ids_truncated: false,
          queue_position: null,
          timestamps: {
            created_at: '1970-01-01T00:00:00.100Z',
            queued_at: '1970-01-01T00:00:00.100Z',
            postponed_at: null,
            started_at: '1970-01-01T00:00:00.100Z',
            assigned_at: '1970-01-01T00:00:00.100Z',
            updated_at: '1970-01-01T00:00:00.100Z',
            completed_at: null,
          },
          live_session_status: 'busy',
          waiting_on: [],
          waiting_on_count: 0,
          waiting_on_truncated: false,
        },
      ],
    });
    expect(readRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  test('paginates deterministically and bounds previous session history', async () => {
    // Given: an admission with more session history than one response may emit.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const ticket = scheduler.acquire({
      parentSessionID: 'parent-1',
      previousSessionID: 'child-previous',
    });
    await ticket.ready;
    for (let index = 0; index < 25; index += 1) {
      ticket.bind(`child-${index}`);
    }
    const readRuntimeStatuses = mock(async () => ({
      statuses: new Map(),
      malformedSessionIDs: new Set<string>(),
    }));

    // When: the caller requests the first bounded page.
    const output = await executeTaskQueueList(
      {
        scheduler,
        shouldManageSession: () => true,
        readRuntimeStatuses,
      },
      { limit: 1 },
      { sessionID: 'parent-1', agent: 'orchestrator' },
    );
    const parsed = JSON.parse(output);

    // Then: record and history bounds are explicit and deterministic.
    expect(parsed.pagination).toEqual({
      offset: 0,
      limit: 1,
      total: 1,
      returned: 1,
      truncated: false,
    });
    expect(parsed.admissions[0].previous_session_count).toBe(25);
    expect(parsed.admissions[0].previous_session_ids).toHaveLength(20);
    expect(parsed.admissions[0].previous_session_ids_truncated).toBe(true);
    expect(readRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  test('does not read host status when the returned page has no child session', async () => {
    // Given: one postponed admission without an assigned child session.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    const postponed = scheduler.acquire({ parentSessionID: 'parent-1' });
    scheduler.manageAdmission(postponed.id, 'parent-1', 'postpone');
    const readRuntimeStatuses = mock(async () => ({
      statuses: new Map(),
      malformedSessionIDs: new Set<string>(),
    }));

    // When: the parent lists its postponed admission.
    const output = await executeTaskQueueList(
      {
        scheduler,
        shouldManageSession: () => true,
        readRuntimeStatuses,
      },
      {},
      { sessionID: 'parent-1', agent: 'orchestrator' },
    );

    // Then: no unnecessary host call occurs and queue position is absent.
    expect(JSON.parse(output).admissions[0]).toMatchObject({
      admission_task_id: postponed.id,
      lifecycle_state: 'postponed',
      queue_position: null,
      live_session_status: null,
    });
    expect(readRuntimeStatuses).not.toHaveBeenCalled();
  });

  test('includes bounded waiting_on diagnostics for direct unresolved prerequisites', async () => {
    const scheduler = new BackgroundTaskConcurrency(CONFIG, { now: () => 100 });
    const prereq = scheduler.acquire({ parentSessionID: 'parent-1' });
    await prereq.ready;
    const child = scheduler.acquire({ parentSessionID: 'parent-1' });
    scheduler.setDependencies(child.id, 'parent-1', [prereq.id]);

    const readRuntimeStatuses = mock(async () => ({
      statuses: new Map(),
      malformedSessionIDs: new Set<string>(),
    }));

    const output = await executeTaskQueueList(
      {
        scheduler,
        shouldManageSession: () => true,
        readRuntimeStatuses,
      },
      { admission_id: child.id },
      { sessionID: 'parent-1', agent: 'orchestrator' },
    );
    const parsed = JSON.parse(output);
    const adm = parsed.admissions[0];
    expect(adm.waiting_on_count).toBe(1);
    expect(adm.waiting_on_truncated).toBe(false);
    expect(adm.waiting_on).toHaveLength(1);
    expect(adm.waiting_on[0]).toMatchObject({
      admission_id: prereq.id,
      id: prereq.id,
      lifecycle_state: 'starting',
    });
  });

  test('omits completed prerequisites and handles >8 unresolved with correct truncation', async () => {
    const highConfig = {
      defaultConcurrency: 10,
      providerConcurrency: {},
      modelConcurrency: {},
    };
    const scheduler = new BackgroundTaskConcurrency(highConfig, {
      now: () => 100,
    });
    const prereqs: string[] = [];
    const tickets: {
      id: string;
      ready: Promise<void>;
      bind: (s: string) => void;
    }[] = [];
    for (let i = 0; i < 10; i++) {
      const t = scheduler.acquire({ parentSessionID: 'parent-1' });
      tickets.push(t);
      prereqs.push(t.id);
    }
    await Promise.all(tickets.map((t) => t.ready));
    const child = scheduler.acquire({ parentSessionID: 'parent-1' });
    scheduler.setDependencies(child.id, 'parent-1', prereqs);
    tickets[0].bind('child-done');
    scheduler.releaseTask('child-done', 'completed');

    const readRuntimeStatuses = mock(async () => ({
      statuses: new Map(),
      malformedSessionIDs: new Set<string>(),
    }));
    const output = await executeTaskQueueList(
      { scheduler, shouldManageSession: () => true, readRuntimeStatuses },
      { admission_id: child.id },
      { sessionID: 'parent-1', agent: 'orchestrator' },
    );
    const adm = JSON.parse(output).admissions[0];
    expect(adm.waiting_on_count).toBe(9);
    expect(adm.waiting_on_truncated).toBe(true);
    expect(adm.waiting_on).toHaveLength(8);
    expect(
      adm.waiting_on.some(
        (w: { admission_id: string }) => w.admission_id === prereqs[0],
      ),
    ).toBe(false);
    expect(adm.waiting_on[0].admission_id).toBe(prereqs[1]);
  });
});
