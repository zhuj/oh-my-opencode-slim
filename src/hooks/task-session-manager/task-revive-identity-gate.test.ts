import { describe, expect, mock, test } from 'bun:test';
import { verifyReviveIdentity } from '../../tools/task-revive';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createRevivedRunTracker } from './revived-run-tracker';

describe('task_revive identity gate production', () => {
  test('forged board agent + verified host agent conflict => refusal', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 't-forged',
      parentSessionID: 'parent-1',
      agent: 'forged-agent',
      description: 'd',
      objective: 'o',
      background: true,
      now: Date.now(),
    });
    const result = await verifyReviveIdentity(
      {
        input: {
          directory: '/t',
          client: {
            session: {
              get: mock(async ({ path }: { path: { id: string } }) => ({
                data: {
                  id: path.id,
                  parentID: 'parent-1',
                  agent: 'verified-host-agent',
                  time: { created: Date.now() },
                },
              })),
              status: mock(async () => ({
                data: { 't-forged': { type: 'idle' } },
              })),
              abort: mock(async () => ({})),
              promptAsync: mock(async () => ({})),
              messages: undefined,
            },
          },
        },
        backgroundJobBoard: board,
        revivedRunTracker: createRevivedRunTracker({
          input: { directory: '/t' },
        }),
        recoverRetainedSession: async () => ({
          kind: 'refused' as const,
          reason: 'no',
        }),
        registerIntent: () => {},
      },
      'parent-1',
      't-forged',
      board.get('t-forged')!.generation,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('agent evidence conflicts');
    }
  });

  test('missing host session id => refusal', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 't-id',
      parentSessionID: 'p',
      agent: 'a',
      description: 'd',
      objective: 'o',
      background: true,
      now: Date.now(),
    });
    const result = await verifyReviveIdentity(
      {
        input: {
          directory: '/t',
          client: {
            session: {
              get: mock(async () => ({
                data: {
                  parentID: 'p',
                  agent: 'a',
                  time: { created: Date.now() },
                },
              })),
              status: mock(async () => ({ data: {} })),
              abort: mock(async () => ({})),
              promptAsync: mock(async () => ({})),
              messages: undefined,
            },
          },
        },
        backgroundJobBoard: board,
        revivedRunTracker: createRevivedRunTracker({
          input: { directory: '/t' },
        }),
        recoverRetainedSession: async () => ({
          kind: 'refused' as const,
          reason: 'no',
        }),
        registerIntent: () => {},
      },
      'p',
      't-id',
      board.get('t-id')!.generation,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('missing or mismatch');
    }
  });
});
