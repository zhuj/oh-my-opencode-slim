import { describe, expect, test } from 'bun:test';
import { buildPromptSections } from './prompt-sections';

describe('buildPromptSections', () => {
  test('returns the registered section names for a capability snapshot', () => {
    const sections = buildPromptSections({
      agentNames: ['alpha', 'beta'],
      wakeSchedulerEnabled: true,
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

  test('changes task guidance when the wake scheduler is unavailable', () => {
    const enabled = buildPromptSections({
      agentNames: [],
      wakeSchedulerEnabled: true,
    });
    const disabled = buildPromptSections({
      agentNames: [],
      wakeSchedulerEnabled: false,
    });

    expect(enabled.task_management).not.toBe(disabled.task_management);
  });
});
