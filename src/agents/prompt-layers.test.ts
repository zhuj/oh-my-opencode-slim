import { describe, expect, test } from 'bun:test';
import { BASE_AGENT_PROMPT, prependBaseAgentPrompt } from './prompt-layers';

describe('prependBaseAgentPrompt', () => {
  test('adds one shared prefix without changing the role prompt body', () => {
    const rolePrompt = 'Role-specific instructions.\n\nKeep this spacing.';

    const rendered = prependBaseAgentPrompt(rolePrompt);

    expect(rendered).toBe(`${BASE_AGENT_PROMPT}\n\n${rolePrompt}`);
    expect(rendered.indexOf(BASE_AGENT_PROMPT)).toBe(
      rendered.lastIndexOf(BASE_AGENT_PROMPT),
    );
  });

  test('preserves an empty prompt body', () => {
    expect(prependBaseAgentPrompt('')).toBe(`${BASE_AGENT_PROMPT}\n\n`);
  });
});
