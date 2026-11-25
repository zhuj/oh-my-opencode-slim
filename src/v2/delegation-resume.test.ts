import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { createToolExecuteBridges } from './setup';

const nativeInput = Schema.Struct({
  agent: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  sessionID: Schema.optionalKey(
    Schema.String.check(Schema.isStartingWith('ses')),
  ),
});
const bridges = createToolExecuteBridges(async () => {}, undefined);
const eventFor = (sessionID: unknown, tool = 'subagent') => ({
  tool,
  id: 'call_resume',
  sessionID: 'ses_parent',
  input: {
    agent: 'explorer',
    description: 'Inspect code',
    prompt: 'Inspect it.',
    sessionID,
  },
});

describe('my-v2 resume argument compatibility before native validation', () => {
  test.each([
    undefined,
    null,
    'ses:new',
    'ses_new',
    'ses_<<new>>',
    'ses_',
    'ses',
    'ses?',
    'ses???',
  ])('normalizes the new-session sentinel %j to omission', async (value) => {
    const event = eventFor(value);
    await bridges.beforeBridge(event);
    expect(event.input).not.toHaveProperty('sessionID');
    expect(event.input).not.toHaveProperty('task_id');
    expect(Schema.decodeUnknownSync(nativeInput)(event.input)).toEqual({
      agent: 'explorer',
      description: 'Inspect code',
      prompt: 'Inspect it.',
    });
  });

  test.each(['ses_real-child', 'ses_new_real', 'ses:existing'])(
    'keeps the real native lookup argument %j unchanged',
    async (value) => {
      const event = eventFor(value);
      await bridges.beforeBridge(event);
      expect(event.input.sessionID).toBe(value);
    },
  );

  test.each(['', ' ', '\t\n'])(
    'rejects a visible blank resume %j',
    async (value) => {
      await expect(bridges.beforeBridge(eventFor(value))).rejects.toThrow(
        'empty sessionID',
      );
    },
  );

  test('does not relax other invalid native IDs or rewrite unrelated tools', async () => {
    const invalid = eventFor('other-prefix');
    await bridges.beforeBridge(invalid);
    expect(() =>
      Schema.decodeUnknownSync(nativeInput)(invalid.input),
    ).toThrow();
    const unrelated = eventFor('ses_new', 'read');
    await bridges.beforeBridge(unrelated);
    expect(unrelated.input.sessionID).toBe('ses_new');
  });
});
