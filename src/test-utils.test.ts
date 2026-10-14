/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir, withTmpDir } from './test-utils';

test('withTmpDir cleans up after a successful callback', async () => {
  let tmp = '';

  const created = await withTmpDir(async (directory) => {
    tmp = directory;
    await writeFile(join(directory, 'fixture.txt'), 'fixture');
    return access(join(directory, 'fixture.txt')).then(() => true);
  });

  expect(created).toBe(true);
  await expect(access(tmp)).rejects.toThrow();
});

test('withTmpDir cleans up after a failing callback', async () => {
  let tmp = '';

  await expect(
    withTmpDir(async (directory) => {
      tmp = directory;
      throw new Error('fixture failure');
    }),
  ).rejects.toThrow('fixture failure');

  await expect(access(tmp)).rejects.toThrow();
});

test('createTmpDir rejects prefixes that are not one path component', () => {
  for (const prefix of [
    '',
    '.',
    '..',
    '../outside',
    'nested/name',
    'bad\\name',
    'bad\0name',
  ]) {
    expect(() => createTmpDir(prefix)).toThrow();
  }
});

test('removeTmpDir rejects paths outside the system temporary root', () => {
  expect(() => removeTmpDir('/')).toThrow('outside test scratch root');
});
