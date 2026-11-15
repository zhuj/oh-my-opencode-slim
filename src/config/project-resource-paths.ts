import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { getConfigSearchDirs } from './paths';

export const DEFAULT_RESOURCE_PREFIXES = [
  '.local',
  '.local/.slim',
  '.opencode',
] as const;

export const PROJECT_RESOURCE_CATEGORIES = [
  'rules',
  'skills',
  'commands',
  'agents',
] as const;

export type ProjectResourceCategory =
  (typeof PROJECT_RESOURCE_CATEGORIES)[number];

export type ProjectResourceRoot = {
  readonly path: string;
  readonly relativePath: string;
  readonly ancestor: string;
  /**
   * Specificity of {@link ancestor}, as returned by `computeResourceDepth`.
   * Replaces the former hop counter: ascending depth is generic-to-specific,
   * and a deeper ancestor is more specific without any stored tie-break.
   */
  readonly depth: number;
  readonly prefix: string;
  readonly prefixIndex: number;
  readonly category: ProjectResourceCategory;
  /**
   * Marks a root that lives in the user-global config directory rather than
   * inside the project boundary. Global roots bypass the boundary walk that
   * `resolveProjectResourceRoots` performs, so they are built separately and
   * sorted ahead of project roots by the rules matcher.
   */
  readonly global?: boolean;
};

export type ResolveProjectResourceRootsOptions = {
  readonly activeDirectory: string;
  readonly boundaryDirectory: string;
  readonly prefixes: readonly string[];
  readonly category: ProjectResourceCategory;
};

export function normalizeResourcePrefixes(
  configured: readonly string[] | undefined,
): readonly string[] {
  const prefixes = configured ?? DEFAULT_RESOURCE_PREFIXES;
  const unique = new Set<string>();
  for (const prefix of prefixes) {
    const normalized = prefix.replace(/[\\/]+$/, '');
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function isWithin(candidate: string, boundary: string): boolean {
  const path = relative(boundary, candidate);
  return (
    path === '' ||
    (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  );
}

/**
 * Depth of a root that lives under an OpenCode config directory.
 *
 * Deliberately the smallest possible number: those roots are shared by every
 * project on the machine, so they are the least specific resource there is and
 * must sort ahead of everything a project owns.
 */
export const OPENCODE_CONFIG_DEPTH = -32768;

/**
 * Offset subtracted from the hop count of a root outside the home directory.
 *
 * It parks every non-home root below every home-based one while leaving their
 * relative order untouched, because the hop count is still what separates them.
 */
const NON_HOME_DEPTH_OFFSET = 24578;

export type ComputeResourceDepthOptions = {
  /**
   * Hop count to use for a root outside the home directory. Defaults to the
   * root's own segment count. Supply it when the caller already knows how many
   * hops separate the root from its boundary and that is the meaningful
   * measure; an absolute segment count is only a stand-in.
   */
  readonly givenPathHops?: number;
};

function hopCount(segments: string): number {
  return segments.split(sep).filter(Boolean).length;
}

/**
 * How specific a directory is: how deep it sits under the home directory.
 *
 * Home is depth 0, so `~/work` is 1 and `~/work/proj` is 2. Deeper is
 * more specific, which makes ascending depth exactly "most generic first, most
 * specific last" -- the order injected context wants. `a/.../b` is more specific
 * than `a` because it carries more hops, not because of any stored counter.
 *
 * Two bands sit outside that scale. Roots under an OpenCode config directory
 * are shared machine state and take {@link OPENCODE_CONFIG_DEPTH}. Roots that
 * are not under the home directory take their hop count minus
 * {@link NON_HOME_DEPTH_OFFSET}, so they rank below home-based roots instead of
 * comparing against a count measured from an unrelated filesystem root.
 *
 * Symlinks are not resolved. `a/b/c/d/e` scores as written even when
 * `a/b/c` points somewhere else, because the path the project configured is
 * the identity the depth describes.
 */
export function computeResourceDepth(
  target: string,
  options: ComputeResourceDepthOptions = {},
): number {
  for (const configDir of getConfigSearchDirs()) {
    if (target === configDir || isWithin(target, configDir))
      return OPENCODE_CONFIG_DEPTH;
  }
  const home = homedir();
  if (target === home) return 0;
  if (isWithin(target, home)) return hopCount(relative(home, target));
  const hops = options.givenPathHops ?? hopCount(target);
  return hops - NON_HOME_DEPTH_OFFSET;
}

function isSafeResourcePrefix(prefix: string): boolean {
  return (
    prefix.length > 0 &&
    !isAbsolute(prefix) &&
    !win32.isAbsolute(prefix) &&
    !prefix.includes('\0') &&
    !prefix.split(/[\\/]+/).includes('..')
  );
}

export function resolveProjectResourceRoots(
  options: ResolveProjectResourceRootsOptions,
): readonly ProjectResourceRoot[] {
  const prefixes = normalizeResourcePrefixes(options.prefixes).filter(
    isSafeResourcePrefix,
  );
  const boundary = realpathSync(options.boundaryDirectory);
  const active = realpathSync(options.activeDirectory);
  if (!isWithin(active, boundary)) return [];

  const ancestors: string[] = [];
  let current = active;
  while (isWithin(current, boundary)) {
    ancestors.push(current);
    if (current === boundary) break;
    const parent = resolve(current, '..');
    if (parent === current) return [];
    current = parent;
  }

  const roots: ProjectResourceRoot[] = [];
  const seen = new Set<string>();
  for (
    let ancestorIndex = 0;
    ancestorIndex < ancestors.length;
    ancestorIndex += 1
  ) {
    const ancestor = ancestors[ancestorIndex];
    if (ancestor === undefined) continue;
    for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex += 1) {
      const prefix = prefixes[prefixIndex];
      if (prefix === undefined) continue;
      const candidate = resolve(ancestor, prefix, options.category);
      if (!existsSync(candidate) || !statSync(candidate).isDirectory())
        continue;
      // Realpath decides containment and identity only. The stored path keeps
      // the spelling the ancestor gives it, so a symlinked prefix stays
      // `a/b/c/d/e` instead of collapsing into whatever `a/b/c` points at.
      const canonical = realpathSync(candidate);
      if (!isWithin(canonical, boundary) || seen.has(canonical)) continue;
      seen.add(canonical);
      roots.push({
        path: candidate,
        relativePath: relative(boundary, candidate),
        ancestor,
        depth: computeResourceDepth(ancestor),
        prefix,
        prefixIndex,
        category: options.category,
      });
    }
  }
  return roots;
}
