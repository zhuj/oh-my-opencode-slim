import { describe, expect, test } from 'bun:test';
import { ALL_AGENT_NAMES } from './config/constants';
import {
  minimumExpectedAgentCount,
  minimumExpectedToolCount,
} from './health-check';

describe('plugin health thresholds', () => {
  test('agent floor accounts for the configured disabled roster', () => {
    expect(
      minimumExpectedAgentCount(['explorer', 'oracle', 'designer', 'fixer']),
    ).toBe(4);
    expect(minimumExpectedAgentCount(['observer'])).toBe(7);
    expect(
      minimumExpectedAgentCount([
        'explorer',
        'oracle',
        'designer',
        'fixer',
        'observer',
      ]),
    ).toBe(3);
  });

  test('agent floor omits council agents when no council is configured', () => {
    expect(minimumExpectedAgentCount(['observer'], false)).toBe(5);
    expect(
      minimumExpectedAgentCount(
        ['explorer', 'oracle', 'designer', 'fixer'],
        false,
      ),
    ).toBe(2);
    expect(minimumExpectedAgentCount(['observer'], true)).toBe(7);
  });

  test('agent floor follows createAgents when council is explicitly disabled', () => {
    expect(minimumExpectedAgentCount(['council', 'observer'])).toBe(5);
    expect(
      minimumExpectedAgentCount(['council', 'observer', 'explorer'], true),
    ).toBe(4);
  });

  test('agent floor safely handles malformed or exhaustive disabled input', () => {
    expect(minimumExpectedAgentCount('' as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount(null as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount({} as any)).toBe(ALL_AGENT_NAMES.length);
    expect(minimumExpectedAgentCount([...ALL_AGENT_NAMES])).toBe(1);
  });

  test('native mode sets a floor of nine including the three utility tools', () => {
    expect(minimumExpectedToolCount()).toBe(9);
    expect(minimumExpectedToolCount([], false)).toBe(8);
    expect(minimumExpectedToolCount(['task_reply'], true)).toBe(8);
    expect(minimumExpectedToolCount(['task_cancel'], true, 'native')).toBe(8);
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status', 'task_reply'],
        true,
        'native',
      ),
    ).toBe(6);
  });

  test.each(['current_datetime', 'get_session_id', 'resolve_model'])(
    'disabling %s drops the floor once in both task modes',
    (tool) => {
      expect(minimumExpectedToolCount([tool, tool], true, 'native')).toBe(8);
      expect(minimumExpectedToolCount([tool, tool], true, 'off')).toBe(5);
    },
  );

  test('counts disabled utilities independently of the webfetch and task-mode gates', () => {
    expect(
      minimumExpectedToolCount(
        [
          'resolve_model',
          'current_datetime',
          'get_session_id',
          'webfetch',
          'task_reply',
        ],
        false,
        'off',
      ),
    ).toBe(2);
  });

  test('ignores tools outside the baseline in either task mode', () => {
    const other = [
      'task_revive',
      'task_message',
      'wait_for_user',
      'task_report',
      'interview_submit_state',
    ];
    expect(minimumExpectedToolCount(other, true, 'native')).toBe(9);
    expect(minimumExpectedToolCount(other, true, 'off')).toBe(6);
  });

  test('never throws when disabledTools is not an array', () => {
    expect(minimumExpectedToolCount('' as any)).toBe(9);
    expect(minimumExpectedToolCount(null as any)).toBe(9);
    expect(minimumExpectedToolCount({} as any)).toBe(9);
  });

  test('task mode off omits the three native task controls', () => {
    expect(minimumExpectedToolCount([], true, 'off')).toBe(6);
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status', 'task_reply'],
        true,
        'off',
      ),
    ).toBe(6);
    expect(minimumExpectedToolCount([], false, 'off')).toBe(5);
  });
});
