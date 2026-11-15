import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UNPREFIXED_SLIM_PATH = /(^|[^/])\.slim\/(deepwork|clonedeps|worktrees)/m;

test.each([
  ['deepwork', '.local/.slim/deepwork/'],
  ['clonedeps', '.local/.slim/clonedeps.json'],
  ['worktrees', '.local/.slim/worktrees.json'],
] as const)(
  '%s skill roots project artifacts under .local',
  (skillName, canonicalPath) => {
    // Given: the bundled skill instructions installed for users.
    const instructions = readFileSync(
      join(import.meta.dir, skillName, 'SKILL.md'),
      'utf8',
    );

    // When: the skill's project artifact paths are inspected.
    const unprefixedPath = instructions.match(UNPREFIXED_SLIM_PATH);

    // Then: the canonical path is present and no unprefixed legacy root remains.
    expect(instructions).toContain(canonicalPath);
    expect(unprefixedPath).toBeNull();
  },
);
