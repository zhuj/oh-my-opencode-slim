import { describe, expect, test } from 'bun:test';
import { createTimerHarness } from '../utils/test-timers';
import {
  createV1RemainingContextTokensReader,
  resolveV1TouchedFilePaths,
} from './rules-context-usage';

describe('V1 context usage', () => {
  test('resolves latest assistant input against its model context limit (SDK 1.18.32 top-level)', async () => {
    const timers = createTimerHarness();
    const reader = createV1RemainingContextTokensReader(
      async () => ({
        data: [
          {
            info: {
              role: 'assistant',
              tokens: { input: 3200 },
              modelID: 'm',
              providerID: 'p',
            },
          },
        ],
      }),
      async () => ({
        data: {
          all: [{ id: 'p', models: { m: { limit: { context: 8192 } } } }],
        },
      }),
      timers,
    );
    await expect(reader('private')).resolves.toBe(4992);
    expect(timers.pending()).toBe(0);
  });

  test.each(['messages', 'catalog'])(
    'bounds a nonsettling %s lookup and releases its timer',
    async (pendingSource) => {
      const timers = createTimerHarness();
      const never = new Promise<never>(() => {});
      const reader = createV1RemainingContextTokensReader(
        async () => (pendingSource === 'messages' ? never : { data: [] }),
        async () => (pendingSource === 'catalog' ? never : {}),
        timers,
      );
      let completed = false;
      const read = reader('private').then((value) => {
        completed = true;
        return value;
      });
      await timers.advance(1_999);
      expect(completed).toBe(false);
      await timers.advance(1);
      await expect(read).resolves.toBeNull();
      expect(timers.pending()).toBe(0);
    },
  );
  test('fails soft for missing values, errors and clamps capacity at zero', async () => {
    const empty = createV1RemainingContextTokensReader(
      async () => ({ data: [] }),
      async () => ({}),
    );
    await expect(empty('private')).resolves.toBeNull();
    const failing = createV1RemainingContextTokensReader(
      async () => {
        throw Error();
      },
      async () => ({}),
    );
    await expect(failing('private')).resolves.toBeNull();
    const over = createV1RemainingContextTokensReader(
      async () => ({
        data: [
          {
            info: {
              role: 'assistant',
              tokens: { input: 9 },
              modelID: 'm',
              providerID: 'p',
            },
          },
        ],
      }),
      async () => ({
        data: { all: [{ id: 'p', models: { m: { limit: { context: 8 } } } }] },
      }),
    );
    await expect(over('private')).resolves.toBe(0);
  });
});

describe('V1 resolved touched paths', () => {
  test('ignores raw args/title and projects only absolute path list entries', () => {
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'read', args: { filePath: '/bad' } },
        { title: '/bad' },
      ),
    ).toEqual([]);
    expect(
      resolveV1TouchedFilePaths(
        {},
        { resolvedFilePaths: ['/ok', 'relative', 1] },
      ),
    ).toEqual(['/ok']);
  });
  test('uses pinned result fields and rejects directory reads', () => {
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'read' },
        { metadata: { display: { type: 'file', path: '/read' } } },
      ),
    ).toEqual(['/read']);
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'read' },
        { metadata: { display: { type: 'directory', path: '/dir' } } },
      ),
    ).toEqual([]);
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'write' },
        { metadata: { filepath: '/write' } },
      ),
    ).toEqual(['/write']);
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'edit' },
        { metadata: { filediff: { file: '/edit' } } },
      ),
    ).toEqual(['/edit']);
    expect(
      resolveV1TouchedFilePaths(
        { tool: 'apply_patch' },
        {
          metadata: {
            files: [{ filePath: '/a' }, { filePath: '/old', movePath: '/new' }],
          },
        },
      ),
    ).toEqual(['/a', '/old', '/new']);
  });
});
