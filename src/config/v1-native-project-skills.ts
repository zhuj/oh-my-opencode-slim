import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
} from '../utils/skill-policy-validation';

const NATIVE_SKILL_ROOTS = [
  ['.opencode', 'skills'],
  ['.opencode', 'skill'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
] as const;

/** Names-only inventory for avoiding collisions with V1 native project skills. */
export function discoverV1NativeProjectSkills(projectDirectory: string): {
  readonly hostOwnedSkillRoots: readonly string[];
  readonly hostSkillNames: readonly string[];
} {
  let project: string;
  try {
    project = fs.realpathSync(projectDirectory);
  } catch {
    project = path.resolve(projectDirectory);
  }
  const roots = NATIVE_SKILL_ROOTS.flatMap((parts) => {
    const expected = path.join(project, ...parts);
    try {
      if (!fs.lstatSync(expected).isDirectory()) return [];
      return fs.realpathSync(expected) === expected ? [expected] : [];
    } catch {
      return [];
    }
  });
  const names = new Set<string>();
  for (const root of roots) {
    const visit = (directory: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(child, { withFileTypes: true });
        } catch {
          continue;
        }
        const skill = files.find(
          (file) => file.name === 'SKILL.md' && file.isFile(),
        );
        if (skill) {
          try {
            const name = parseFrontmatter(
              fs.readFileSync(path.join(child, 'SKILL.md'), 'utf8'),
            )?.name?.trim();
            assertSkillIdentifier(
              name || path.basename(child),
              'V1 native project skill identity',
            );
            if (name) names.add(name);
          } catch (error) {
            if (error instanceof InvalidSkillPolicyError) throw error;
            /* Ignore malformed or unreadable host skill metadata. */
          }
        }
        visit(child);
      }
    };
    try {
      if (fs.lstatSync(root).isDirectory() && fs.realpathSync(root) === root) {
        visit(root);
      }
    } catch (error) {
      if (error instanceof InvalidSkillPolicyError) throw error;
      // Missing or inaccessible native roots contribute no names.
    }
  }
  return { hostOwnedSkillRoots: roots, hostSkillNames: [...names].sort() };
}
