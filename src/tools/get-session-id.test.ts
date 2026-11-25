import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { createGetSessionIdTool } from './get-session-id';

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: 'message-1',
    agent: 'tester',
    directory: '/project',
    worktree: '/project',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe('get_session_id', () => {
  test('returns the invocation-time opaque session ID unchanged', async () => {
    const { get_session_id } = createGetSessionIdTool();

    const result = await get_session_id.execute(
      {},
      createToolContext('opaque/session ID:with spaces'),
    );

    expect(result).toBe('opaque/session ID:with spaces');
  });

  test('fails clearly when invocation context is absent', async () => {
    const { get_session_id } = createGetSessionIdTool();
    const result = Reflect.apply(get_session_id.execute, undefined, [{}]);

    await expect(result).rejects.toThrow('get_session_id requires sessionID');
  });
});
