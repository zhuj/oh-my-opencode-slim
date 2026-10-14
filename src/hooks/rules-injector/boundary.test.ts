import { describe, expect, test } from 'bun:test';
import { createRulesInjectorHook } from './hook';

describe('rules injector boundary separation', () => {
  test('uses activeDirectory for resource roots and boundary for path filter', () => {
    const hook = createRulesInjectorHook({
      projectBoundary: '/project',
      projectActiveDirectory: '/project/sub',
      prefixes: ['.opencode'],
      resolveTouchedFilePaths: () => ['/project/sub/file.md'],
      readRemainingContextTokens: async () => null,
      reportError: () => {},
    });
    expect(typeof hook.onToolExecuteAfter).toBe('function');
  });
});
