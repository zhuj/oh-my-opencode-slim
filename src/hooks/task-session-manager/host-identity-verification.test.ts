import { describe, expect, mock, test } from 'bun:test';
import { readHostSession, resolveAgent } from './session-recovery';

describe('host-identity-verification', () => {
  test('readHostSession returns ok with parent and agent', async () => {
    const session = {
      get: mock(async () => ({
        data: {
          id: 't1',
          parentID: 'p1',
          agent: 'a1',
          time: { created: 1 },
          title: 't',
        },
      })),
    };
    const res = await readHostSession(
      {
        session,
      } as unknown as import('@opencode-ai/plugin').PluginInput['client'],
      '.',
      't1',
    );
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.parentID).toBe('p1');
      expect(res.agent).toBe('a1');
    }
  });

  test('readHostSession refuses missing parent', async () => {
    const session = {
      get: mock(async () => ({ data: { id: 't1', agent: 'a1' } })),
    };
    const res = await readHostSession(
      {
        session,
      } as unknown as import('@opencode-ai/plugin').PluginInput['client'],
      '.',
      't1',
    );
    expect(res.kind).toBe('refused');
  });

  test('readHostSession refuses missing id', async () => {
    const session = {
      get: mock(async () => ({ data: { parentID: 'p1', agent: 'a1' } })),
    };
    const res = await readHostSession(
      {
        session,
      } as unknown as import('@opencode-ai/plugin').PluginInput['client'],
      '.',
      't1',
    );
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused')
      expect(res.reason).toContain('missing or mismatch');
  });

  test('resolveAgent refuses conflict', () => {
    const r = resolveAgent({
      sessionID: 's1',
      sessionAgent: 'a',
      childTranscript: { data: [{ info: { role: 'user', agent: 'b' } }] },
      parentParts: [{ sessionID: 's1', agent: 'c' }],
      parentSessionID: 'p1',
    });
    expect(r.kind).toBe('refused');
  });

  test('resolveAgent returns ok when consistent', () => {
    const r = resolveAgent({
      sessionID: 's1',
      sessionAgent: 'a',
      childTranscript: { data: [{ info: { role: 'user', agent: 'a' } }] },
      parentParts: [{ sessionID: 's1', agent: 'a' }],
      parentSessionID: 'p1',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.agent).toBe('a');
  });
});
