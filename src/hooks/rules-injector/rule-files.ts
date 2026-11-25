import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectResourceRoot } from '../../config/project-resource-paths';
import { parseFrontmatter } from '../../utils/frontmatter';
import type { RuleCandidate, RuleMetadata } from './types';

function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function readMetadata(value: Record<string, string>): RuleMetadata {
  const alwaysApply = value.alwaysApply?.toLowerCase();
  return {
    ...(alwaysApply === 'true' || alwaysApply === 'false'
      ? { alwaysApply: alwaysApply === 'true' }
      : {}),
    ...(value.globs !== undefined ? { globs: value.globs } : {}),
    ...(value.paths !== undefined ? { paths: value.paths } : {}),
    ...(value.applyTo !== undefined ? { applyTo: value.applyTo } : {}),
  };
}

const RULE_FILE_PATTERN = /\.(?:md|mdc)$/i;

/** @internal Exported for tests to pin the discovery walk order. */
export function listRuleFiles(directory: string): readonly string[] {
  const files: string[] = [];
  collectRuleFiles(directory, files);
  return files;
}

// One accumulator threaded through the recursion yields the same
// depth-first order as the previous per-level `push(...listFiles(sub))`, but
// without copying each descendant list at every level.
function collectRuleFiles(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) collectRuleFiles(path, files);
    else if (entry.isFile() && RULE_FILE_PATTERN.test(entry.name))
      files.push(path);
  }
}

/** Discover plugin-owned markdown rules below the already-confined roots. */
export function discoverRuleCandidates(
  roots: readonly ProjectResourceRoot[],
  projectBoundary?: string,
): readonly RuleCandidate[] {
  const candidates: RuleCandidate[] = [];
  for (const root of roots) {
    let files: readonly string[];
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(root.path);
      if (projectBoundary && !root.global) {
        const local = relative(projectBoundary, canonicalRoot);
        if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
          continue;
      }
      files = listRuleFiles(root.path);
    } catch (error) {
      if (isFilesystemError(error)) continue;
      throw error;
    }
    for (const path of [...files].sort(compareCodePoints)) {
      try {
        if (!lstatSync(path).isFile()) continue;
        const realPath = realpathSync(path);
        const location = relative(root.path, path);
        if (realPath !== resolve(canonicalRoot, location)) continue;
        const source = readFileSync(realPath, 'utf8');
        const relativePath = [root.relativePath, location]
          .filter(Boolean)
          .join('/')
          .split(sep)
          .join('/');
        // An empty file is not a rule, but it is a deliberate override: it
        // exists to shadow a same-named global rule. It has to survive
        // discovery and win the registry for that filename, so it registers
        // with no frontmatter, no body, and no selector -- `matchRulesForFile`
        // drops it after the override is decided and the global body goes with
        // it. Every other frontmatter-less file stays skipped.
        if (source.trim() === '') {
          candidates.push({
            path,
            realPath,
            relativePath,
            body: '',
            contentHash: createHash('sha256').digest('hex'),
            metadata: {},
            prefixIndex: root.prefixIndex,
            depth: root.depth,
            global: root.global === true,
          });
          continue;
        }
        const frontmatter = parseFrontmatter(source);
        if (!frontmatter) continue;
        const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        if (!match) continue;
        const rawMetadata = match[0].split(/\r?\n/).slice(1, -2);
        if (
          rawMetadata.some(
            (line) =>
              line.trim() !== '' && !/^\s*(?:#|[A-Za-z0-9_-]+\s*:)/.test(line),
          )
        )
          continue;
        const body = source.slice(match[0].length);
        candidates.push({
          path,
          realPath,
          relativePath,
          body,
          contentHash: createHash('sha256').update(body).digest('hex'),
          metadata: readMetadata(frontmatter),
          prefixIndex: root.prefixIndex,
          depth: root.depth,
          global: root.global === true,
        });
      } catch (error) {
        if (isFilesystemError(error)) continue;
        throw error;
      }
    }
  }
  return candidates;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
