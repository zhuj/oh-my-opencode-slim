import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withTmpDir } from '../test-utils';
import {
  createInterviewDirectoryPath,
  createInterviewFilePath,
  normalizeOutputFolder,
  withInterviewDocumentLock,
} from './document';

async function withTempDir<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  return withTmpDir(operation);
}

describe('interview artifact paths', () => {
  test('prefixes a nested configured folder under project .local', () => {
    const projectDirectory = path.join('workspace', 'project');

    const artifactDirectory = createInterviewDirectoryPath(
      projectDirectory,
      'specs/interviews',
    );

    expect(artifactDirectory).toBe(
      path.join(projectDirectory, '.local', 'specs', 'interviews'),
    );
  });

  test('does not duplicate an existing .local prefix', () => {
    const configuredFolder = '.local/specs/interviews';

    const normalized = normalizeOutputFolder(configuredFolder);

    expect(normalized).toBe(path.join('.local', 'specs', 'interviews'));
  });

  test('keeps a new document lock under the interview artifact root', async () => {
    await withTempDir(async (projectDirectory) => {
      const markdownPath = createInterviewFilePath(
        projectDirectory,
        'interview',
        'Lock location',
        'fixed-id',
      );
      const lockPath = `${markdownPath}.lock`;

      const lockWasCreated = await withInterviewDocumentLock(
        markdownPath,
        async () => (await fs.stat(lockPath)).isFile(),
      );

      expect(
        markdownPath.startsWith(path.join(projectDirectory, '.local')),
      ).toBe(true);
      expect(lockWasCreated).toBe(true);
    });
  });
});
