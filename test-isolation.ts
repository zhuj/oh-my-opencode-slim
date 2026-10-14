import { afterAll } from 'bun:test';
import { readdirSync, rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from './src/test-utils';

// bun test shares one process: keep every test off the real user dirs.
const root = createTmpDir(`omos-test-${process.pid}-`);
process.env.XDG_DATA_HOME = join(root, 'data');
process.env.XDG_CONFIG_HOME = join(root, 'config');
process.env.OPENCODE_LOG_DIR = join(root, 'log');
// Takes precedence over XDG_CONFIG_HOME; tests that need it set their own.
delete process.env.OPENCODE_CONFIG_DIR;
afterAll(() => removeTmpDir(root));
// A signal or --bail skips afterAll; best effort: reclaim roots of dead runs.
try {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(/^omos-test-(\d+)-/.exec(name)?.[1]);
    try {
      if (pid) process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        rm(join(tmpdir(), name), { recursive: true, force: true }, () => {});
    }
  }
} catch {}
