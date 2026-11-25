import { afterAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs/promises';
import * as path from 'node:path';
import { withTmpDir as sharedWithTmpDir } from '../test-utils';
import * as realDocument from './document';
import * as realHelpers from './helpers';

// ─── Instrumentation ───────────────────────────────────────────────────
// Transparent, pass-through instrumentation: every call is forwarded to the
// real implementation, only the invocation counters are added.  The counters
// (never wall-clock) are what prove the redundant work is gone.

const helperCalls = { extractResumeSlug: 0, parseSpecBlocks: 0 };
const fsCalls = { readdir: 0, readFile: 0, stat: 0 };
const originalFs = { ...realFs };
const originalHelpers = { ...realHelpers };
const originalDocument = { ...realDocument };
let beforeRead: ((filePath: unknown) => void) | undefined;
let pauseRead: ((filePath: unknown) => Promise<void>) | undefined;
let statFailure: ((filePath: unknown) => Error | undefined) | undefined;
let lstatFailure: ((filePath: unknown) => Error | undefined) | undefined;

mock.module('./helpers', () => ({
  ...originalHelpers,
  extractResumeSlug: (interviewId: string): string => {
    helperCalls.extractResumeSlug++;
    return originalHelpers.extractResumeSlug(interviewId);
  },
}));

const countedReaddir = ((...args: unknown[]) => {
  fsCalls.readdir++;
  return (originalFs.readdir as (...a: unknown[]) => unknown)(...args);
}) as typeof realFs.readdir;

const countedReadFile = ((...args: unknown[]) => {
  fsCalls.readFile++;
  beforeRead?.(args[0]);
  if (pauseRead) {
    return pauseRead(args[0]).then(() =>
      (originalFs.readFile as (...a: unknown[]) => unknown)(...args),
    );
  }
  return (originalFs.readFile as (...a: unknown[]) => unknown)(...args);
}) as typeof realFs.readFile;

const countedStat = ((...args: unknown[]) => {
  fsCalls.stat++;
  const failure = statFailure?.(args[0]);
  if (failure) return Promise.reject(failure);
  return (originalFs.stat as (...a: unknown[]) => unknown)(...args);
}) as typeof realFs.stat;

const countedLstat = ((...args: unknown[]) => {
  const failure = lstatFailure?.(args[0]);
  if (failure) return Promise.reject(failure);
  return (originalFs.lstat as (...a: unknown[]) => unknown)(...args);
}) as typeof realFs.lstat;

mock.module('node:fs/promises', () => ({
  ...originalFs,
  default: {
    ...originalFs,
    readdir: countedReaddir,
    readFile: countedReadFile,
    stat: countedStat,
    lstat: countedLstat,
  },
  readdir: countedReaddir,
  readFile: countedReadFile,
  stat: countedStat,
  lstat: countedLstat,
}));

mock.module('./document', () => ({
  ...originalDocument,
  parseSpecBlocks: (document: string) => {
    helperCalls.parseSpecBlocks++;
    return originalDocument.parseSpecBlocks(document);
  },
}));

const { createDashboardServer } = await import('./dashboard');
const { bindFreePort } = await import('./test-port');

function restoreOwnedMocks(): void {
  mock.module('./helpers', () => originalHelpers);
  mock.module('./document', () => originalDocument);
  mock.module('node:fs/promises', () => originalFs);
  beforeRead = undefined;
  pauseRead = undefined;
  statFailure = undefined;
  lstatFailure = undefined;
}

afterAll(async () => {
  restoreOwnedMocks();
  const restoredFs = await import('node:fs/promises');
  const restoredHelpers = await import('./helpers');
  const restoredDocument = await import('./document');
  expect(restoredFs.readFile).toBe(originalFs.readFile);
  expect(restoredFs.readdir).toBe(originalFs.readdir);
  expect(restoredFs.stat).toBe(originalFs.stat);
  expect(restoredFs.lstat).toBe(originalFs.lstat);
  expect(restoredFs.default.readFile).toBe(originalFs.default.readFile);
  expect(restoredHelpers.extractResumeSlug).toBe(
    originalHelpers.extractResumeSlug,
  );
  expect(restoredDocument.parseSpecBlocks).toBe(
    originalDocument.parseSpecBlocks,
  );
});

async function withTmpDir<T>(
  callback: (dir: string) => Promise<T>,
): Promise<T> {
  return sharedWithTmpDir(callback);
}

async function startDashboard() {
  const { port, server } = await bindFreePort();
  const dashboard = createDashboardServer({
    port,
    outputFolder: 'interview',
    server,
  });
  const baseUrl = await dashboard.start();
  return {
    dashboard,
    baseUrl,
    authToken: dashboard.authToken,
    cleanup: () => dashboard.close(),
  };
}

function interviewDirFor(dir: string): string {
  return path.join(dir, '.local', 'interview');
}

async function writeInterviewFile(
  dir: string,
  fileName: string,
  sessionID: string,
  body = 'Body text.',
): Promise<string> {
  const interviewDir = interviewDirFor(dir);
  await realFs.mkdir(interviewDir, { recursive: true });
  const filePath = path.join(interviewDir, fileName);
  await realFs.writeFile(
    filePath,
    [
      '---',
      `sessionID: ${sessionID}`,
      `updatedAt: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${fileName.replace(/\.md$/, '')}`,
      '',
      '## 1. Scope',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
  return filePath;
}

function recoveredID(filePath: string): string {
  return `recovered-${createHash('sha256').update(filePath).digest('hex')}`;
}

function pushLiveEntry(
  dashboard: ReturnType<typeof createDashboardServer>,
  interviewId: string,
  filePath = '',
): void {
  dashboard.pushState({
    interviewId,
    sessionID: `session-${interviewId}`,
    idea: interviewId,
    mode: 'awaiting-user',
    summary: 'Summary',
    title: interviewId,
    questions: [],
    pendingAnswers: null,
    lastUpdatedAt: Date.now(),
    filePath,
    nudgeAction: null,
  });
}

async function getState(
  baseUrl: string,
  authToken: string,
  interviewId: string,
): Promise<{
  document: string;
  markdownPath: string;
  blocks: Array<{ id: string }>;
  interview: { markdownPath: string };
}> {
  const response = await fetch(
    `${baseUrl}/api/interviews/${interviewId}/state?token=${authToken}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    document: string;
    markdownPath: string;
    blocks: Array<{ id: string }>;
    interview: { markdownPath: string };
  };
}

async function listFiles(
  baseUrl: string,
  authToken: string,
): Promise<Array<{ fileName: string }>> {
  const response = await fetch(`${baseUrl}/api/files?token=${authToken}`);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    files: Array<{ fileName: string }>;
  };
  return data.files;
}

describe('dashboard caching cost', () => {
  describe('rebuildFromFiles live-file lookup', () => {
    test('live state pushed during a rebuild still prevents recovery', async () => {
      await withTmpDir(async (dir) => {
        const { dashboard, cleanup } = await startDashboard();
        try {
          dashboard.addManualFolder(dir);
          const filePath = await writeInterviewFile(dir, 'concurrent.md', 's');
          beforeRead = (candidate) => {
            if (candidate !== filePath) return;
            beforeRead = undefined;
            pushLiveEntry(dashboard, 'live-run-concurrent', filePath);
          };
          await dashboard.refreshFiles();
          expect(dashboard.getState(recoveredID(filePath))).toBeUndefined();
          expect(dashboard.getState('live-run-concurrent')).toBeDefined();
        } finally {
          beforeRead = undefined;
          cleanup();
        }
      });
    });
    test('recovered IDs never participate in the live-file set', async () => {
      await withTmpDir(async (dir) => {
        const { dashboard, cleanup } = await startDashboard();
        try {
          dashboard.addManualFolder(dir);
          const filePath = await writeInterviewFile(
            dir,
            'fresh.md',
            'fresh-session',
          );
          pushLiveEntry(dashboard, 'recovered-other');
          const before = helperCalls.extractResumeSlug;
          await dashboard.refreshFiles();
          expect(helperCalls.extractResumeSlug - before).toBe(0);
          expect(dashboard.getState(recoveredID(filePath))).toBeDefined();
        } finally {
          cleanup();
        }
      });
    });
    test('scans the state cache once instead of once per file', async () => {
      await withTmpDir(async (tempDir) => {
        const { dashboard, cleanup } = await startDashboard();
        try {
          const FILE_COUNT = 12;
          const ENTRY_COUNT = 12;
          for (let i = 0; i < FILE_COUNT; i++) {
            await writeInterviewFile(
              tempDir,
              `interview-${i}.md`,
              `session-file-${i}`,
            );
          }

          dashboard.addManualFolder(tempDir);
          let pathReads = 0;
          for (let i = 0; i < ENTRY_COUNT; i++) {
            const id = `live-run-interview-${i}`;
            const filePath = path.join(
              interviewDirFor(tempDir),
              `interview-${i}.md`,
            );
            pushLiveEntry(dashboard, id, filePath);
            Object.defineProperty(dashboard.getState(id), 'filePath', {
              configurable: true,
              get: () => {
                pathReads++;
                return filePath;
              },
            });
          }
          pathReads = 0;
          await dashboard.refreshFiles();

          // One path read per live row, independent of the number of files.
          expect(pathReads).toBe(ENTRY_COUNT);
          for (let i = 0; i < FILE_COUNT; i++) {
            expect(
              dashboard.getState(
                recoveredID(
                  path.join(interviewDirFor(tempDir), `interview-${i}.md`),
                ),
              ),
            ).toBeUndefined();
          }
        } finally {
          cleanup();
        }
      });
    });

    test('still skips recovered entries for files covered by a live entry', async () => {
      await withTmpDir(async (tempDir) => {
        const { dashboard, cleanup } = await startDashboard();
        try {
          const filePath = await writeInterviewFile(
            tempDir,
            'covered-interview.md',
            'session-covered',
          );
          dashboard.registerSession({
            sessionID: 'session-covered',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'live-run-covered-interview', filePath);

          await dashboard.refreshFiles();

          expect(dashboard.getState(recoveredID(filePath))).toBeUndefined();
          expect(
            dashboard.getState('live-run-covered-interview'),
          ).toBeDefined();
        } finally {
          cleanup();
        }
      });
    });

    test('still rebuilds an entry when no live entry covers the file', async () => {
      await withTmpDir(async (tempDir) => {
        const { dashboard, cleanup } = await startDashboard();
        try {
          const filePath = await writeInterviewFile(
            tempDir,
            'orphan-interview.md',
            'session-x',
          );
          dashboard.registerSession({
            sessionID: 'session-x',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'live-run-unrelated-thing');

          await dashboard.refreshFiles();

          const recovered = dashboard.getState(recoveredID(filePath));
          expect(recovered).toBeDefined();
          expect(recovered?.mode).toBe('session-disconnected');
        } finally {
          cleanup();
        }
      });
    });
  });

  describe('session registration cache invalidation', () => {
    test('equal-title ordering follows reordered known directories', async () => {
      await withTmpDir(async (dirA) =>
        withTmpDir(async (dirB) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            const fileA = await writeInterviewFile(dirA, 'order-a.md', 'a');
            const fileB = await writeInterviewFile(dirB, 'order-b.md', 'b');
            await originalFs.writeFile(fileA, '# Equal title\n');
            await originalFs.writeFile(fileB, '# Equal title\n');
            const register = (sessionID: string, directory: string) =>
              dashboard.registerSession({
                sessionID,
                directory,
                pid: 0,
                registeredAt: Date.now(),
              });
            register('s1', dirA);
            register('s2', dirB);
            register('s3', dirA);
            await dashboard.refreshFiles();
            const orderedFiles = async () =>
              (await listFiles(baseUrl, authToken))
                .filter((f) => f.fileName.startsWith('order-'))
                .map((f) => f.fileName);
            expect(await orderedFiles()).toEqual(['order-a.md', 'order-b.md']);
            register('s1', dirB);
            expect(await orderedFiles()).toEqual(['order-b.md', 'order-a.md']);
            const before = fsCalls.readdir;
            register('s1', dirB);
            expect(await orderedFiles()).toEqual(['order-b.md', 'order-a.md']);
            expect(fsCalls.readdir - before).toBe(0);
          } finally {
            cleanup();
          }
        }),
      );
    });
    test('HTTP registration preserves cached scans and unregister/re-register refreshes them', async () => {
      await withTmpDir(async (dir) => {
        const { baseUrl, authToken, cleanup } = await startDashboard();
        const post = async (endpoint: string, body: object) => {
          const response = await fetch(
            `${baseUrl}/api/${endpoint}?token=${authToken}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
          expect(response.status).toBe(200);
        };
        try {
          await writeInterviewFile(dir, 'registered.md', 'registered');
          await post('register', { sessionID: 'registered', directory: dir });
          await listFiles(baseUrl, authToken);
          const before = fsCalls.readdir;
          await post('register', {
            sessionID: 'registered',
            directory: dir,
            pid: 42,
          });
          await listFiles(baseUrl, authToken);
          expect(fsCalls.readdir - before).toBe(0);
          await post('unregister', { sessionID: 'registered' });
          expect(
            (await listFiles(baseUrl, authToken)).some(
              (f) => f.fileName === 'registered.md',
            ),
          ).toBe(false);
          await post('register', { sessionID: 'registered', directory: dir });
          expect(
            (await listFiles(baseUrl, authToken)).some(
              (f) => f.fileName === 'registered.md',
            ),
          ).toBe(true);
        } finally {
          cleanup();
        }
      });
    });
    test('re-registering an already scanned directory does not rescan', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          await writeInterviewFile(tempDir, 'first.md', 'session-first');
          dashboard.registerSession({
            sessionID: 'session-a',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });

          const first = await listFiles(baseUrl, authToken);
          expect(first.some((f) => f.fileName === 'first.md')).toBe(true);

          const before = fsCalls.readdir;
          dashboard.registerSession({
            sessionID: 'session-b',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          const second = await listFiles(baseUrl, authToken);
          const rescans = fsCalls.readdir - before;

          expect(second.some((f) => f.fileName === 'first.md')).toBe(true);
          expect(rescans).toBe(0);
        } finally {
          cleanup();
        }
      });
    });

    test('re-registering the same session ID with a new directory rescans', async () => {
      await withTmpDir(async (tempDir) =>
        withTmpDir(async (secondDir) => {
          const { baseUrl, authToken, dashboard, cleanup } =
            await startDashboard();
          try {
            await writeInterviewFile(tempDir, 'first.md', 'session-first');
            dashboard.registerSession({
              sessionID: 'session-a',
              directory: tempDir,
              pid: 0,
              registeredAt: Date.now(),
            });
            await listFiles(baseUrl, authToken);

            await writeInterviewFile(secondDir, 'second.md', 'session-second');
            dashboard.registerSession({
              sessionID: 'session-a',
              directory: secondDir,
              pid: 0,
              registeredAt: Date.now(),
            });

            const files = await listFiles(baseUrl, authToken);
            expect(files.some((f) => f.fileName === 'second.md')).toBe(true);
          } finally {
            cleanup();
          }
        }),
      );
    });

    test('a newly registered session directory is discovered immediately', async () => {
      await withTmpDir(async (tempDir) =>
        withTmpDir(async (secondDir) => {
          const { baseUrl, authToken, dashboard, cleanup } =
            await startDashboard();
          try {
            await writeInterviewFile(tempDir, 'first.md', 'session-first');
            dashboard.registerSession({
              sessionID: 'session-a',
              directory: tempDir,
              pid: 0,
              registeredAt: Date.now(),
            });
            const before = await listFiles(baseUrl, authToken);
            expect(before.some((f) => f.fileName === 'second.md')).toBe(false);

            await writeInterviewFile(secondDir, 'second.md', 'session-second');
            dashboard.registerSession({
              sessionID: 'session-b',
              directory: secondDir,
              pid: 0,
              registeredAt: Date.now(),
            });

            const after = await listFiles(baseUrl, authToken);
            expect(after.some((f) => f.fileName === 'second.md')).toBe(true);
          } finally {
            cleanup();
          }
        }),
      );
    });

    test('removing a session that owned its directory rescans', async () => {
      await withTmpDir(async (tempDir) =>
        withTmpDir(async (secondDir) => {
          const { baseUrl, authToken, dashboard, cleanup } =
            await startDashboard();
          try {
            await writeInterviewFile(tempDir, 'first.md', 'session-first');
            await writeInterviewFile(secondDir, 'second.md', 'session-second');
            dashboard.registerSession({
              sessionID: 'session-a',
              directory: tempDir,
              pid: 0,
              registeredAt: Date.now(),
            });
            dashboard.registerSession({
              sessionID: 'session-b',
              directory: secondDir,
              pid: 0,
              registeredAt: Date.now(),
            });
            const before = await listFiles(baseUrl, authToken);
            expect(before.some((f) => f.fileName === 'second.md')).toBe(true);

            dashboard.removeSession('session-b');
            const after = await listFiles(baseUrl, authToken);
            expect(after.some((f) => f.fileName === 'second.md')).toBe(false);
          } finally {
            cleanup();
          }
        }),
      );
    });
  });

  describe('GET /state document reads', () => {
    test.each(['absent', 'non-directory'])(
      'confirmed missing ancestors still detect later creation (%s)',
      async (kind) => {
        await withTmpDir(async (project) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            const ancestor = path.join(project, '.local');
            if (kind === 'non-directory') {
              await originalFs.writeFile(ancestor, 'not a directory');
            }
            dashboard.addManualFolder(project);
            pushLiveEntry(dashboard, 'ancestor-retry');
            expect(
              (await getState(baseUrl, authToken, 'ancestor-retry')).document,
            ).toBe('');
            if (kind === 'non-directory') await originalFs.unlink(ancestor);
            const candidate = await writeInterviewFile(
              project,
              'ancestor-retry.md',
              's',
              'Ancestor created',
            );
            const resolved = await getState(
              baseUrl,
              authToken,
              'ancestor-retry',
            );
            expect(resolved.document).toContain('Ancestor created');
            expect(resolved.markdownPath).toBe(candidate);
          } finally {
            cleanup();
          }
        });
      },
    );
    for (const operation of ['stat', 'lstat'] as const) {
      const codes =
        operation === 'stat'
          ? ['EIO', 'EACCES', 'unknown', 'ENOENT', 'ENOTDIR']
          : ['EIO', 'EACCES', 'unknown'];
      test.each(codes)(
        `watch selection never ascends through uncertainty (${operation}: %s)`,
        async (code) => {
          await withTmpDir(async (project) => {
            const { dashboard, baseUrl, authToken, cleanup } =
              await startDashboard();
            try {
              const directory = interviewDirFor(project);
              await originalFs.mkdir(directory, { recursive: true });
              const parent = path.dirname(directory);
              dashboard.addManualFolder(project);
              pushLiveEntry(dashboard, 'watch-retry');
              let injected = 0;
              const failure = new Error('watch selection failed');
              if (code !== 'unknown') Object.assign(failure, { code });
              statFailure = (candidate) => {
                if (candidate !== directory) return undefined;
                statFailure = undefined;
                if (operation === 'lstat') {
                  return Object.assign(new Error('missing component'), {
                    code: 'ENOENT',
                  });
                }
                injected++;
                return failure;
              };
              if (operation === 'lstat') {
                lstatFailure = (candidate) => {
                  if (candidate !== directory) return undefined;
                  lstatFailure = undefined;
                  injected++;
                  return failure;
                };
              }
              expect(
                (await getState(baseUrl, authToken, 'watch-retry')).document,
              ).toBe('');
              expect(injected).toBe(1);
              const before = await originalFs.stat(parent, { bigint: true });
              const candidate = path.join(directory, 'watch-retry.md');
              await originalFs.writeFile(
                candidate,
                '# Created after failure\n',
              );
              const after = await originalFs.stat(parent, { bigint: true });
              for (const key of [
                'dev',
                'ino',
                'size',
                'mtimeNs',
                'ctimeNs',
              ] as const) {
                expect(after[key]).toBe(before[key]);
              }
              const resolved = await getState(
                baseUrl,
                authToken,
                'watch-retry',
              );
              expect(resolved.document).toBe('# Created after failure\n');
              expect(resolved.markdownPath).toBe(candidate);
            } finally {
              statFailure = undefined;
              lstatFailure = undefined;
              cleanup();
            }
          });
        },
      );
    }
    test('dangling directory symlinks are rechecked when their outside target appears', async () => {
      await withTmpDir(async (project) =>
        withTmpDir(async (outside) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            const directory = interviewDirFor(project);
            const parent = path.dirname(directory);
            const target = path.join(outside, 'target-directory');
            await originalFs.mkdir(parent, { recursive: true });
            await originalFs.symlink(target, directory);
            dashboard.addManualFolder(project);
            pushLiveEntry(dashboard, 'late-symlink');
            expect(
              (await getState(baseUrl, authToken, 'late-symlink')).document,
            ).toBe('');
            const version = await originalFs.stat(parent, { bigint: true });
            await originalFs.mkdir(target);
            await originalFs.writeFile(
              path.join(target, 'late-symlink.md'),
              '# Outside directory\n',
            );
            expect(
              (await originalFs.stat(parent, { bigint: true })).mtimeNs,
            ).toBe(version.mtimeNs);
            expect(
              (await getState(baseUrl, authToken, 'late-symlink')).document,
            ).toBe('# Outside directory\n');
          } finally {
            cleanup();
          }
        }),
      );
    });

    test.each(['EACCES', 'EIO'])(
      'fallback read failures are retried (%s)',
      async (code) => {
        await withTmpDir(async (dir) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            const filePath = await writeInterviewFile(
              dir,
              'retry.md',
              's',
              'Retry body',
            );
            dashboard.addManualFolder(dir);
            pushLiveEntry(dashboard, 'retry');
            pauseRead = async (candidate) => {
              if (candidate === filePath)
                throw Object.assign(new Error('read failed'), { code });
            };
            expect((await getState(baseUrl, authToken, 'retry')).document).toBe(
              '',
            );
            pauseRead = undefined;
            expect(
              (await getState(baseUrl, authToken, 'retry')).document,
            ).toContain('Retry body');
          } finally {
            pauseRead = undefined;
            cleanup();
          }
        });
      },
    );
    test('dangling symlink targets created outside the watched directory become visible', async () => {
      await withTmpDir(async (project) =>
        withTmpDir(async (outside) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            const directory = interviewDirFor(project);
            await originalFs.mkdir(directory, { recursive: true });
            const candidate = path.join(directory, 'symlink.md');
            const target = path.join(outside, 'target.md');
            await originalFs.symlink(target, candidate);
            dashboard.addManualFolder(project);
            pushLiveEntry(dashboard, 'symlink');
            expect(
              (await getState(baseUrl, authToken, 'symlink')).document,
            ).toBe('');
            const version = await originalFs.stat(directory, { bigint: true });
            await originalFs.writeFile(target, '# Outside target\n');
            expect(
              (await originalFs.stat(directory, { bigint: true })).mtimeNs,
            ).toBe(version.mtimeNs);
            const resolved = await getState(baseUrl, authToken, 'symlink');
            expect(resolved.document).toBe('# Outside target\n');
            expect(resolved.markdownPath).toBe(candidate);
            expect(dashboard.getState('symlink')?.filePath).toBe(candidate);
          } finally {
            cleanup();
          }
        }),
      );
    });

    test('document and path remain coherent across a concurrent HTTP state push', async () => {
      await withTmpDir(async (dir) => {
        const { dashboard, baseUrl, authToken, cleanup } =
          await startDashboard();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let pending: Promise<Awaited<ReturnType<typeof getState>>> | undefined;
        try {
          const fileA = await writeInterviewFile(
            dir,
            'a.md',
            'a',
            'Document A',
          );
          const fileB = await writeInterviewFile(
            dir,
            'b.md',
            'b',
            'Document B',
          );
          pushLiveEntry(dashboard, 'coherent', fileA);
          pauseRead = async (candidate) => {
            if (candidate !== fileA) return;
            entered.resolve();
            await release.promise;
          };
          pending = getState(baseUrl, authToken, 'coherent');
          await entered.promise;
          const push = await fetch(
            `${baseUrl}/api/interviews/coherent/state?token=${authToken}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ filePath: fileB }),
            },
          );
          expect(push.status).toBe(200);
          release.resolve();
          const state = await pending;
          expect(state.document).toContain('Document A');
          expect(state.markdownPath).toBe(fileA);
          expect(state.interview.markdownPath).toBe('a.md');
          expect(state.blocks).toEqual(
            originalDocument.parseSpecBlocks(state.document),
          );
          pauseRead = undefined;
          const next = await getState(baseUrl, authToken, 'coherent');
          expect(next.document).toContain('Document B');
          expect(next.markdownPath).toBe(fileB);
        } finally {
          release.resolve();
          pauseRead = undefined;
          await pending?.catch(() => {});
          cleanup();
        }
      });
    });
    test('external edits, replacements and deletion are immediately visible', async () => {
      await withTmpDir(async (dir) => {
        const { dashboard, baseUrl, authToken, cleanup } =
          await startDashboard();
        try {
          const filePath = await writeInterviewFile(dir, 'external.md', 's');
          pushLiveEntry(dashboard, 'external', filePath);
          await getState(baseUrl, authToken, 'external');
          await realFs.writeFile(
            filePath,
            '# Changed\n\n## Scope\n\nExternal edit',
          );
          const changed = await getState(baseUrl, authToken, 'external');
          expect(changed.document).toContain('External edit');
          expect(changed.blocks).toEqual(
            originalDocument.parseSpecBlocks(changed.document),
          );
          const replacement = `${filePath}.new`;
          await realFs.writeFile(replacement, '# Replaced');
          await realFs.rename(replacement, filePath);
          expect(
            (await getState(baseUrl, authToken, 'external')).document,
          ).toBe('# Replaced');
          const stat = await originalFs.stat(filePath);
          await realFs.writeFile(filePath, '# Modified');
          await realFs.utimes(filePath, stat.atime, stat.mtime);
          expect(
            (await getState(baseUrl, authToken, 'external')).document,
          ).toBe('# Modified');
          await realFs.unlink(filePath);
          expect(
            (await getState(baseUrl, authToken, 'external')).document,
          ).toBe('');
          await realFs.writeFile(filePath, '# Recreated');
          expect(
            (await getState(baseUrl, authToken, 'external')).document,
          ).toBe('# Recreated');
        } finally {
          cleanup();
        }
      });
    });

    test.each([false, true])(
      'fallback creation after a miss (existing directory: %s)',
      async (existingDirectory) => {
        await withTmpDir(async (dir) => {
          const { dashboard, baseUrl, authToken, cleanup } =
            await startDashboard();
          try {
            if (existingDirectory) {
              await realFs.mkdir(interviewDirFor(dir), { recursive: true });
            }
            dashboard.addManualFolder(dir);
            pushLiveEntry(dashboard, 'late-file');
            expect(
              (await getState(baseUrl, authToken, 'late-file')).document,
            ).toBe('');
            const before = helperCalls.extractResumeSlug;
            await getState(baseUrl, authToken, 'late-file');
            expect(helperCalls.extractResumeSlug - before).toBe(0);
            const filePath = await writeInterviewFile(
              dir,
              'late-file.md',
              'late',
              'Created after miss',
            );
            const state = await getState(baseUrl, authToken, 'late-file');
            expect(state.document).toContain('Created after miss');
            expect(state.markdownPath).toBe(filePath);
            expect(dashboard.getState('late-file')?.filePath).toBe(filePath);
          } finally {
            cleanup();
          }
        });
      },
    );

    test('fallback misses observe newly added session directories', async () => {
      await withTmpDir(async (dir) => {
        const { dashboard, baseUrl, authToken, cleanup } =
          await startDashboard();
        try {
          pushLiveEntry(dashboard, 'new-directory');
          await getState(baseUrl, authToken, 'new-directory');
          const filePath = await writeInterviewFile(
            dir,
            'new-directory.md',
            'late',
          );
          dashboard.registerSession({
            sessionID: 'late',
            directory: dir,
            pid: 0,
            registeredAt: Date.now(),
          });
          expect(
            (await getState(baseUrl, authToken, 'new-directory')).markdownPath,
          ).toBe(filePath);
        } finally {
          cleanup();
        }
      });
    });
    test('reuses the parsed document across repeated requests', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          const mdPath = await writeInterviewFile(
            tempDir,
            'cached-doc.md',
            'session-cached',
            'First body.',
          );
          dashboard.registerSession({
            sessionID: 'session-cached',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'cached-doc', mdPath);

          const first = await getState(baseUrl, authToken, 'cached-doc');
          expect(first.document).toContain('First body.');
          expect(first.blocks).toEqual([
            { id: 'section-0', title: 'Introduction', content: '# cached-doc' },
            {
              id: 'section-1',
              title: '1. Scope',
              content: '## 1. Scope\n\nFirst body.',
            },
          ]);
          expect(first.markdownPath).toBe(mdPath);

          const before = fsCalls.readFile;
          const statsBefore = fsCalls.stat;
          const parsesBefore = helperCalls.parseSpecBlocks;
          const second = await getState(baseUrl, authToken, 'cached-doc');
          const reads = fsCalls.readFile - before;

          expect(reads).toBe(0);
          expect(fsCalls.stat - statsBefore).toBe(1);
          expect(helperCalls.parseSpecBlocks - parsesBefore).toBe(0);
          expect(second.document).toBe(first.document);
          expect(second.blocks).toEqual(first.blocks);
          expect(second.markdownPath).toBe(first.markdownPath);
          expect(second.interview.markdownPath).toBe('cached-doc.md');
        } finally {
          cleanup();
        }
      });
    });

    test('re-reads the document after a state push announces new content', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          const mdPath = await writeInterviewFile(
            tempDir,
            'refreshed-doc.md',
            'session-refreshed',
            'First body.',
          );
          dashboard.registerSession({
            sessionID: 'session-refreshed',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'refreshed-doc', mdPath);

          const first = await getState(baseUrl, authToken, 'refreshed-doc');
          expect(first.document).toContain('First body.');

          await realFs.writeFile(
            mdPath,
            '# Refreshed\n\n## 1. Scope\n\n',
            'utf8',
          );
          dashboard.pushState({
            interviewId: 'refreshed-doc',
            sessionID: 'session-refreshed',
            idea: 'refreshed-doc',
            mode: 'awaiting-user',
            summary: 'Summary',
            title: 'refreshed-doc',
            questions: [],
            pendingAnswers: null,
            lastUpdatedAt: Date.now(),
            filePath: mdPath,
            nudgeAction: null,
          });

          const second = await getState(baseUrl, authToken, 'refreshed-doc');
          expect(second.document).toContain('# Refreshed');
        } finally {
          cleanup();
        }
      });
    });

    test('sweeps the known directories once when filePath is empty', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          dashboard.registerSession({
            sessionID: 'session-sweep',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'sweep-missing');

          const first = await getState(baseUrl, authToken, 'sweep-missing');
          expect(first.document).toBe('');
          expect(first.markdownPath).toBe('');

          const before = fsCalls.readFile;
          const second = await getState(baseUrl, authToken, 'sweep-missing');
          const reads = fsCalls.readFile - before;

          expect(second.document).toBe('');
          expect(reads).toBe(0);
        } finally {
          cleanup();
        }
      });
    });

    test('resolves a document found by the directory sweep exactly once', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          const mdPath = await writeInterviewFile(
            tempDir,
            'sweep-found.md',
            'session-found',
            'Swept body.',
          );
          dashboard.registerSession({
            sessionID: 'session-found',
            directory: tempDir,
            pid: 0,
            registeredAt: Date.now(),
          });
          pushLiveEntry(dashboard, 'sweep-found');

          const first = await getState(baseUrl, authToken, 'sweep-found');
          expect(first.document).toContain('Swept body.');
          expect(first.markdownPath).toBe(mdPath);

          const before = fsCalls.readFile;
          const second = await getState(baseUrl, authToken, 'sweep-found');
          const reads = fsCalls.readFile - before;

          expect(second.document).toBe(first.document);
          expect(second.markdownPath).toBe(mdPath);
          expect(reads).toBe(0);
        } finally {
          cleanup();
        }
      });
    });

    test('a missing document still reports the entry filePath', async () => {
      await withTmpDir(async (tempDir) => {
        const { baseUrl, authToken, dashboard, cleanup } =
          await startDashboard();
        try {
          const mdPath = path.join(interviewDirFor(tempDir), 'gone.md');
          pushLiveEntry(dashboard, 'gone-doc', mdPath);

          const state = await getState(baseUrl, authToken, 'gone-doc');
          expect(state.document).toBe('');
          expect(state.markdownPath).toBe(mdPath);
          expect(state.interview.markdownPath).toBe('gone.md');
        } finally {
          cleanup();
        }
      });
    });
  });
});
