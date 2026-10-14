import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectResourceRoot } from '../../config/project-resource-paths';
import { OPENCODE_CONFIG_DEPTH } from '../../config/project-resource-paths';
import { createTmpDir, removeTmpDir } from '../../test-utils';
import { createRulesInjectorHook } from './hook';

async function withProject(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = createTmpDir();
  try {
    await run(root);
  } finally {
    removeTmpDir(root);
  }
}

function fixture(
  root: string,
  resolvePaths: () => readonly string[],
  readTokens = async () => null,
  globalRoots: readonly ProjectResourceRoot[] = [],
) {
  mkdirSync(join(root, '.local', 'rules'), { recursive: true });
  writeFileSync(
    join(root, '.local', 'rules', 'always.md'),
    '---\nalwaysApply: true\n---\nRULE',
  );
  return createRulesInjectorHook({
    projectBoundary: root,
    prefixes: ['.local'],
    resolveTouchedFilePaths: resolvePaths,
    readRemainingContextTokens: readTokens,
    reportError: () => {},
    // Pinned empty so the suite never reads the machine's real global
    // `~/.config/opencode/rules`, which varies by developer.
    resolveGlobalRoots: () => globalRoots,
  });
}

describe('createRulesInjectorHook', () => {
  test('injects only eligible tool outputs and keeps the source bytes as prefix', async () => {
    await withProject(async (root) => {
      const file = join(root, 'a.ts');
      const hook = fixture(root, () => [file]);
      const result = { title: file, output: 'SOURCE', metadata: {} };
      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, result);
      expect(result.output.startsWith('SOURCE')).toBe(true);
      expect(result.output).toContain('RULE');
    });
  });

  test('uses only resolved result fields and preserves surrounding payload', async () => {
    await withProject(async (root) => {
      const file = join(root, 'a.ts');
      const hook = createRulesInjectorHook({
        projectBoundary: root,
        prefixes: ['.local'],
        resolveTouchedFilePaths: (input, output) => {
          expect(input).toEqual({ tool: 'read', sessionID: 's' });
          expect(output).toHaveProperty('resolvedFilePaths', [file]);
          return output.resolvedFilePaths ?? [];
        },
        readRemainingContextTokens: async () => null,
        reportError: () => {},
        resolveGlobalRoots: () => [],
      });
      const result = {
        title: 'untrusted title',
        output: 'ORIGINAL',
        metadata: { system: 'keep' },
        resolvedFilePaths: [file],
      };

      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, result);

      expect(result.output.startsWith('ORIGINAL')).toBe(true);
      expect(result.metadata).toEqual({ system: 'keep' });
      expect(result.title).toBe('untrusted title');
    });
  });

  test('ignores failed, unsupported, and out-of-boundary results', async () => {
    await withProject(async (root) => {
      const hook = fixture(root, () => [join(root, '..', 'outside.ts')]);
      const output = {
        title: 'untrusted title',
        output: 'SOURCE',
        metadata: {},
      };
      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, output);
      await hook.onToolExecuteAfter({ tool: 'bash', sessionID: 's' }, output);
      await hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's', status: 'error' },
        output,
      );
      expect(output.output).toBe('SOURCE');
    });
  });

  test('injects global rules ahead of project rules', async () => {
    await withProject(async (root) => {
      const globalDir = createTmpDir();
      try {
        mkdirSync(globalDir, { recursive: true });
        writeFileSync(
          join(globalDir, 'team.md'),
          '---\nalwaysApply: true\n---\nGLOBAL RULE',
        );
        const globalRoots: readonly ProjectResourceRoot[] = [
          {
            path: globalDir,
            relativePath: 'global-rules',
            ancestor: globalDir,
            depth: OPENCODE_CONFIG_DEPTH,
            prefix: 'global',
            prefixIndex: 0,
            category: 'rules',
            global: true,
          },
        ];

        const file = join(root, 'src', 'file.ts');
        const hook = fixture(
          root,
          () => [file],
          async () => null,
          globalRoots,
        );
        const result = { title: 'read', output: 'SOURCE', metadata: {} };

        await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, result);

        expect(result.output).toContain('GLOBAL RULE');
        expect(result.output).toContain('RULE');
        // Least specific first: the global rule is the farthest directory.
        expect(result.output.indexOf('GLOBAL RULE')).toBeLessThan(
          result.output.indexOf('RULE'),
        );
        expect(result.output).toContain('global-rules/team.md');
        // A global rule must not leak an escaping path into the heading.
        expect(result.output).not.toContain('..');
      } finally {
        removeTmpDir(globalDir);
      }
    });
  });

  test('keeps project rules when global root resolution throws', async () => {
    await withProject(async (root) => {
      mkdirSync(join(root, '.local', 'rules'), { recursive: true });
      writeFileSync(
        join(root, '.local', 'rules', 'always.md'),
        '---\nalwaysApply: true\n---\nRULE',
      );
      let reported: unknown;
      const hook = createRulesInjectorHook({
        projectBoundary: root,
        prefixes: ['.local'],
        resolveTouchedFilePaths: () => [join(root, 'src', 'file.ts')],
        readRemainingContextTokens: async () => null,
        reportError: (error) => {
          reported = error;
        },
        resolveGlobalRoots: () => {
          throw new Error('global root unreadable');
        },
      });
      const output = { title: 'read', output: 'SOURCE', metadata: {} };

      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, output);

      // A global-side failure is reported and costs only the global rules.
      // Letting it escape would abort the pass and drop the project rule too.
      expect(String(reported)).toContain('global root unreadable');
      expect(output.output).toContain('RULE');
    });
  });

  test('fails open when touched-path resolution throws', async () => {
    await withProject(async (root) => {
      let reported: unknown;
      const hook = createRulesInjectorHook({
        projectBoundary: root,
        prefixes: ['.local'],
        resolveTouchedFilePaths: () => {
          throw new Error('adapter failed');
        },
        readRemainingContextTokens: async () => null,
        reportError: (error) => {
          reported = error;
        },
        resolveGlobalRoots: () => [],
      });
      const output = { title: 'read', output: 'SOURCE', metadata: {} };
      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, output);
      expect(output.output).toBe('SOURCE');
      expect(reported).toEqual(new Error('adapter failed'));
    });
  });

  test('matches every normalized path from multi-file host results once', async () => {
    await withProject(async (root) => {
      fixture(root, () => []);
      writeFileSync(
        join(root, '.local', 'rules', 'second.md'),
        '---\nglobs: "src/second.ts"\n---\nSECOND RULE',
      );
      const second = join(root, 'src', 'second.ts');
      const hook = fixture(root, () => [
        join(root, 'src', 'first.ts'),
        second,
        join(root, 'src', '..', 'src', 'second.ts'),
      ]);
      const result = { title: 'patch', output: 'SOURCE', metadata: {} };
      await hook.onToolExecuteAfter(
        { tool: 'apply_patch', sessionID: 's' },
        result,
      );
      expect(result.output.match(/SECOND RULE/g)).toHaveLength(1);
    });
  });

  test('serializes same-session pipeline and commits only the first result', async () => {
    await withProject(async (root) => {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const hook = fixture(
        root,
        () => {
          calls += 1;
          return [join(root, 'a.ts')];
        },
        async () => {
          entered();
          await gate;
          return null;
        },
      );
      const first = { title: 'a', output: 'FIRST', metadata: {} };
      const second = { title: 'b', output: 'SECOND', metadata: {} };
      const pending = hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's' },
        first,
      );
      await enteredPromise;
      const queued = hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's' },
        second,
      );
      expect(calls).toBe(1);
      release();
      await Promise.all([pending, queued]);
      expect(first.output).toContain('RULE');
      expect(second.output).toBe('SECOND');
    });
  });

  test('clearSession waits for work and permits injection after clearing', async () => {
    await withProject(async (root) => {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      const hook = fixture(
        root,
        () => [join(root, 'a.ts')],
        async () => {
          reads += 1;
          if (reads === 1) {
            entered();
            await gate;
          }
          return null;
        },
      );
      const first = hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's' },
        { title: 'a', output: 'A', metadata: {} },
      );
      await enteredPromise;
      let cleared = false;
      const clear = hook.clearSession('s').then(() => {
        cleared = true;
      });
      expect(cleared).toBe(false);
      release();
      await Promise.all([first, clear]);
      const later = { title: 'b', output: 'B', metadata: {} };
      await hook.onToolExecuteAfter({ tool: 'read', sessionID: 's' }, later);
      expect(later.output).toContain('RULE');
    });
  });

  test('overlapping clearAll barriers order two sessions and queued work', async () => {
    await withProject(async (root) => {
      const entered: Array<() => void> = [];
      const gates: Array<() => void> = [];
      const waits = [0, 1].map(
        () => new Promise<void>((resolve) => entered.push(resolve)),
      );
      const releases = [0, 1].map(
        () => new Promise<void>((resolve) => gates.push(resolve)),
      );
      const events: string[] = [];
      let reads = 0;
      const hook = fixture(
        root,
        () => [join(root, 'a.ts')],
        async () => {
          const index = reads++;
          if (index < 2) {
            entered[index]();
            await releases[index];
          }
          return null;
        },
      );
      const firstOutputs = ['A', 'B'].map((value) => ({
        title: value,
        output: value,
        metadata: {},
      }));
      const first = firstOutputs.map((output, i) =>
        hook
          .onToolExecuteAfter({ tool: 'read', sessionID: `s${i}` }, output)
          .then(() => events.push(`done${i}`)),
      );
      await Promise.all(waits);
      const clear1 = hook.clearAll().then(() => events.push('clear1'));
      const middle = { title: 'middle', output: 'MIDDLE', metadata: {} };
      const middleWork = hook
        .onToolExecuteAfter({ tool: 'read', sessionID: 's3' }, middle)
        .then(() => events.push('middle'));
      const clear2 = hook.clearAll().then(() => events.push('clear2'));
      const later = { title: 'later', output: 'LATER', metadata: {} };
      const laterWork = hook
        .onToolExecuteAfter({ tool: 'read', sessionID: 's4' }, later)
        .then(() => events.push('later'));
      gates[0]();
      await first[0];
      expect(events).not.toContain('clear1');
      gates[1]();
      await Promise.all([first[1], clear1, middleWork, clear2, laterWork]);
      expect(events.indexOf('done0')).toBeLessThan(events.indexOf('clear1'));
      expect(events.indexOf('done1')).toBeLessThan(events.indexOf('clear1'));
      expect(events.indexOf('clear1')).toBeLessThan(events.indexOf('middle'));
      expect(events.indexOf('middle')).toBeLessThan(events.indexOf('clear2'));
      expect(events.indexOf('clear2')).toBeLessThan(events.indexOf('later'));
      expect(
        firstOutputs.every((output) => output.output.includes('RULE')),
      ).toBe(true);
      expect(middle.output).toContain('RULE');
      expect(later.output).toContain('RULE');
    });
  });

  test('allows different session pipelines to enter context lookup concurrently', async () => {
    await withProject(async (root) => {
      let enteredCount = 0;
      let bothEntered!: () => void;
      let release!: () => void;
      const both = new Promise<void>((resolve) => {
        bothEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const hook = fixture(
        root,
        () => [join(root, 'a.ts')],
        async () => {
          enteredCount += 1;
          if (enteredCount === 2) bothEntered();
          await gate;
          return null;
        },
      );
      const first = hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's1' },
        { title: 'a', output: 'A', metadata: {} },
      );
      const second = hook.onToolExecuteAfter(
        { tool: 'read', sessionID: 's2' },
        { title: 'b', output: 'B', metadata: {} },
      );
      await both;
      release();
      await Promise.all([first, second]);
      expect(enteredCount).toBe(2);
    });
  });
});
