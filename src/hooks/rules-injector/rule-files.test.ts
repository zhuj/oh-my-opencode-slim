import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ProjectResourceRoot } from '../../config/project-resource-paths';
import { createTmpDir, removeTmpDir } from '../../test-utils';
import { discoverRuleCandidates, listRuleFiles } from './rule-files';

function withTempDir<T>(run: (root: string) => T): T {
  const root = createTmpDir();
  try {
    return run(root);
  } finally {
    removeTmpDir(root);
  }
}

function writeRule(root: string, file: string, body: string): string {
  const filePath = join(root, file);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, body);
  return filePath;
}

// Independent oracle mirroring the original per-level algorithm
// (`push(...listFiles(sub))`), used instead of a hardcoded order because
// readdir order is hash-based and must not be assumed.
function expectedWalk(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) expectedWalk(path, files);
    else if (entry.isFile() && /\.(?:md|mdc)$/i.test(entry.name))
      files.push(path);
  }
  return files;
}

function nestedFixture(root: string): string {
  const rules = join(root, 'rules');
  writeRule(rules, 'a.md', '---\nalwaysApply: true\n---\na');
  writeRule(rules, 'b.mdc', '---\nalwaysApply: true\n---\nb');
  writeRule(rules, 'notes.txt', 'ignored');
  writeRule(rules, 'nested/deep/c.md', '---\nalwaysApply: true\n---\nc');
  writeRule(rules, 'nested/deep/deeper/d.md', '---\nalwaysApply: true\n---\nd');
  writeRule(rules, 'nested/skip/e.MD', '---\nalwaysApply: true\n---\ne');
  writeRule(rules, 'nested/empty-dir/.keep', 'ignored');
  mkdirSync(join(rules, 'nested/empty-dir'), { recursive: true });
  return rules;
}

describe('listRuleFiles', () => {
  test('walks nested fixtures in the same depth-first order as the oracle', () => {
    withTempDir((root) => {
      const rules = nestedFixture(root);

      expect(listRuleFiles(rules)).toEqual(expectedWalk(rules));
    });
  });

  test('skips symlinked files and directories just like the oracle', () => {
    withTempDir((root) => {
      const rules = nestedFixture(root);
      const outside = join(root, 'outside');
      writeRule(outside, 'outside.md', '---\nalwaysApply: true\n---\no');
      symlinkSync(join(outside, 'outside.md'), join(rules, 'linked.md'));
      symlinkSync(outside, join(rules, 'linked-dir'));

      const found = listRuleFiles(rules);

      expect(found).toEqual(expectedWalk(rules));
      expect(found.some((path) => path.includes('linked'))).toBe(false);
      expect(found.some((path) => path.endsWith('.txt'))).toBe(false);
      expect(found.every((path) => /\.(?:md|mdc)$/i.test(path))).toBe(true);
    });
  });

  test('returns a fresh array per call and does not leak between calls', () => {
    withTempDir((root) => {
      const rules = nestedFixture(root);
      const expected = expectedWalk(rules);

      const first = listRuleFiles(rules);
      const mutated = [...first];
      mutated.push(join(rules, 'injected.md'));
      const second = listRuleFiles(rules);

      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(second).not.toBe(first);
      expect([...first]).toHaveLength(expected.length);
    });
  });
});

describe('discoverRuleCandidates', () => {
  test('loads nested markdown rule files and ignores malformed frontmatter', () => {
    withTempDir((root) => {
      const rules = join(root, 'rules');
      writeRule(rules, 'base.md', '---\nalwaysApply: true\n---\nbase');
      writeRule(
        rules,
        'nested/typed.mdc',
        '---\nglobs: "src/**/*.ts"\n---\ntyped',
      );
      writeRule(rules, 'bad.md', '---\n[invalid\n---\nbad');
      writeRule(rules, 'ignored.txt', '---\nalwaysApply: true\n---\nignored');
      const external = join(root, 'outside-dir');
      const externalRule = writeRule(
        external,
        'outside.md',
        '---\nalwaysApply: true\n---\noutside',
      );
      symlinkSync(externalRule, join(rules, 'linked.md'));
      symlinkSync(external, join(rules, 'linked-dir'));
      const candidateRoot: ProjectResourceRoot = {
        path: rules,
        relativePath: 'rules',
        ancestor: root,
        depth: 1,
        prefix: '.local',
        prefixIndex: 0,
        category: 'rules',
      };

      const rulesFound = discoverRuleCandidates([candidateRoot]);

      expect(rulesFound.map((rule) => rule.relativePath)).toEqual([
        'rules/base.md',
        'rules/nested/typed.mdc',
      ]);
    });
  });

  test('keeps an empty rule file as a shadow candidate', () => {
    withTempDir((root) => {
      const rules = join(root, 'rules');
      writeRule(rules, 'base.md', '---\nalwaysApply: true\n---\nbase');
      writeRule(rules, 'team.md', '');
      writeRule(rules, 'prose.md', 'no frontmatter here');
      const candidateRoot: ProjectResourceRoot = {
        path: rules,
        relativePath: 'rules',
        ancestor: root,
        depth: 1,
        prefix: '.local',
        prefixIndex: 0,
        category: 'rules',
      };

      const found = discoverRuleCandidates([candidateRoot]);

      // An empty file is an override rather than a rule: it has to survive
      // discovery so it can claim a filename against a global rule. A
      // frontmatter-less file with real content stays skipped.
      expect(found.map((rule) => rule.relativePath)).toEqual([
        'rules/base.md',
        'rules/team.md',
      ]);
      expect(
        found.find((rule) => rule.relativePath === 'rules/team.md'),
      ).toMatchObject({ body: '', metadata: {} });
    });
  });

  test('preserves resolver root priority while sorting within each root', () => {
    withTempDir((root) => {
      const first = join(root, 'first');
      const second = join(root, 'second');
      writeRule(first, 'z.md', '---\nalwaysApply: true\n---\nz');
      writeRule(first, 'a.md', '---\nalwaysApply: true\n---\na');
      writeRule(second, '0.md', '---\nalwaysApply: true\n---\n0');
      const roots = [first, second].map((path, prefixIndex) => ({
        path,
        relativePath: prefixIndex === 0 ? 'first' : 'second',
        ancestor: root,
        depth: 1,
        prefix: 'rules',
        prefixIndex,
        category: 'rules' as const,
      }));
      expect(
        discoverRuleCandidates(roots).map(
          (candidate) => candidate.relativePath,
        ),
      ).toEqual(['first/a.md', 'first/z.md', 'second/0.md']);
    });
  });
});
