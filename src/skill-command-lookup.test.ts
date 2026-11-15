import { describe, expect, test } from 'bun:test';
import {
  readConfigCommandNames,
  resolveMissingCommandMessage,
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

  test('accepts a name owned by either source without retaining either catalog', () => {
    const known = new Set(['deepwork', 'interview']);
    const generated = new Set(['show-me']);
    expect(
      resolveMissingCommandMessage('deepwork', known, generated),
    ).toBeUndefined();
    expect(
      resolveMissingCommandMessage('show-me', known, generated),
    ).toBeUndefined();
    expect(resolveMissingCommandMessage('missing', known, generated)).toBe(
      'Command "/missing" not found. Use the skill tool to list available skills and commands.',
    );
    expect(resolveMissingCommandMessage('show-me', known)).toBe(
      'Command "/show-me" not found. Use the skill tool to list available skills and commands.',
    );
  });

  test('reports a missing name when the bridge never registered', () => {
    expect(resolveMissingCommandMessage('missing', new Set(['deepwork']))).toBe(
      'Command "/missing" not found. Use the skill tool to list available skills and commands.',
    );
  });
});
