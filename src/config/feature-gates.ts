/**
 * Pure feature-gate projection over the plugin config.
 *
 * Every optional subsystem reads one frozen object, so the enable/disable
 * decisions live in one place and cannot drift between the v1 factory, the v2
 * setup pre-flight, the TUI gates, and the runtime getters. No IO or registry;
 * the v2 host owns the native background lifecycle.
 *
 * Fallback is deliberately not projected here: `fallback.enabled` and the
 * `foreground-fallback` hook differ on v2 (the former keeps retry bookkeeping
 * alive for a live per-session enable; the latter removes the hook entirely).
 */
import { isRecord } from '../utils/guards';
import {
  AgentOverrideConfigSchema,
  type BackgroundJobsMode,
  SubagentScopeSchema,
} from './schema';

/** Structural slice of the plugin config the gates depend on. */
export interface FeatureGateConfig {
  readonly backgroundJobs?: {
    readonly mode?: BackgroundJobsMode;
    readonly queue?: { readonly enabled?: boolean };
    readonly concurrency?: object;
  };
  readonly sessionPresetRouting?: boolean;
  readonly replaceBuiltinSubagents?: boolean;
  readonly tui?: boolean;
  readonly sidebar?: boolean;
  readonly interview?: {
    readonly enabled?: boolean;
  };
  readonly marketplace?: {
    readonly enabled?: boolean;
  };
  readonly liveConfigRefresh?: boolean;
  readonly autoUpdate?: boolean;
  readonly disabled_tools?: readonly string[];
}

/** Unsupported host settings must escape the loader's non-fatal read path. */
export class UnsupportedHostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHostConfigError';
  }
}

function invalidSubagentScope(
  agents: unknown,
  excludeWrapper = false,
): string | undefined {
  if (!isRecord(agents)) return;
  return Object.keys(agents).find((name) => {
    if (excludeWrapper && name === 'agents') return false;
    const override = agents[name];
    return (
      isRecord(override) &&
      Object.hasOwn(override, 'subagents') &&
      !SubagentScopeSchema.safeParse(override.subagents).success
    );
  });
}

/** Reject unsupported settings before a layer can be skipped or merged. */
export function validateExplicitHostConfig(
  config: unknown,
  hostFlavor?: string,
  sourcePath?: string,
): void {
  if (!isRecord(config)) return;
  const source = sourcePath ? `${sourcePath}: ` : '';
  if (
    Object.hasOwn(config, 'routingBlock') &&
    typeof config.routingBlock !== 'boolean'
  ) {
    throw new UnsupportedHostConfigError(
      `${source}routingBlock must be a boolean. Fix the key, then run /reload.`,
    );
  }
  const rejectScope = (path: string): never => {
    throw new UnsupportedHostConfigError(
      `${source}${path}.subagents must list valid specialist names. For pattern rules, use native subagent permissions in agents.<id>.permissions in opencode.json[c], then run /reload.`,
    );
  };
  const root = invalidSubagentScope(config.agents);
  if (root !== undefined) rejectScope(`agents.${root}`);
  if (isRecord(config.presets)) {
    for (const [name, preset] of Object.entries(config.presets)) {
      if (!isRecord(preset)) continue;
      // "agents" can also be the name of a custom agent in flat syntax.
      const wrapper =
        isRecord(preset.agents) &&
        !AgentOverrideConfigSchema.safeParse(preset.agents).success &&
        Object.values(preset.agents).some(isRecord);
      const flat = invalidSubagentScope(preset, wrapper);
      if (flat !== undefined) rejectScope(`presets.${name}.${flat}`);
      if (wrapper) {
        const wrapped = invalidSubagentScope(preset.agents);
        if (wrapped !== undefined)
          rejectScope(`presets.${name}.agents.${wrapped}`);
      }
    }
  }
  if (hostFlavor !== 'v2') return;
  const fallback = config.fallback;
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    const removed = ['continuationPolicy', 'initialRetryDelayMs'].filter(
      (key) => Object.hasOwn(fallback, key),
    );
    if (removed.length > 0) {
      throw new UnsupportedHostConfigError(
        `${source}Removed ${removed.map((key) => `fallback.${key}`).join(', ')} on OpenCode v2. Remove the retired ${removed.length === 1 ? 'key' : 'keys'}, then run /reload.`,
      );
    }
  }
  const backgroundJobs = config.backgroundJobs;
  if (
    !backgroundJobs ||
    typeof backgroundJobs !== 'object' ||
    Array.isArray(backgroundJobs)
  ) {
    return;
  }
  const jobs = backgroundJobs as Record<string, unknown>;
  if (
    Object.hasOwn(jobs, 'mode') &&
    jobs.mode !== undefined &&
    jobs.mode !== 'native' &&
    jobs.mode !== 'off' &&
    jobs.mode !== 'managed'
  ) {
    throw new UnsupportedHostConfigError(
      `${source}Invalid backgroundJobs.mode ${JSON.stringify(jobs.mode)}; use "native", "off", or legacy "managed", then run /reload.`,
    );
  }
  if (
    typeof jobs.wallClockTimeoutMs === 'number' &&
    jobs.wallClockTimeoutMs > 0
  ) {
    throw new UnsupportedHostConfigError(
      `${source}Unsupported backgroundJobs.wallClockTimeoutMs = ${jobs.wallClockTimeoutMs} on OpenCode v2: remove the retired limit or set it to 0, then run /reload.`,
    );
  }
}

/** Resolved enable/disable decisions for the optional subsystems. */
export interface FeatureGates {
  readonly backgroundJobsMode: Exclude<BackgroundJobsMode, 'managed'>;
  readonly admissionQueue: boolean;
  readonly presetRouting: boolean;
  readonly replaceBuiltinSubagents: boolean;
  readonly tui: boolean;
  readonly sidebar: boolean;
  readonly interview: boolean;
  readonly marketplace: boolean;
  readonly webfetch: boolean;
  readonly liveConfigRefresh: boolean;
  readonly updateChecker: boolean;
}

/**
 * Resolve the optional-subsystem gates from a resolved or partial plugin
 * config. Absent keys keep their documented defaults; the returned object is
 * frozen so callers share one immutable projection.
 */
export function resolveFeatureGates(
  config: FeatureGateConfig = {},
): Readonly<FeatureGates> {
  validateExplicitHostConfig(config, 'v2');
  const jobs = config.backgroundJobs;
  const backgroundJobsMode = jobs?.mode === 'off' ? 'off' : 'native';
  const tui = config.tui !== false;
  // User-edited config can be malformed despite the declared type; treat a
  // non-array disabled list as empty instead of failing plugin init.
  const disabledTools = Array.isArray(config.disabled_tools)
    ? config.disabled_tools
    : [];
  return Object.freeze({
    backgroundJobsMode,
    admissionQueue:
      backgroundJobsMode !== 'off' &&
      (jobs?.queue?.enabled ??
        (jobs?.mode !== 'native' || jobs.concurrency !== undefined)),
    presetRouting:
      config.sessionPresetRouting ?? backgroundJobsMode === 'native',
    replaceBuiltinSubagents: config.replaceBuiltinSubagents !== false,
    tui,
    sidebar: tui && config.sidebar !== false,
    interview: config.interview?.enabled !== false,
    marketplace: config.marketplace?.enabled !== false,
    webfetch: !disabledTools.includes('webfetch'),
    liveConfigRefresh: config.liveConfigRefresh !== false,
    updateChecker: config.autoUpdate !== false,
  });
}
