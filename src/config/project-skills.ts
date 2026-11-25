import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
} from '../utils/skill-policy-validation';
import { getProjectConfigDirectories } from './loader';
import type { ProjectResourceRoot } from './project-resource-paths';

export interface ProjectSkillCandidate {
  readonly name: string;
  readonly directory: string;
  readonly skillFilePath: string;
}

export type ProjectSkillDiagnosticCode =
  | 'duplicate-name'
  | 'host-name-conflict'
  | 'unreadable-root';

export interface ProjectSkillDiagnostic {
  readonly code: ProjectSkillDiagnosticCode;
  readonly path: string;
  readonly name?: string;
}

export interface ProjectSkillDiscoveryOptions {
  readonly projectDirectory: string;
  readonly resourcePrefixes: readonly string[];
  /** Canonical, project-confined roots returned by resolveProjectResourceRoots. */
  readonly resourceRoots: readonly ProjectResourceRoot[];
  readonly hostOwnedSkillRoots: readonly string[];
  readonly hostSkillNames: readonly string[];
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ProjectSkillDiscoveryResult {
  readonly skills: readonly ProjectSkillCandidate[];
  readonly permissionNames: readonly string[];
  readonly diagnostics: readonly ProjectSkillDiagnostic[];
}

/**
 * Discover valid skills in the current and ancestor project directories.
 *
 * This intentionally mirrors the ancestor-local `.opencode/skills` and
 * `.agents/skills` portions of OpenCode's broader skill discovery. Global
 * skills, external configured paths, and URL sources are outside this scope.
 */
export function discoverProjectLocalSkillNames(
  projectDirectory: string,
  hostFlavor?: string,
): string[] {
  const names = new Set<string>();
  for (const configDirectory of getProjectConfigDirectories(
    projectDirectory,
    hostFlavor,
  )) {
    const projectRoot = path.dirname(configDirectory);
    for (const skillDirectory of ['.opencode', '.agents'] as const) {
      for (const name of discoverLocalSkills(projectRoot, skillDirectory)) {
        names.add(name);
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function discoverLocalSkills(
  projectDirectory: string,
  skillDirectory: '.opencode' | '.agents',
): string[] {
  const configuredRoot = path.join(projectDirectory, skillDirectory, 'skills');
  let root: string;

  try {
    const canonicalProject = fs.realpathSync(projectDirectory);
    root = fs.realpathSync(configuredRoot);
    const expectedRoot = path.join(canonicalProject, skillDirectory, 'skills');

    // Keep the opt-in strictly project-local. In particular, do not let a
    // symlinked skill root turn this into discovery of
    // an external/global skill tree.
    if (root !== expectedRoot) {
      return [];
    }
  } catch {
    return [];
  }

  const names = new Set<string>();

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') {
        continue;
      }

      try {
        const content = fs
          .readFileSync(entryPath, 'utf-8')
          .replace(/^\uFEFF/, '');
        const name = parseFrontmatter(content)?.name?.trim();
        if (name && !name.startsWith('.')) {
          assertSkillIdentifier(name, entryPath);
          names.add(name);
        }
      } catch (error) {
        if (error instanceof InvalidSkillPolicyError) throw error;
        // OpenCode ignores unusable skill files during discovery; keep this
        // opt-in helper non-fatal for unreadable or malformed local files.
      }
    }
  };

  visit(root);
  return [...names].sort(compareCodePoints);
}

/** Discover plugin-owned skills without reading their content into output. */
export function discoverProjectSkills(
  options: ProjectSkillDiscoveryOptions,
): ProjectSkillDiscoveryResult {
  const localNames = discoverProjectLocalSkillNames(options.projectDirectory);
  const localNameSet = new Set(localNames);
  const hostNames = new Set([...options.hostSkillNames, ...localNames]);
  const hostRoots = new Set(
    options.hostOwnedSkillRoots.map((root) => path.resolve(root)),
  );
  const seenNames = new Set<string>();
  const skills: ProjectSkillCandidate[] = [];
  const diagnostics: ProjectSkillDiagnostic[] = [];

  if (options.resourcePrefixes.length > 0) {
    // `seenNames` is first-wins, so the most specific root must be visited
    // first. Descending depth is the reverse of the generic-to-specific order
    // resources are injected in, which is what puts the deepest ancestor
    // ahead; `prefixIndex` stays ascending so a configured prefix still
    // outranks a later one at equal depth.
    const rootsByDepth = [...options.resourceRoots].sort(
      (left, right) =>
        right.depth - left.depth || left.prefixIndex - right.prefixIndex,
    );
    for (const root of rootsByDepth) {
      if (
        root.category !== 'skills' ||
        hostRoots.has(path.resolve(root.path))
      ) {
        continue;
      }
      let directories: string[];
      try {
        directories = listSkillDirectories(root.path);
      } catch {
        if (fs.existsSync(root.path)) {
          diagnostics.push({ code: 'unreadable-root', path: root.path });
        }
        continue;
      }
      for (const directory of directories) {
        const skillFilePath = path.join(directory, 'SKILL.md');
        let isRegularFile: boolean;
        try {
          isRegularFile = fs.lstatSync(skillFilePath).isFile();
        } catch {
          continue;
        }
        if (!isRegularFile) {
          continue;
        }
        let name: string | undefined;
        try {
          const content = fs
            .readFileSync(skillFilePath, 'utf-8')
            .replace(/^\uFEFF/, '');
          name = parseFrontmatter(content)?.name?.trim();
        } catch {
          continue;
        }
        if (!name || name.startsWith('.')) continue;
        assertSkillIdentifier(name, skillFilePath);
        if (hostNames.has(name)) {
          diagnostics.push({
            code: 'host-name-conflict',
            path: skillFilePath,
            name,
          });
          continue;
        }
        if (seenNames.has(name)) {
          diagnostics.push({
            code: 'duplicate-name',
            path: skillFilePath,
            name,
          });
          continue;
        }
        seenNames.add(name);
        skills.push({ name, directory, skillFilePath });
      }
    }
  }

  const permissionNames = [...localNames];
  for (const skill of skills) {
    if (!localNameSet.has(skill.name)) permissionNames.push(skill.name);
  }
  return { skills, permissionNames, diagnostics };
}

function listSkillDirectories(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const directories: string[] = [];
  const visit = (directory: string, children: readonly fs.Dirent[]): void => {
    for (const entry of [...children].sort((a, b) =>
      compareCodePoints(a.name, b.name),
    )) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = path.join(directory, entry.name);
      directories.push(child);
      try {
        visit(child, fs.readdirSync(child, { withFileTypes: true }));
      } catch {
        // An inaccessible nested directory cannot contain a usable candidate.
      }
    }
  };
  visit(root, entries);
  return directories.sort(compareCodePoints);
}
