import { basename as pathBasename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { MatchedRule, RuleCandidate } from './types';

function strings(
  value: string | readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

function pathSegments(value: string): string[] {
  return value.split(sep).filter(Boolean);
}

type GlobMatcher = (path: string) => boolean;
type GlobCompiler = (pattern: string) => GlobMatcher;

function globMatcher(pattern: string): GlobMatcher {
  return picomatch(pattern, { dot: true, bash: true });
}

/**
 * Index of the first pattern matching any path, or -1 when none matches.
 *
 * Compilation is lazy: a pattern is compiled at the moment it is first
 * reached, and the walk returns as soon as one matches, so a pattern the
 * result never depends on is never compiled and cannot throw. Compiling
 * eagerly instead (a `map(compile)` over the whole list) would both pay for
 * unused patterns and let a malformed one after the winner fail the call.
 *
 * Each reached pattern is still compiled only once. picomatch compiles the
 * pattern to a RegExp once inside its factory and only closes over it; these
 * options never add a /g or /y flag, so `exec` cannot advance `lastIndex` and
 * a compiled matcher is safe to reuse for every path. The win is therefore
 * once per reached pattern rather than once per path.
 */
function firstMatchingIndex(
  patterns: readonly string[],
  paths: readonly string[],
  compile: GlobCompiler,
): number {
  for (let index = 0; index < patterns.length; index += 1) {
    const matcher = compile(patterns[index]);
    for (const path of paths) {
      if (matcher(path)) return index;
    }
  }
  return -1;
}

/**
 * @internal `compile` is a seam so tests can count glob compilations, which
 * cannot be observed without module-level instrumentation.
 */
export function matchSelectors(
  selectors: readonly string[],
  paths: readonly string[],
  compile: GlobCompiler = globMatcher,
): string | undefined {
  const positives = selectors.filter((selector) => !selector.startsWith('!'));
  if (positives.length === 0) return undefined;
  const positiveIndex = firstMatchingIndex(positives, paths, compile);
  if (positiveIndex === -1) return undefined;
  const negatives = selectors
    .filter((selector) => selector.startsWith('!'))
    .map((selector) => selector.slice(1));
  // The positive walk already proved a match and identified which pattern won,
  // so the winner is returned directly instead of re-scanning with `find`.
  if (firstMatchingIndex(negatives, paths, compile) !== -1) return undefined;
  return positives[positiveIndex];
}

/** A rule's identity for override purposes: its filename alone. */
function localFilename(rule: RuleCandidate): string {
  return pathBasename(rule.path);
}

/**
 * Keep the most specific rule per local filename. A project rule overrides a
 * global one that shares its filename, and an empty rule file shadows a global
 * rule entirely: it has no body, so once it wins the override the global body
 * is never injected.
 *
 * Specificity is the rule root's depth, which is a property of the directory
 * alone. A global root sits in a config directory and therefore holds
 * `OPENCODE_CONFIG_DEPTH`, the smallest depth there is, so a project rule wins
 * its filename without either rule knowing anything about the touched file.
 */
function buildRegistry(
  rules: readonly RuleCandidate[],
): readonly RuleCandidate[] {
  const byLocalFilename = new Map<string, RuleCandidate>();
  for (const rule of rules) {
    const key = localFilename(rule);
    const held = byLocalFilename.get(key);
    if (held === undefined) {
      byLocalFilename.set(key, rule);
      continue;
    }
    if (
      rule.depth > held.depth ||
      (rule.depth === held.depth && held.global && !rule.global)
    )
      byLocalFilename.set(key, rule);
  }
  return [...byLocalFilename.values()];
}

/** Match rules and order them by scope distance, prefix, then stable path. */
export function matchRulesForFile(
  rules: readonly RuleCandidate[],
  touchedFilePath: string,
  projectBoundary: string,
): readonly MatchedRule[] {
  const boundaryRelative = relative(projectBoundary, touchedFilePath);
  if (
    boundaryRelative === '..' ||
    boundaryRelative.startsWith(`..${sep}`) ||
    boundaryRelative.startsWith(sep)
  )
    return [];
  const touchedRelative = boundaryRelative.split(sep).join('/');
  const basename = touchedRelative.split('/').at(-1) ?? touchedRelative;
  const selectorPaths = [touchedRelative, basename];
  const touchedDirectoryRelative = relative(
    projectBoundary,
    touchedFilePath.slice(0, touchedFilePath.lastIndexOf(sep)),
  );
  const matches: MatchedRule[] = [];
  for (const rule of buildRegistry(rules)) {
    let reason: string | undefined;
    if (rule.metadata.alwaysApply === true) reason = 'alwaysApply';
    else {
      const fields = [
        [rule.metadata.globs, 'glob'],
        [rule.metadata.paths, 'glob'],
        [rule.metadata.applyTo, 'applyTo'],
      ] as const;
      const matched = matchSelectors(
        fields.flatMap(([field]) => strings(field)),
        selectorPaths,
      );
      if (matched !== undefined) {
        const label = fields.find(([field]) =>
          strings(field).includes(matched),
        )?.[1];
        reason = `${label ?? 'glob'}: ${matched}`;
      }
    }
    if (reason === undefined) continue;
    const ruleSegments = pathSegments(relative(projectBoundary, rule.path));
    const touchedDirectorySegments = pathSegments(touchedDirectoryRelative);
    let shared = 0;
    while (
      shared < ruleSegments.length &&
      shared < touchedDirectorySegments.length &&
      ruleSegments[shared] === touchedDirectorySegments[shared]
    )
      shared += 1;
    // Project rules are re-labelled relative to the touched file's shared
    // prefix. Global rules keep the discovery-time `global-rules/...` label:
    // the derived form would escape the project root as a `..`-laden path and
    // that string is what gets rendered into the injected rule heading.
    const ruleRelative = rule.global
      ? rule.relativePath
      : ruleSegments.slice(shared).join('/');
    matches.push({
      ...rule,
      relativePath: ruleRelative,
      reason,
    });
  }
  // Least specific first, so the most specific rule lands last and reads as
  // the final word on the touched file. `depth` counts hops below the home
  // directory, so a LARGER value means DEEPER and therefore more specific:
  // ascending depth is exactly generic-to-specific. A global rule sits in a
  // config directory and holds the smallest depth there is, so it leads without
  // needing its own sort key.
  return matches.sort(
    (left, right) =>
      left.depth - right.depth ||
      left.prefixIndex - right.prefixIndex ||
      compareCodePoints(localFilename(left), localFilename(right)),
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
