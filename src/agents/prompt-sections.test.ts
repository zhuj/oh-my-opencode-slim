import { describe, expect, test } from 'bun:test';
import { buildPromptSections } from './prompt-sections';

describe('buildPromptSections', () => {
  test('returns the registered section names for a capability snapshot', () => {
    const sections = buildPromptSections({
      agentNames: ['alpha', 'beta'],
    });

    expect(Object.keys(sections)).toEqual([
      'intent_gate',
      'agents',
      'task_management',
      'verification',
      'orchestration',
      'delegation',
      'result_synthesis',
    ]);
    expect(sections.agents).toContain('@alpha');
    expect(sections.agents).toContain('@beta');
    expect(sections.orchestration).toContain('overall outcome');
    expect(sections.delegation).toContain('write ownership');
    expect(sections.result_synthesis).toContain('verified evidence');
  });

  test('task guidance follows native completion results', () => {
    const sections = buildPromptSections({ agentNames: [] });
    expect(sections.task_management).toContain('native completion results');
  });
});
