import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Single source of truth for test scratch directories.
 *
 * Every test creates scratch under `os.tmpdir()` — never the home
 * directory, the repository, the process cwd, or a hardcoded `/tmp`.
 * Home and cwd are excluded because `bun test` runs every file in one
 * process, so a leaked write there is both nondeterministic and unsafe.
 * `src/test-scratch-tripwire.test.ts` enforces this mechanically.
 */
function scratchRoot(): string {
  return realpathSync(tmpdir());
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length === 0 ||
    prefix === '.' ||
    prefix === '..' ||
    prefix.includes('\0') ||
    prefix.includes('/') ||
    prefix.includes('\\')
  ) {
    throw new Error(
      `Temporary directory prefix must be one path component: ${prefix}`,
    );
  }
}

export async function withTmpDir<T>(
  callback: (tmp: string) => Promise<T>,
): Promise<T> {
  const tmp = await mkdtemp(join(scratchRoot(), 'oh-my-opencode-slim-test-'));
  try {
    return await callback(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Sync counterpart for suites whose hooks and bodies are synchronous. */
export function withTmpDirSync<T>(callback: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(scratchRoot(), 'oh-my-opencode-slim-test-'));
  try {
    return callback(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Lease pair for suites that need the directory to outlive a single
 * statement, e.g. a `beforeEach`/`afterEach` pair. Always pair a
 * `createTmpDir` call with a `removeTmpDir` in the matching teardown.
 */
export function createTmpDir(prefix = 'oh-my-opencode-slim-test-'): string {
  validatePrefix(prefix);
  return mkdtempSync(join(scratchRoot(), prefix));
}

export function removeTmpDir(tmp: string): void {
  const root = resolve(scratchRoot());
  const target = resolve(tmp);
  const relativeTarget = relative(root, target);
  if (
    !relativeTarget ||
    relativeTarget.startsWith(`..${sep}`) ||
    relativeTarget === '..' ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Temporary directory is outside test scratch root: ${tmp}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
