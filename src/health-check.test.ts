/// <reference types="bun-types" />

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
    // A configured council plus disabled_agents:["council","observer"]
    // leaves orchestrator + explorer + oracle + designer + fixer.
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

  test.each([
    ['v1', 'managed', 17],
    ['v2', 'managed', 14],
    ['v1', 'native', 8],
    ['v2', 'native', 8],
    ['v1', 'off', 6],
    ['v2', 'off', 6],
  ] as const)(
    '%s %s floor follows the registered baseline (%i)',
    (host, mode, expected) => {
      expect(minimumExpectedToolCount([], true, host, mode)).toBe(expected);
      expect(minimumExpectedToolCount([], false, host, mode)).toBe(
        expected - 1,
      );
      expect(minimumExpectedToolCount(['webfetch'], false, host, mode)).toBe(
        expected - 1,
      );
      expect(
        minimumExpectedToolCount(
          ['current_datetime', 'current_datetime', 'unknown_tool'],
          true,
          host,
          mode,
        ),
      ).toBe(expected - 1);
      expect(
        minimumExpectedToolCount(
          ['get_session_id', 'resolve_model'],
          true,
          host,
          mode,
        ),
      ).toBe(expected - 2);
    },
  );

  test('only registered lifecycle tools lower the floor', () => {
    expect(minimumExpectedToolCount(['task_queue_manage', 'task_wait'])).toBe(
      15,
    );
    expect(
      minimumExpectedToolCount(
        ['task_revive', 'task_message', 'wait_for_user'],
        true,
        'v2',
      ),
    ).toBe(14);
    expect(
      minimumExpectedToolCount(
        ['task_reply', 'task_queue_manage', 'task_wait'],
        true,
        'v2',
        'native',
      ),
    ).toBe(8);
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status'],
        true,
        'v2',
        'native',
      ),
    ).toBe(6);
    expect(
      minimumExpectedToolCount(
        ['task_cancel', 'task_status', 'task_list', 'task_dependency_tree'],
        true,
        'v1',
        'off',
      ),
    ).toBe(6);
    expect(
      minimumExpectedToolCount([
        'task_revive',
        'task_message',
        'wait_for_user',
      ]),
    ).toBe(14);
  });

  test('optional tools do not mask missing baseline registrations', () => {
    expect(
      minimumExpectedToolCount([
        'marketplace_inspect',
        'marketplace_manage',
        'interview_submit_state',
        'acp_run',
      ]),
    ).toBe(17);
  });

  test('malformed disabledTools degrades to the default floor', () => {
    for (const value of ['', null, {}]) {
      expect(minimumExpectedToolCount(value as any)).toBe(17);
    }
  });

  test('legacy boolean mode and omitted arguments remain supported', () => {
    expect(minimumExpectedToolCount()).toBe(17);
    expect(minimumExpectedToolCount([], true, 'v1', true)).toBe(17);
    expect(minimumExpectedToolCount([], true, 'v2', true)).toBe(14);
    expect(minimumExpectedToolCount([], true, 'v1', false)).toBe(6);
    expect(minimumExpectedToolCount([], true, 'v2', false)).toBe(6);
  });
});
