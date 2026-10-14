/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { minimumExpectedToolCount } from './health-check';

describe('plugin health thresholds', () => {
  test('accounts only for intentionally disabled baseline tools', () => {
    expect(minimumExpectedToolCount()).toBe(19);
    expect(minimumExpectedToolCount(['wait_for_user'])).toBe(18);
    expect(minimumExpectedToolCount(['wait_for_user', 'wait_for_user'])).toBe(
      18,
    );
    expect(minimumExpectedToolCount(['task_reply'])).toBe(18);
    expect(minimumExpectedToolCount(['get_session_id'])).toBe(18);
    expect(minimumExpectedToolCount(['unknown_tool'])).toBe(19);
    expect(minimumExpectedToolCount(['task_result'])).toBe(19);
    expect(minimumExpectedToolCount([], false)).toBe(18);
    expect(minimumExpectedToolCount(['wait_for_user'], false)).toBe(17);
    expect(minimumExpectedToolCount(['webfetch'], false)).toBe(18);
    expect(
      minimumExpectedToolCount(['task_cancel', 'task_message', 'task_revive']),
    ).toBe(16);
    expect(
      minimumExpectedToolCount([
        'task_wait',
        'task_dependency_tree',
        'task_queue_list',
        'task_queue_manage',
      ]),
    ).toBe(15);
    expect(
      minimumExpectedToolCount([
        'task_list',
        'current_datetime',
        'resolve_model',
        'marketplace_inspect',
        'marketplace_manage',
      ]),
    ).toBe(14);
    expect(
      minimumExpectedToolCount(['interview_submit_state', 'acp_run']),
    ).toBe(19);
  });

  test('drops the floor by two on v2 (no wait_for_user, no task_revive)', () => {
    // minTools 19 already excludes task_result (folded into task_status);
    // v2 drops wait_for_user and task_revive → 17.
    expect(minimumExpectedToolCount([], true, 'v2')).toBe(17);
    // disabled_tools still wins when listed: no double-counting.
    expect(minimumExpectedToolCount(['wait_for_user'], true, 'v2')).toBe(17);
    expect(minimumExpectedToolCount(['task_reply'], true, 'v2')).toBe(16);
    expect(minimumExpectedToolCount([], false, 'v2')).toBe(16);
  });

  test('v2 never lowers the floor for the tools it does not register', () => {
    // task_revive and wait_for_user are unregistered on v2, so listing them
    // under disabled_tools must not mask a genuinely missing tool.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v2')).toBe(17);
    expect(
      minimumExpectedToolCount(['task_revive', 'wait_for_user'], true, 'v2'),
    ).toBe(17);
    // v1 keeps both in the baseline.
    expect(minimumExpectedToolCount(['task_revive'], true, 'v1')).toBe(18);
  });

  test('keeps at least one tool of margin for the v2 registrations', () => {
    // v2 registers 17 baseline tools plus interview_submit_state and acp_run.
    const registered = 19;
    const defaultFloor = minimumExpectedToolCount([], true, 'v2');
    expect(registered - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_commands:["interview"] removes interview_submit_state.
    const withoutInterview = registered - 1;
    expect(withoutInterview - defaultFloor).toBeGreaterThanOrEqual(1);
    // disabled_tools:["task_revive"] changes nothing on v2 (never registered).
    expect(
      registered - minimumExpectedToolCount(['task_revive'], true, 'v2'),
    ).toBeGreaterThanOrEqual(1);
  });

  test('never throws when disabledTools is not an array', () => {
    // Regression test: a malformed/non-array config.disabled_tools value
    // must degrade to "nothing disabled" instead of crashing plugin init.
    expect(minimumExpectedToolCount('' as any)).toBe(19);
    expect(minimumExpectedToolCount(null as any)).toBe(19);
    expect(minimumExpectedToolCount({} as any)).toBe(19);
  });
});
