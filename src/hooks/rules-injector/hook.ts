import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectResourceRoot } from '../../config/project-resource-paths';
import { resolveProjectResourceRoots } from '../../config/project-resource-paths';
import { appendTaggedToolOutput } from '../cache-safe-injection';
import { resolveGlobalRuleRoots } from './global-roots';
import { matchRulesForFile } from './matcher';
import { discoverRuleCandidates } from './rule-files';
import { createRuleSessionState } from './session-state';
import { truncateRuleContents } from './truncator';
import type { MatchedRule } from './types';

const SUPPORTED_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'patch',
]);
const TAG = 'omos.rules.v1';

type HookInput = {
  readonly tool: string;
  readonly sessionID: string;
  readonly status?: 'error';
};
type HookOutput = {
  title: string;
  output: string;
  metadata: unknown;
  resolvedFilePaths?: readonly string[];
};

export type RulesInjectorOptions = {
  readonly projectBoundary: string;
  /** Active session directory; defaults to boundary when omitted. */
  readonly projectActiveDirectory?: string;
  readonly prefixes: readonly string[];
  readonly resolveTouchedFilePaths: (
    input: HookInput,
    output: HookOutput,
  ) => readonly string[];
  readonly readRemainingContextTokens: (
    sessionID: string,
  ) => Promise<number | null>;
  readonly reportError: (error: unknown) => void;
  /**
   * Defaults to `resolveGlobalRuleRoots`. Injectable so tests can pin the
   * user-global roots instead of reading the machine's real config dir.
   */
  readonly resolveGlobalRoots?: () => readonly ProjectResourceRoot[];
};

export interface RulesInjectorHook {
  onToolExecuteAfter(input: HookInput, output: HookOutput): Promise<void>;
  clearSession(sessionID: string): Promise<void>;
  clearAll(): Promise<void>;
}

function within(path: string, boundary: string): boolean {
  const rel = relative(boundary, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Resolve the global roots without letting a global-side failure escape.
 *
 * The outer injection pass wraps root resolution in one try/catch, so a throw
 * here would abort the whole pass and silently drop the project rules too.
 * Global rules are a convenience layered on top of project rules: when they
 * cannot be resolved the correct outcome is "no global rules", not "no rules".
 */
function resolveGlobalRootsSafely(
  options: RulesInjectorOptions,
): readonly ProjectResourceRoot[] {
  try {
    return (options.resolveGlobalRoots ?? resolveGlobalRuleRoots)();
  } catch (error) {
    options.reportError(error);
    return [];
  }
}

/** Build an isolated, session-serialized rules injection hook. */
export function createRulesInjectorHook(
  options: RulesInjectorOptions,
): RulesInjectorHook {
  const state = createRuleSessionState();
  const boundary = resolve(options.projectBoundary);
  const activeDirectory = resolve(
    options.projectActiveDirectory ?? options.projectBoundary,
  );
  const lanes = new Map<string, Promise<void>>();
  let clearFence: Promise<void> = Promise.resolve();

  function enqueue(
    sessionID: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = lanes.get(sessionID) ?? Promise.resolve();
    const fence = clearFence;
    const current = previous.then(() => fence).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(sessionID, settled);
    void settled.then(() => {
      if (lanes.get(sessionID) === settled) lanes.delete(sessionID);
    });
    return current;
  }

  async function inject(input: HookInput, output: HookOutput): Promise<void> {
    if (input.status === 'error' || !SUPPORTED_TOOLS.has(input.tool)) return;
    try {
      const paths = [
        ...new Set(
          options
            .resolveTouchedFilePaths(input, output)
            .map((path) => resolve(path))
            .filter((path) => within(path, boundary)),
        ),
      ];
      if (paths.length === 0) return;
      const roots = [
        ...resolveGlobalRootsSafely(options),
        ...resolveProjectResourceRoots({
          activeDirectory,
          boundaryDirectory: boundary,
          prefixes: options.prefixes,
          category: 'rules',
        }),
      ];
      const candidates = discoverRuleCandidates(roots);
      const byIdentity = new Map<string, MatchedRule>();
      for (const path of paths) {
        for (const rule of matchRulesForFile(candidates, path, boundary)) {
          const identity = `${rule.realPath}\0${rule.contentHash}`;
          if (!byIdentity.has(identity)) byIdentity.set(identity, rule);
        }
      }
      const unseen = state.getUnseen(input.sessionID, [...byIdentity.values()]);
      if (unseen.length === 0) return;
      const truncated = await truncateRuleContents({
        rules: unseen,
        sessionID: input.sessionID,
        readRemainingContextTokens: options.readRemainingContextTokens,
      });
      if (truncated.length === 0) return;
      const rulesByPath = new Map(unseen.map((rule) => [rule.realPath, rule]));
      const marked: MatchedRule[] = [];
      const text = truncated
        .map((result) => {
          const rule = rulesByPath.get(result.realPath);
          if (rule) marked.push(rule);
          return `## ${result.relativePath} (${rule?.reason ?? ''})\n${result.result}`;
        })
        .join('\n\n');
      appendTaggedToolOutput(output, text, TAG);
      state.markInjected(input.sessionID, marked);
    } catch (error) {
      options.reportError(error);
    }
  }

  return {
    onToolExecuteAfter: (input, output) =>
      enqueue(input.sessionID, () => inject(input, output)),
    clearSession(sessionID) {
      return enqueue(sessionID, async () => state.clearSession(sessionID));
    },
    clearAll() {
      const earlier = [...lanes.values()];
      let release!: () => void;
      const priorFence = clearFence;
      const thisFence = new Promise<void>((resolveFence) => {
        release = resolveFence;
      });
      clearFence = thisFence;
      return Promise.all([...earlier, priorFence])
        .then(() => {
          state.clearAll();
        })
        .finally(release);
    },
  };
}
