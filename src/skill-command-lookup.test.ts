import { describe, expect, test } from 'bun:test';
import {
  readConfigCommandNames,
  readGeneratedSkillCommandNames,
  resolveMissingCommandMessage,
  setGeneratedSkillCommandNames,
} from './skill-command-lookup';

describe('readConfigCommandNames', () => {
  test('collects the merged config command names', () => {
    expect(
      readConfigCommandNames({ command: { deepwork: {}, reflect: {} } }),
    ).toEqual(new Set(['deepwork', 'reflect']));
  });

  test.each([{}, { command: null }, { command: 'nope' }])(
    'returns an empty set for %j',
    (config) => {
      expect(readConfigCommandNames(config)).toEqual(new Set());
    },
  );
});

describe('resolveMissingCommandMessage', () => {
  test('leaves the host error alone until a name set is known', () => {
    // Given / When / Then
    expect(resolveMissingCommandMessage('anything', undefined)).toBeUndefined();
  });

  test('accepts a name owned by either source', () => {
    // Given
    const known = new Set(['deepwork', 'interview']);
    setGeneratedSkillCommandNames(['show-me']);
    try {
      // When / Then
      expect(resolveMissingCommandMessage('deepwork', known)).toBeUndefined();
      expect(resolveMissingCommandMessage('show-me', known)).toBeUndefined();
      expect(resolveMissingCommandMessage('missing', known)).toBe(
        'Command "/missing" not found. Use the skill tool to list available skills and commands.',
      );
    } finally {
      setGeneratedSkillCommandNames(undefined);
    }
  });

  test('reports a missing name when the bridge never registered', () => {
    // Given
    setGeneratedSkillCommandNames(undefined);
    // When
    expect(readGeneratedSkillCommandNames()).toBeUndefined();
    // Then
    expect(resolveMissingCommandMessage('missing', new Set(['deepwork']))).toBe(
      'Command "/missing" not found. Use the skill tool to list available skills and commands.',
    );
  });
});
