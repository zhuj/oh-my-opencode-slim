import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createPendingCallTracker } from '../hooks/task-session-manager/pending-call-tracker';
import { handleToolExecuteBefore } from '../hooks/task-session-manager/tool-execute-hooks';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../utils';
import { createToolExecuteBridges } from './setup';

/** Source-backed boundary fixture, not a host runtime emulator.
 * v1: anomalyco/opencode packages/opencode/src/session/tools.ts, tool execute:
 * trigger(tool.execute.before, {tool,sessionID,callID}, {args}) then item.execute.
 * v2: src/v2/types.ts V2ToolBeforeEvent.input is unknown; setup.ts bridges it
 * before dispatch. This proves the adapter contract, NOT that every v2 host's
 * schema decoder preserves extensions (current core Tool.Context is different).
 * Native validation is deliberately strict so stripping cannot be accidental.
 */
function fixture(host: 'v1' | 'v2', available = true) {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const prerequisite = scheduler.acquire({
    id: 'first',
    parentSessionID: 'parent',
  });
  prerequisite.bind('ses_first');
  scheduler.releaseTask('ses_first', 'completed');
  const pendingCallTracker = createPendingCallTracker();
  const received: unknown[] = [];
  const dispatched: unknown[] = [];
  const before = async (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => {
    received.push(structuredClone(output.args));
    await handleToolExecuteBefore(input, output, {
      shouldManageSession: () => true,
      backgroundJobBoard: new BackgroundJobBoard(),
      ...(available ? { backgroundTaskConcurrency: scheduler } : {}),
      pendingCallTracker,
      taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    });
  };
  const bridge = createToolExecuteBridges(before, undefined);
  const dispatch = async (extensions: Record<string, unknown>) => {
    const args = {
      ...extensions,
      [host === 'v1' ? 'subagent_type' : 'agent']: 'fixer',
    };
    const output = { args };
    if (host === 'v1') {
      await before(
        { tool: 'task', sessionID: 'parent', callID: 'call' },
        output,
      );
      dispatched.push(
        z
          .strictObject({ subagent_type: z.string(), background: z.boolean() })
          .parse(output.args),
      );
    } else {
      const event = {
        tool: 'subagent',
        sessionID: 'parent',
        id: 'call',
        agent: 'orchestrator',
        input: args,
      };
      await bridge.beforeBridge(event);
      dispatched.push(
        z
          .strictObject({ agent: z.string(), background: z.boolean() })
          .parse(event.input),
      );
    }
  };
  return {
    scheduler,
    prerequisite,
    pendingCallTracker,
    received,
    dispatched,
    dispatch,
  };
}

for (const host of ['v1', 'v2'] as const) {
  test(`${host} preserves dependency fields until hooks and strips them before native validation`, async () => {
    // Given
    const f = fixture(host);
    // When
    await f.dispatch({
      id: 'logical',
      depends_on: ['first'],
      background: true,
    });
    // Then
    expect(f.received[0]).toMatchObject({
      id: 'logical',
      depends_on: ['first'],
    });
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).not.toHaveProperty('id');
    expect(f.dispatched[0]).not.toHaveProperty('depends_on');
    const logicalRecord = f.scheduler
      .list('parent')
      .find((record) => record.logicalID === 'logical');
    expect(logicalRecord).toMatchObject({
      logicalID: 'logical',
      dependsOn: [f.prerequisite.id],
    });
    expect(logicalRecord?.id).not.toBe(f.prerequisite.id);
    f.pendingCallTracker.clearAll();
    f.scheduler.dispose();
  });

  test.each([
    { id: null },
    { id: 'bad id' },
    { depends_on: 'first' },
    { depends_on: [1] },
    { depends_on: ['missing'] },
  ])(
    `${host} rejects invalid extensions %j before native dispatch`,
    async (extensions) => {
      // Given
      const f = fixture(host);
      // When / Then
      await expect(f.dispatch(extensions)).rejects.toThrow();
      expect(f.dispatched).toEqual([]);
      expect(f.pendingCallTracker.take('call')).toBeUndefined();
      expect(f.scheduler.list('parent')).toHaveLength(1);
      f.scheduler.dispose();
    },
  );

  test(`${host} rejects unsupported dependencies before native dispatch`, async () => {
    // Given
    const f = fixture(host, false);
    // When / Then
    await expect(f.dispatch({ id: 'logical', depends_on: [] })).rejects.toThrow(
      /unavailable/,
    );
    expect(f.dispatched).toEqual([]);
    f.scheduler.dispose();
  });
}
