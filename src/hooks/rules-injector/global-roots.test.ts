import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from '../../test-utils';
import { resolveGlobalRuleRoots } from './global-roots';

const created: string[] = [];
const envKeys = ['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;
const saved = new Map<string, string | undefined>();

function tempDir(_prefix: string): string {
  const dir = createTmpDir();
  created.push(dir);
  return dir;
}

/**
 * Pins both config-dir inputs so the suite never reads the machine's real
 * `~/.config/opencode/rules`, which would otherwise vary by developer.
 */
function withConfigDirs(
  configDir: string | undefined,
  xdgHome: string | undefined,
): void {
  for (const key of envKeys) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  if (configDir !== undefined) process.env.OPENCODE_CONFIG_DIR = configDir;
  if (xdgHome !== undefined) process.env.XDG_CONFIG_HOME = xdgHome;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  while (created.length > 0) {
    removeTmpDir(created.pop() as string);
  }
});

describe('resolveGlobalRuleRoots', () => {
  test('returns an empty array when the config dir has no rules directory', () => {
    const configDir = tempDir('omos-global-');
    withConfigDirs(configDir, join(configDir, 'xdg'));

    expect(resolveGlobalRuleRoots()).toEqual([]);
  });

  test('resolves the rules directory and marks it global', () => {
    const configDir = tempDir('omos-global-');
    const rules = join(configDir, 'rules');
    mkdirSync(rules);
    withConfigDirs(configDir, join(configDir, 'xdg'));

    const roots = resolveGlobalRuleRoots();

    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({
      path: rules,
      relativePath: 'global-rules',
      prefix: 'global',
      category: 'rules',
      global: true,
    });
  });

  test('dedupes when both config sources resolve to the same directory', () => {
    // getConfigSearchDirs() yields OPENCODE_CONFIG_DIR then
    // XDG_CONFIG_HOME/opencode. Point both at one dir named `opencode`.
    const parent = tempDir('omos-global-');
    const shared = join(parent, 'opencode');
    mkdirSync(join(shared, 'rules'), { recursive: true });
    withConfigDirs(shared, parent);

    expect(resolveGlobalRuleRoots()).toHaveLength(1);
  });

  test('ignores a rules entry that is a file rather than a directory', () => {
    const configDir = tempDir('omos-global-');
    writeFileSync(join(configDir, 'rules'), 'not a directory');
    withConfigDirs(configDir, join(configDir, 'xdg'));

    expect(resolveGlobalRuleRoots()).toEqual([]);
  });

  test('does not throw when the config dir does not exist', () => {
    const missing = join(tempDir('omos-global-'), 'absent');
    withConfigDirs(missing, join(missing, 'xdg'));

    expect(() => resolveGlobalRuleRoots()).not.toThrow();
    expect(resolveGlobalRuleRoots()).toEqual([]);
  });

  test('skips a dangling rules symlink instead of throwing', () => {
    // The pre-isolation implementation read the directory with statSync and
    // then called realpathSync unguarded, so a dangling link aborted the whole
    // resolution and took the project rules down with it.
    const configDir = tempDir('omos-global-');
    const target = join(tempDir('omos-global-target-'), 'gone');
    symlinkSync(target, join(configDir, 'rules'));
    withConfigDirs(configDir, join(configDir, 'xdg'));

    expect(() => resolveGlobalRuleRoots()).not.toThrow();
    expect(resolveGlobalRuleRoots()).toEqual([]);
  });

  test('skips a rules symlink loop instead of throwing', () => {
    const configDir = tempDir('omos-global-');
    const rules = join(configDir, 'rules');
    symlinkSync(rules, rules);
    withConfigDirs(configDir, join(configDir, 'xdg'));

    // statSync raises ELOOP here, which is the branch the per-directory
    // try/catch exists for: the failure must cost this directory only.
    expect(() => resolveGlobalRuleRoots()).not.toThrow();
    expect(resolveGlobalRuleRoots()).toEqual([]);
  });

  test('keeps the configured spelling of a symlinked rules directory', () => {
    const configDir = tempDir('omos-global-');
    const real = join(tempDir('omos-global-real-'), 'rules');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(configDir, 'rules'));
    withConfigDirs(configDir, join(configDir, 'xdg'));

    // Symlinks are deliberately not resolved, so the root keeps the path the
    // user configured rather than the target it points at.
    expect(resolveGlobalRuleRoots().map((root) => root.path)).toEqual([
      join(configDir, 'rules'),
    ]);
  });
});
