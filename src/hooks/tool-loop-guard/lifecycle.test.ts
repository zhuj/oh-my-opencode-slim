/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { createToolLoopGuardHook } from './hook';

for (const tool of ['task_wait', 'task_queue_manage']) {
  test(`${tool} repeated lifecycle calls remain exempt`, async () => {
    // Given a lifecycle tool.
    const hook = createToolLoopGuardHook();
    // When identical calls settle repeatedly.
    for (let index = 0; index < 7; index++) {
      const input = { tool, sessionID: 'parent', callID: String(index) };
      const output = { output: 'settled' };
      await hook['tool.execute.before'](input, { args: { action: 'resume' } });
      await hook['tool.execute.after'](input, output);
      // Then lifecycle progress is not rewritten as a polling warning.
      expect(output.output).toBe('settled');
    }
  });
}

for (const tool of ['task_queue_list', 'task_dependency_tree']) {
  test(`${tool} warns on unchanged observations and resets on changed state`, async () => {
    const hook = createToolLoopGuardHook();
    for (let index = 0; index < 7; index++) {
      const input = { tool, sessionID: 'parent', callID: String(index) };
      const raw = index < 6 ? '{"state":"queued"}' : '{"state":"running"}';
      const output = { output: raw };
      await hook['tool.execute.before'](input, { args: {} });
      await hook['tool.execute.after'](input, output);
      expect(output.output === raw).toBe(index < 2 || index === 6);
    }
  });
}

test('queue mutation resets an unchanged observation stream', async () => {
  // Given two identical read-only observations.
  const hook = createToolLoopGuardHook();
  for (const [index, tool] of [
    'task_queue_list',
    'task_queue_list',
    'task_queue_manage',
    'task_queue_list',
  ].entries()) {
    const input = { tool, sessionID: 'parent', callID: String(index) };
    const output = { output: 'unchanged' };
    // When a queue mutation separates observations.
    await hook['tool.execute.before'](input, { args: {} });
    await hook['tool.execute.after'](input, output);
    // Then the next observation starts a fresh run even if its output is identical.
    expect(output.output).toBe('unchanged');
  }
});
