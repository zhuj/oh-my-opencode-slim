import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import {
  AGENT_ALIASES,
  type AgentOverrideConfig,
  ALL_AGENT_NAMES,
  DEFAULT_MODELS,
  loadAgentPrompt,
  type PluginConfig,
  type Preset,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';
import {
  composeAgentSkillPermissions,
  type SkillPermissions,
} from '../config/effective-agent-overrides';
import {
  firstModelId,
  isLegacyModelSentinel,
  usesSelectedModel,
} from '../config/model-sentinel';
import type { HostAgentConfig, RuntimeConfig } from '../config/runtime';
import { hostLegacyAgent } from '../config/runtime';
import { applyOrchestratorModelConfig } from '../config/strip-orchestrator-model';
import { lookupWithAliases, mergeWithAliases } from '../config/utils';
import { escapeRegExp, normalizeAgentName } from '../utils/agent-variant';
import { parseModelRef } from '../v2/adapters';

import { createCouncilAgent, ensureCouncilPrompt } from './council';
import { buildCouncillorAgents, councillorSeatNames } from './council-agents';
import { createCouncillorAgent } from './councillor';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createObserverAgent } from './observer';
import { createOracleAgent } from './oracle';
import {
  type AgentDefinition,
  createOrchestratorAgent,
  resolvePrompt,
} from './orchestrator';
import { mergeTaskStance, TASK_NO_NESTED_DISPATCH } from './permissions';
import { prependBaseAgentPrompt } from './prompt-layers';
import { buildPromptSections, type PromptSections } from './prompt-sections';
import { renderPromptTemplate } from './prompt-template';
import {
  appendObserverDispatchInstruction,
  appendTaskRejectionInstruction,
  OBSERVER_DISPATCH_ROLES,
} from './task-rejection';

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

/** Plugin-controlled tools that receive a generated default stance, in
 * emission order. */
const ORCHESTRATOR_DEFAULT_TOOL_NAMES = [
  'task_cancel',
  'task_reply',
  'task_status',
  'acp_run',
] as const;
const MARKETPLACE_TOOL_NAMES = [
  'marketplace_inspect',
  'marketplace_manage',
] as const;
/** Generated defaults that stay `deny` for non-primaries even when explicitly
 * allowed: their runtime fences classify by primary-ness. */
const FORCED_NON_PRIMARY_DENY = new Set<string>([
  'wait_for_user',
  ...MARKETPLACE_TOOL_NAMES,
]);
/** Slim AST tools: factory read-only maps grant `ast_grep_search`. */
const SLIM_AST_TOOL_NAMES = ['ast_grep_search', 'ast_grep_replace'] as const;
/** Shared empty projection for inference-only passes (no permissions). */
const EMPTY_REGISTERED_TOOLS: ReadonlySet<string> = new Set<string>();
const SAFE_AGENT_ALIAS_RE = /^[a-z][a-z0-9_-]*$/i;

export function resolvePrimaryModelValue(value: unknown): string | undefined {
  if (typeof value === 'string')
    return isLegacyModelSentinel(value) ? undefined : value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  return typeof first === 'string'
    ? first
    : first && typeof first === 'object' && 'id' in first
      ? typeof first.id === 'string'
        ? first.id
        : undefined
      : undefined;
}

function getPrimaryModelFromOverride(
  override: AgentOverrideConfig | undefined,
): string | undefined {
  return firstModelId(override?.model);
}

/**
 * Alias-aware override lookup inside a merged (preset-aware) agents record.
 * Mirrors getAgentOverride semantics (field-level merge, canonical wins)
 * without the host layer, which the config hook applies separately at merge
 * time.
 */
function getOverrideFromAgents(
  agents: Record<string, AgentOverrideConfig>,
  name: string,
): AgentOverrideConfig | undefined {
  return mergeWithAliases(agents, name);
}

function buildAcpAgentDefinition(
  name: string,
  config: NonNullable<PluginConfig['acpAgents']>[string],
  fallbackModel?: string,
): AgentDefinition {
  const description =
    config.description ?? `External ACP agent '${name}' via ${config.command}`;
  const prompt =
    config.prompt ??
    [
      `You are the ${name} ACP wrapper agent.`,
      `You proxy tasks to the configured external ACP agent ${JSON.stringify(
        name,
      )} and return its result; do not implement tasks yourself.`,
      'Preserve any explicitly requested inner ACP selector; do not infer one from the outer wrapper model.',
    ].join('\n');

  return {
    name,
    description,
    config: {
      model: config.wrapperModel ?? fallbackModel ?? DEFAULT_MODELS.oracle,
      prompt,
      permission: {
        read: 'deny',
        edit: 'deny',
        bash: 'deny',
        task: 'deny',
        glob: 'deny',
        grep: 'deny',
        list: 'deny',
        webfetch: 'deny',
        question: 'deny',
        skill: 'deny',
        acp_run: 'allow',
      },
    },
  } as AgentDefinition;
}

function isSafeDisplayName(displayName: string): boolean {
  return SAFE_AGENT_ALIAS_RE.test(displayName);
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model (string or priority array), variant, and temperature.
 * When model is an array, stores it as _modelArray for runtime fallback resolution
 * and selects its primary entry for ephemeral subagents. The orchestrator leaves
 * config.model unset so its live runtime selection is not overwritten.
 */
export function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
  inferenceOnly = false,
): void {
  if (override.model) {
    if (usesSelectedModel(override.model)) {
      // The factory may have received the active preset's primary model.
      // Dynamic selection must remove that pin and any chain derived from it
      // so the host can use the session-selected model.
      delete agent.config.model;
      delete agent._modelArray;
      if (!override.variant) {
        delete agent.config.variant;
      }
    } else if (Array.isArray(override.model)) {
      agent._modelArray = override.model.map((m) =>
        typeof m === 'string' ? { id: m } : { ...m },
      );
      const primaryModel = agent._modelArray[0];
      // Subagents are ephemeral, freshly-created sessions with no prior
      // runtime state to preserve, so giving them a concrete config.model
      // at launch time (the array's primary entry) is safe — see #9100e59.
      // ForegroundFallbackManager handles runtime failover to the
      // remaining entries in _modelArray.
      //
      // The orchestrator is different: it's a long-lived, foreground
      // session where a user's runtime `/model` selection must survive
      // across plugin re-inits (triggered by client.config.update() ->
      // Instance.dispose(), e.g. on every subagent dispatch). Setting
      // config.model here unconditionally would stomp that live
      // selection every time this function re-runs, because it runs
      // BEFORE the config() hook's merge with the live
      // opencodeConfig.agent.orchestrator.model (see src/index.ts:524-528,
      // added by #639). Leaving it undefined for the orchestrator lets
      // that later, precedence-aware guard be the sole source of truth.
      agent.config.model =
        agent.name === 'orchestrator' ? undefined : primaryModel.id;
      // Subagents launch with the primary model, so carry its inline variant
      // into the OpenCode config too. An explicit agent-level variant below
      // intentionally takes precedence.
      if (
        agent.name !== 'orchestrator' &&
        override.variant === undefined &&
        primaryModel.variant !== undefined
      ) {
        agent.config.variant = primaryModel.variant;
      }
    } else {
      agent.config.model = override.model;
    }
  }
  if (override.variant) agent.config.variant = override.variant;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
  if (!inferenceOnly && override.color) agent.config.color = override.color;
  if (override.options) {
    agent.config.options = {
      ...agent.config.options,
      ...structuredClone(override.options),
    };
  }
  if (override.displayName) {
    agent.displayName = override.displayName;
  }
  if (!inferenceOnly && override.description) {
    agent.description = override.description;
  }
  if (!inferenceOnly && override.permission) {
    // Keep the factory's nested-dispatch stance when the override doesn't
    // address `task` (shared with the host-entry and marketplace sites).
    agent.config.permission = mergeTaskStance(
      structuredClone(override.permission),
      agent.config.permission,
    );
  }
}

/**
 * Apply an explicit model inheritance policy after the agent factory has
 * supplied its built-in fallback model. OpenCode uses the parent session model
 * when an agent config does not specify `model`.
 *
 * A combined array-chain policy (`model: [...]` + `inheritModelFrom`) keeps
 * the SDK-level inheritance: the agent follows the live session/orchestrator
 * model and `_modelArray` remains the runtime fallback chain. A scalar `model`
 * still wins outright (explicit model precedence, see getModelForAgent).
 */
function applyModelInheritance(
  agent: AgentDefinition,
  override: AgentOverrideConfig | undefined,
): void {
  // Scalar models are explicit and always win. An array may be combined with
  // inheritance: keep it as the fallback chain while the live parent model
  // supplies the current primary.
  if (override?.model !== undefined && !Array.isArray(override.model)) return;

  if (
    override?.inheritModelFrom === 'session' ||
    override?.inheritModelFrom === 'orchestrator'
  ) {
    delete agent.config.model;
    // The chain head's inline variant belongs to the chain head model, not
    // to the inherited session model; drop it unless explicitly configured.
    if (override?.variant === undefined) {
      delete agent.config.variant;
    }
  }
}

/**
 * Apply model inheritance to the final host agent config after the host layer
 * has been merged. This clears stale host models for `session` and
 * `orchestrator` inheritance so delegated agents follow the live parent model.
 *
 * Combined array-chain policies (`model: [...]` + `inheritModelFrom`) are
 * honored here too: inheritance clears the host model so the SDK keeps
 * following the live parent model. A chain head's inline variant stamped by
 * the earlier passes is cleared alongside the rewritten model. Scalar models
 * keep explicit precedence and skip
 * inheritance entirely.
 */
export function applyModelInheritanceToConfig(
  configAgent: Record<string, unknown>,
  runtime: RuntimeConfig,
  /** Pass-local merged agents record, when the caller already derived it. */
  mergedAgents?: Record<string, AgentOverrideConfig>,
): void {
  const overrides = mergedAgents ?? runtime.agentProjection().agents;
  const canonicalByDisplayName = new Map<string, string>();
  for (const [name, override] of Object.entries(overrides)) {
    if (override.displayName) {
      canonicalByDisplayName.set(
        normalizeAgentName(override.displayName),
        name,
      );
    }
  }
  for (const agentName of Object.keys(configAgent)) {
    const override = getOverrideFromAgents(
      overrides,
      canonicalByDisplayName.get(agentName) ?? agentName,
    );
    if (!override) continue;
    const dynamic = usesSelectedModel(override.model);
    if (
      !dynamic &&
      ((override.model !== undefined && !Array.isArray(override.model)) ||
        override.inheritModelFrom === undefined)
    ) {
      continue;
    }

    const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
    const entry = configAgent[resolvedName];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const agentConfig = entry as Record<string, unknown>;
    delete agentConfig.model;
    // The array-primary and runtime preset passes stamp the chain head's
    // inline variant into this entry next to its model. A combined policy
    // rewrites or clears that model, so the stale variant — which belongs
    // to the chain head model, not the inherited one — must go with it.
    // Explicit agent-level variants win and are left alone; scalar-model
    // agents never reach this point. Mirrors the agent-layer cleanup in
    // applyModelInheritance.
    if (dynamic && override.variant) {
      agentConfig.variant = override.variant;
    } else if (
      dynamic ||
      (Array.isArray(override.model) && override.variant === undefined)
    ) {
      delete agentConfig.variant;
    }
  }
}

function isKnownAgentName(name: string): boolean {
  return (ALL_AGENT_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Runtime state projection
//
// The config hook and the v2 hot-profile refresh both need the exact same
// final model resolution: host-layer merge, array-primary pass, runtime
// preset pass, model inheritance, sidebar projection, and orchestrator-model
// stripping. These helpers are the single source of truth for that pipeline;
// the config hook owns only the host-container side effects (model-switch
// tracking, container assignment).
// ---------------------------------------------------------------------------

/** Sidebar model/variant projection for one agent set. */
export interface AgentModelProjection {
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
}

/**
 * Inference/runtime fields of one agent that may hot-apply to NEW child
 * sessions plus the sidebar. Everything else (prompt, tools, permissions,
 * skills, MCPs, description) stays frozen for a session's lifetime.
 */
interface AgentRuntimeProfile {
  model?: { providerID: string; id: string; variant?: string };
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  sidebarModel: string;
  sidebarVariant?: string;
}

export type AgentRuntimeProfiles = Record<string, AgentRuntimeProfile>;

/**
 * Merge the host opencode `agent` layer over the plugin's agent configs with
 * the plugin's shallow-merge precedence (host fields win per agent). The
 * optional `onUserModelSwitch` observes host-persisted models only — the
 * config hook uses it for the fallback-chain disable bookkeeping; the
 * read-only profile refresh passes none.
 */
export function mergeHostAgentConfigs(
  agents: Record<string, Record<string, unknown>>,
  hostAgents: Record<string, HostAgentConfig> | undefined,
  onUserModelSwitch?: (agentName: string, hostModel: string) => void,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [name, pluginAgent] of Object.entries(agents)) {
    const existing = hostAgents?.[name] ?? hostLegacyAgent(hostAgents, name);
    if (existing && typeof existing.model === 'string') {
      onUserModelSwitch?.(name, existing.model);
    }
    merged[name] = existing
      ? { ...pluginAgent, ...existing }
      : { ...pluginAgent };
  }

  // Display names are host-facing keys. Mirror their inference overrides to
  // the canonical entry used by runtime-profile lookup unless the host also
  // supplied a canonical override. Other host config stays independent.
  for (const [name, pluginAgent] of Object.entries(agents)) {
    const displayName = pluginAgent.displayName;
    if (typeof displayName !== 'string') continue;
    const visibleName = normalizeAgentName(displayName);
    const displayOverride = hostAgents?.[visibleName];
    const displayConfig = merged[visibleName];
    const canonicalOverride = hostAgents?.[name];
    const canonical = merged[name];
    if (!displayOverride || !displayConfig || !canonical) continue;
    // A canonical host entry is authoritative as a whole; falling back to
    // display-name fields individually can mix incompatible model settings.
    if (canonicalOverride !== undefined) continue;
    for (const key of ['model', 'variant', 'temperature', 'options'] as const) {
      if (displayConfig[key] !== undefined) canonical[key] = displayConfig[key];
    }
    if (typeof displayOverride.model === 'string') {
      onUserModelSwitch?.(name, displayOverride.model);
    }
  }
  return merged;
}

/** Model value for one entry (string model only; arrays resolved upstream). */
function entryModelString(
  entry: Record<string, unknown> | undefined,
): string | undefined {
  return typeof entry?.model === 'string' ? entry.model : undefined;
}

/** Resolve the chain head and runtime preset without changing the input. */
export function resolveAgentInference<T extends Record<string, unknown>>(
  entry: T,
  models: readonly { id: string; variant?: string }[] = [],
  override?: AgentOverrideConfig,
): T {
  const result: Record<string, unknown> = { ...entry };
  if (models[0] && result.model === undefined) {
    result.model = models[0].id;
    if (models[0].variant) result.variant = models[0].variant;
  }
  if (override) {
    if (usesSelectedModel(override.model)) {
      delete result.model;
      if (override.variant === undefined) delete result.variant;
    } else if (typeof override.model === 'string')
      result.model = override.model;
    else if (Array.isArray(override.model) && override.model.length > 0) {
      const first = override.model[0];
      result.model = typeof first === 'string' ? first : first.id;
      if (typeof first !== 'string' && first.variant)
        result.variant = first.variant;
    }
    if (
      typeof override.variant === 'string' &&
      (!usesSelectedModel(override.model) || override.variant.length > 0)
    )
      result.variant = override.variant;
    else if ('variant' in override) delete result.variant;
    if (typeof override.temperature === 'number')
      result.temperature = override.temperature;
    else if ('temperature' in override) delete result.temperature;
    if (
      override.options &&
      typeof override.options === 'object' &&
      !Array.isArray(override.options)
    )
      result.options = override.options;
    else if ('options' in override) delete result.options;
  }
  return result as T;
}

/**
 * Project the runtime state for a set of resolved agent definitions:
 *
 * 1. array-primary pass (`runtime.modelArrays` → first model unless the
 *    entry already pinned one);
 * 2. runtime-preset override pass (in-session preset switch wins);
 * 3. model-inheritance policy (`inheritModelFrom`);
 * 4. sidebar projection (`recordTuiAgentModels` payload);
 * 5. per-agent runtime profiles for model/variant/temperature/options.
 *
 * `agentConfigs` is mutated in place (entries only, matching the config
 * hook's historical behavior) and orchestrator-model stripping is applied
 * AFTER the projection so the sidebar/profile keep the configured model.
 */
export function projectAgentRuntimeState(input: {
  runtime: RuntimeConfig;
  agentDefs: readonly AgentDefinition[];
  agentConfigs: Record<string, Record<string, unknown>>;
  /** Resolved runtime-preset agent map (in-session switch), when active. */
  runtimePreset?: Preset;
}): { profiles: AgentRuntimeProfiles; projection: AgentModelProjection } {
  const { runtime, agentDefs, agentConfigs, runtimePreset } = input;
  // One merged-override derivation for the whole pass. The sidebar probe,
  // the inheritance pass, and the profile loop below all read this
  // pass-local copy so `agents()` is never re-derived per agent.
  const mergedAgents = runtime.agentProjection().agents;

  // 1. Array-primary pass. One `modelArrays` derivation per pass; the
  // sidebar chain-head probe below reuses this pass-local copy instead of
  // re-deriving `runtimeChains` (itself derived from `modelArrays`) per
  // agent.
  const modelArrays = runtime.modelArrays;
  if (Object.keys(modelArrays).length > 0) {
    for (const [agentName, models] of Object.entries(modelArrays)) {
      if (models.length === 0) continue;
      const entry = agentConfigs[agentName];
      const resolved = resolveAgentInference(entry ?? {}, models);
      if (entry) Object.assign(entry, resolved);
      else agentConfigs[agentName] = resolved;
    }
  }

  // 2. Runtime-preset override pass.
  if (runtimePreset) {
    for (const [agentName, override] of Object.entries(runtimePreset)) {
      const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
      const entry = agentConfigs[resolvedName];
      if (!entry) continue;

      const resolved = resolveAgentInference(entry, [], override);
      for (const field of ['model', 'variant', 'temperature', 'options']) {
        if (field in resolved) entry[field] = resolved[field];
        else delete entry[field];
      }
    }
  }

  // 3. Model-inheritance policy (authoritative for inheritModelFrom agents).
  applyModelInheritanceToConfig(agentConfigs, runtime, mergedAgents);

  // 4. Sidebar projection (pre-strip; mirrors the historical capture).
  const projection: AgentModelProjection = {
    agentModels: {},
    agentVariants: {},
  };
  for (const agentDef of agentDefs) {
    if (
      agentDef.name === 'council' ||
      agentDef.name === 'councillor' ||
      agentDef.name.startsWith('councillor-')
    ) {
      continue;
    }
    const entry = agentConfigs[agentDef.name];
    // Session-following combined agents have no launch model of their own:
    // entry.model is cleared, the chain head is only a fallback tail, and
    // agentDef.config.model is deleted by inheritance. Skip the chain-head
    // probe so they display 'default'. Same lookup+predicate as
    // RuntimeConfig.combinedModelInheritanceSource, computed pass-locally
    // over the hoisted merged record so the loop does not re-derive
    // `agents()` per agent.
    const override = lookupWithAliases(mergedAgents, agentDef.name);
    const followsSessionModel =
      Array.isArray(override?.model) &&
      override.model.length > 0 &&
      override.inheritModelFrom === 'session';
    const chainHead = followsSessionModel
      ? undefined
      : modelArrays[agentDef.name]?.[0];
    const resolvedModel =
      entryModelString(entry) ??
      chainHead?.id ??
      chainedModelFromDefinition(agentDef);
    const resolvedVariant =
      typeof entry?.variant === 'string'
        ? entry.variant
        : typeof agentDef.config.variant === 'string'
          ? agentDef.config.variant
          : undefined;

    projection.agentModels[agentDef.name] = resolvedModel ?? 'default';
    if (resolvedVariant) {
      projection.agentVariants[agentDef.name] = resolvedVariant;
    }
  }

  // 5. Runtime profiles for NEW child dispatches. Keyed by every resolved
  // config entry (includes display-name aliases) so a child whose session
  // agent is either spelling resolves the same profile.
  const profiles: AgentRuntimeProfiles = {};
  for (const [name, entry] of Object.entries(agentConfigs)) {
    const modelString = entryModelString(entry);
    const ref = parseModelRef(modelString);

    const variant =
      typeof entry.variant === 'string' ? entry.variant : undefined;
    const temperature =
      typeof entry.temperature === 'number' ? entry.temperature : undefined;
    const providerOptions =
      entry.options &&
      typeof entry.options === 'object' &&
      !Array.isArray(entry.options)
        ? {
            ...(entry.options as Record<string, unknown>),
          }
        : undefined;
    const sidebarModel = projection.agentModels[name];
    const sidebarVariant = projection.agentVariants[name] ?? variant;
    profiles[name] = {
      ...(ref ? { model: { ...ref, ...(variant ? { variant } : {}) } } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      sidebarModel: sidebarModel ?? modelString ?? 'default',
      ...(sidebarVariant !== undefined ? { sidebarVariant } : {}),
    };
  }

  // 6. Orchestrator-model stripping runs AFTER the projection capture, exactly
  // as the config hook has always ordered it.
  applyOrchestratorModelConfig({
    agents: agentConfigs,
    enabled: runtime.stripOrchestratorModel,
    presets: runtime.plugin?.presets,
    configPreset: runtime.plugin?.preset,
    runtimePreset: runtime.getRuntimePreset(),
  });

  return { profiles, projection };
}

/** Chain-head model id for one definition (the factory fall-through). */
function chainedModelFromDefinition(
  agentDef: AgentDefinition,
): string | undefined {
  return typeof agentDef.config.model === 'string'
    ? agentDef.config.model
    : undefined;
}

function normalizeCustomAgentName(name: string): string {
  return name.trim();
}

function isSafeCustomAgentName(name: string): boolean {
  // The councillor- prefix is reserved for dynamic council seats; a custom
  // agent taking it would become a phantom seat in the council-inject hook's
  // seat list (agents/index.ts filters agentDefs by the same prefix).
  return (
    SAFE_AGENT_ALIAS_RE.test(name) &&
    !isKnownAgentName(name) &&
    !name.startsWith('councillor-')
  );
}

function hasCustomAgentModel(
  override: AgentOverrideConfig | undefined,
): override is AgentOverrideConfig & {
  model: NonNullable<AgentOverrideConfig['model']>;
} {
  if (!override?.model) {
    return false;
  }

  return !Array.isArray(override.model) || override.model.length > 0;
}

/**
 * Normalize a `subagents` allowlist to internal agent names (issue #1591):
 * entries accept internal names, display names, or @-mentions, but the
 * host's `task` stance keys and the catalog both work on internal names.
 * Deduped; `'*'` is reserved for the scope wildcard. Unknown names are
 * dropped with a warning so a typo cannot mint a dead stance key and a
 * ghost catalog line.
 */
function normalizeSubagentScope(
  scope: readonly string[],
  ownerName: string,
  dispatchNames: ReadonlyMap<string, string>,
): string[] {
  const known = new Set<string>();
  for (const entry of scope) {
    const normalized = normalizeAgentName(entry);
    if (!SAFE_AGENT_ALIAS_RE.test(normalized)) {
      throw new Error(
        `agents.${ownerName}.subagents entry '${entry}' must be an agent name or @mention`,
      );
    }
    const resolved = dispatchNames.get(normalized);
    if (resolved === undefined) {
      console.warn(
        `[oh-my-opencode-slim] agents.${ownerName}.subagents entry '${entry}' does not match an enabled specialist; dropped.`,
      );
      continue;
    }
    known.add(resolved);
  }
  return [...known];
}

function hasExplicitDelegationPermission(
  override: AgentOverrideConfig | undefined,
): boolean {
  const permission = override?.permission;
  return (
    typeof permission === 'string' ||
    (permission !== undefined &&
      (permission.task !== undefined || permission.subagent !== undefined))
  );
}

function templateScope(
  override: AgentOverrideConfig | undefined,
  scope: readonly string[] | undefined,
): readonly string[] | undefined {
  return hasExplicitDelegationPermission(override) ? [] : scope;
}

interface PromptResolutionInputs {
  readonly agentName: string;
  readonly inlinePrompt: string | undefined;
  readonly filePrompt: string | undefined;
  readonly fallbackPrompt: string;
  readonly appendPrompt: string | undefined;
  readonly sections: PromptSections;
}

function resolvePromptWithSections(inputs: PromptResolutionInputs): string {
  const prompt = renderPromptTemplate(
    resolvePrompt(
      inputs.agentName,
      inputs.inlinePrompt,
      inputs.filePrompt,
      inputs.fallbackPrompt,
    ),
    inputs.sections,
    `${inputs.agentName}.md`,
  );
  if (inputs.appendPrompt === undefined) return prompt;

  const appendPrompt = renderPromptTemplate(
    inputs.appendPrompt,
    inputs.sections,
    `${inputs.agentName}_append.md`,
  );
  return `${prompt}\n\n${appendPrompt}`;
}

interface CustomAgentDefinitionInputs {
  readonly name: string;
  readonly override: AgentOverrideConfig;
  readonly filePrompt: string | undefined;
  readonly fileAppendPrompt: string | undefined;
  readonly fallbackModel: string | undefined;
  readonly promptSections: PromptSections;
}

function buildCustomAgentDefinition(
  inputs: CustomAgentDefinitionInputs,
): AgentDefinition {
  const {
    name,
    override,
    filePrompt,
    fileAppendPrompt,
    fallbackModel,
    promptSections,
  } = inputs;
  // A declared primary orchestrates (delegates); a plain custom agent is a
  // specialist and must not spawn nested work (task-rejection stance).
  const isPrimary = override.primary === true;
  const defaultPrompt = isPrimary
    ? `You are ${name}, a primary orchestrator. Plan, delegate to your specialists, monitor, and reconcile their results.`
    : appendTaskRejectionInstruction(`You are the ${name} specialist.`);

  const primaryModel = getPrimaryModelFromOverride(override);
  return {
    name,
    description:
      override.description ??
      (isPrimary
        ? `Primary orchestrator '${name}'`
        : `Custom subagent '${name}'`),
    config: {
      ...(isPrimary ? { mode: 'primary' as const } : {}),
      model: primaryModel ?? fallbackModel ?? DEFAULT_MODELS.oracle,
      prompt: resolvePromptWithSections({
        agentName: name,
        inlinePrompt: override.prompt,
        filePrompt,
        fallbackPrompt: defaultPrompt,
        appendPrompt: fileAppendPrompt,
        sections: promptSections,
      }),
    },
  } as AgentDefinition;
}

/**
/** Tools the plugin registers for this generation; generated allow grants
 * follow this set — generated denies are always retained. */
function registeredDefaultToolNames(
  runtime: RuntimeConfig,
): ReadonlySet<string> {
  const disabledTools = new Set(runtime.disabledTools);
  const registered = new Set<string>();
  const register = (toolName: string) => {
    if (!disabledTools.has(toolName)) registered.add(toolName);
  };
  const taskControls =
    runtime.backgroundJobsMode === 'native'
      ? ['task_cancel', 'task_status', 'task_reply', 'task_report']
      : [];
  for (const toolName of taskControls) register(toolName);
  if (runtime.interviewEnabled && !runtime.disabledCommands.has('interview')) {
    register('interview_submit_state');
  }
  if (runtime.marketplaceEnabled) {
    for (const toolName of MARKETPLACE_TOOL_NAMES) register(toolName);
  }
  if (Object.keys(runtime.acpAgents).length > 0) register('acp_run');
  for (const toolName of SLIM_AST_TOOL_NAMES) register(toolName);
  return registered;
}

/** Drop factory-default Slim AST **allow** grants when the tool is not
 * registered, before user overrides replace the map; factory denies and the
 * wildcard read-only deny stay. */
function stripUnregisteredSlimAstFactoryTools(
  permission: unknown,
  registeredTools: ReadonlySet<string>,
): void {
  if (
    typeof permission !== 'object' ||
    permission === null ||
    Array.isArray(permission)
  ) {
    return;
  }
  const map = permission as Record<string, unknown>;
  for (const toolName of SLIM_AST_TOOL_NAMES) {
    if (!registeredTools.has(toolName) && map[toolName] === 'allow') {
      delete map[toolName];
    }
  }
}

/**
 * Apply default permissions plus compiled skill presets. Generated allow grants are
 * emitted only for tools this generation registers; every generated deny is
 * kept (v2 starts from `*: allow`), and explicit user entries are preserved.
 */
function applyDefaultPermissions(
  agent: AgentDefinition,
  registeredTools: ReadonlySet<string>,
  compiledSkills: SkillPermissions | undefined,
  runtime: RuntimeConfig,
  isPrimary = false,
  subagentScope?: readonly string[],
): void {
  // A shorthand string is a user-level rule for every tool. Keep its original
  // form; marketplace tools independently fail closed through their caller
  // identity guard for every non-orchestrator agent.
  if (typeof agent.config.permission === 'string') {
    return;
  }

  const existing = (agent.config.permission ?? {}) as Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  >;

  // Subagents don't ask the human by default: a parked child question
  // has no headless answerer. Explicit config wins.
  const questionPerm = isPrimary
    ? (existing.question ?? 'allow')
    : (existing.question ?? 'deny');
  const pluginDefaultToolNames = [
    ...ORCHESTRATOR_DEFAULT_TOOL_NAMES,
    'interview_submit_state',
    'wait_for_user',
    ...MARKETPLACE_TOOL_NAMES,
  ];
  const pluginDefaultPermissions: Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  > = {};
  for (const toolName of pluginDefaultToolNames) {
    const configured = existing[toolName];
    // Runtime fences classify the forced-deny controls by primary-ness, so a
    // non-primary allow would dead-end; other primary-owned controls keep an
    // explicit user stance.
    if (configured !== undefined) {
      pluginDefaultPermissions[toolName] =
        !isPrimary && FORCED_NON_PRIMARY_DENY.has(toolName)
          ? 'deny'
          : configured;
      continue;
    }
    const effect = isPrimary ? 'allow' : 'deny';
    // Only allow grants are gated on registration; generated denies stay
    // because v2 starts from `*: allow` and a dropped deny could expose a
    // same-named foreign tool.
    if (effect === 'deny' || registeredTools.has(toolName)) {
      pluginDefaultPermissions[toolName] = effect;
    }
  }

  // Preserve authored rules. Default child roles must not dispatch just
  // because the host's depth limit has been raised.
  const scopedStance =
    subagentScope === undefined
      ? undefined
      : {
          ...TASK_NO_NESTED_DISPATCH,
          ...Object.fromEntries(subagentScope.map((name) => [name, 'allow'])),
        };
  const taskStance =
    existing.task ??
    (existing.subagent === undefined
      ? (scopedStance ??
        (isPrimary ? undefined : { ...TASK_NO_NESTED_DISPATCH }))
      : undefined);

  agent.config.permission = {
    ...existing,
    // A child can report to its authoritative host parent; primaries do not
    // need the tool, and the tool also rejects parentless sessions at runtime.
    task_report:
      existing.task_report ??
      (isPrimary ||
      existing['*'] === 'deny' ||
      !registeredTools.has('task_report')
        ? 'deny'
        : 'allow'),
    ...(taskStance !== undefined ? { task: taskStance } : {}),
    question: questionPerm,
    ...pluginDefaultPermissions,
    skill: {
      ...(compiledSkills ??
        composeAgentSkillPermissions(
          agent.name,
          { permission: existing },
          { disabledSkills: runtime.disabledSkills },
        )),
    },
  } as SDKAgentConfig['permission'];
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explorer: createExplorerAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  observer: createObserverAgent,
  council: createCouncilAgent,
  councillor: createCouncillorAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory and hostFlavor
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string; hostFlavor?: string },
): AgentDefinition[] {
  return createAgentViews(runtime, options, false);
}

/** Resolve the same roster and inference fields without constructing prompts. */
export function createAgentInferenceViews(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string; hostFlavor?: string },
): Array<
  Pick<AgentDefinition, 'name' | 'displayName' | 'config' | '_modelArray'>
> {
  return createAgentViews(runtime, options, true);
}

function createAgentViews(
  runtime: RuntimeConfig,
  options: { projectDirectory?: string; hostFlavor?: string } | undefined,
  inferenceOnly: boolean,
): AgentDefinition[] {
  const { agents: mergedAgents, skillPermissions } = runtime.agentProjection();
  const disabled = new Set(runtime.disabledAgents);
  // One availability projection per roster pass (inference-only refreshes
  // build no permissions at all, matching their skipped factory prompts).
  const registeredTools = inferenceOnly
    ? EMPTY_REGISTERED_TOOLS
    : registeredDefaultToolNames(runtime);
  if (!runtime.council) {
    disabled.add('council');
    // The bare councillor is only meaningful as part of configured Council Mode.
    disabled.add('councillor');
  }
  const nestedDispatchEnabled = !disabled.has('observer');
  // Explicitly disabling the council agent disables the whole chain: the
  // injected procedure dispatches seats and then delegates synthesis to
  // the council agent, so seats/pointer/hook without it would dangle.
  if (disabled.has('council')) {
    disabled.add('councillor');
  }

  let defaultPromptSections: PromptSections | undefined;
  const getPromptSections = (scope?: readonly string[]): PromptSections => {
    if (scope === undefined && defaultPromptSections) {
      return defaultPromptSections;
    }
    const sections = buildPromptSections({
      agentNames:
        scope ??
        [
          'orchestrator',
          ...Object.keys(SUBAGENT_FACTORIES),
          ...runtime.customAgentNames,
          ...Object.keys(runtime.acpAgents),
        ].filter(
          (name) => !disabled.has(name) && SAFE_AGENT_ALIAS_RE.test(name),
        ),
    });
    if (scope === undefined) defaultPromptSections = sections;
    return sections;
  };

  const primaryModel = runtime.primaryModel;
  const orchestratorOverride = getOverrideFromAgents(
    mergedAgents,
    'orchestrator',
  );
  const configuredOrchestratorModel =
    getPrimaryModelFromOverride(orchestratorOverride);

  // Preserve the historical fixer → research-agent fallback (now explorer)
  // unless an explicit inheritance policy opts the fixer into a different
  // source.
  const getModelForAgent = (name: SubagentName): string => {
    const override = getOverrideFromAgents(mergedAgents, name);
    if (override?.model === undefined) {
      if (override?.inheritModelFrom === 'orchestrator') {
        return configuredOrchestratorModel ?? (DEFAULT_MODELS[name] as string);
      }
      if (override?.inheritModelFrom === 'session') {
        return primaryModel ?? (DEFAULT_MODELS[name] as string);
      }
    }

    if (name === 'fixer' && override?.model === undefined) {
      const explorerOverride = getOverrideFromAgents(
        mergedAgents,
        'explorer',
      )?.model;
      const explorerModel = firstModelId(explorerOverride);
      return (
        explorerModel ?? primaryModel ?? (DEFAULT_MODELS.explorer as string)
      );
    }
    return primaryModel ?? (DEFAULT_MODELS[name] as string);
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  )
    .filter(([name]) => !disabled.has(name))
    .map(([name, factory]) => {
      // Get base agent definition using the subagent factory with undefined prompts
      const model = getModelForAgent(name);
      const agent: AgentDefinition = inferenceOnly
        ? { name, config: { model } }
        : factory(model, undefined, undefined);
      if (!inferenceOnly) {
        // Factory read-only maps grant the Slim AST tools by default; when
        // they are disabled the tools are unregistered, so the default grant
        // is dropped before user overrides replace the map.
        stripUnregisteredSlimAstFactoryTools(
          agent.config.permission,
          registeredTools,
        );
      }
      if (!inferenceOnly && !nestedDispatchEnabled) {
        // Deny nested dispatch without an observer.
        const permission = agent.config.permission as
          | Record<string, unknown>
          | undefined;
        if (
          permission &&
          typeof permission === 'object' &&
          typeof permission.task === 'object'
        ) {
          const rest = { ...permission };
          rest.task = { ...TASK_NO_NESTED_DISPATCH };
          agent.config.permission = rest as typeof agent.config.permission;
        }
      }

      const customPrompts = loadAgentPrompt(name, {
        preset: runtime.preset,
        projectDirectory: options?.projectDirectory,
        hostFlavor: options?.hostFlavor,
      });

      const override = getOverrideFromAgents(mergedAgents, name);
      const inlinePrompt = override?.prompt;
      if (inferenceOnly) {
        // Keep the existing inline-versus-file diagnostic without rendering.
        if (inlinePrompt !== undefined && customPrompts.prompt !== undefined) {
          resolvePrompt(name, inlinePrompt, customPrompts.prompt, '');
        }
        return agent;
      }
      const defaultPrompt = appendTaskRejectionInstruction(
        appendObserverDispatchInstruction(
          agent.config.prompt ?? '',
          nestedDispatchEnabled && OBSERVER_DISPATCH_ROLES.has(name),
        ),
      );

      agent.config.prompt = resolvePromptWithSections({
        agentName: name,
        inlinePrompt,
        filePrompt: customPrompts.prompt,
        fallbackPrompt: defaultPrompt,
        appendPrompt: customPrompts.appendPrompt,
        sections: getPromptSections(templateScope(override, undefined)),
      });
      if (name === 'council') {
        agent.config.prompt = ensureCouncilPrompt(agent.config.prompt);
      }

      return agent;
    });

  // 1b. Discover unknown keys in config.agents as custom subagents.
  const customAgentNames = runtime.customAgentNames
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!isSafeCustomAgentName(name)) {
        throw new Error(`Unsafe custom agent name '${name}'`);
      }
      return !disabled.has(name);
    });

  const isDeclaredPrimary = (name: string): boolean =>
    name === 'orchestrator' ||
    (customAgentNames.includes(name) &&
      getOverrideFromAgents(mergedAgents, name)?.primary === true);
  const makeDispatchNames = (): ReadonlyMap<string, string> => {
    const candidates = [
      ...protoSubAgents.map((agent) => agent.name),
      ...customAgentNames.filter((name) => {
        const override = getOverrideFromAgents(mergedAgents, name);
        return (
          hasCustomAgentModel(override) ||
          override?.inheritModelFrom !== undefined
        );
      }),
      ...Object.keys(runtime.acpAgents).map(normalizeCustomAgentName),
      ...councillorSeatNames(runtime, disabled),
    ].filter((name) => !isDeclaredPrimary(name) && !disabled.has(name));
    const dispatchNames = new Map(candidates.map((name) => [name, name]));
    for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
      if (dispatchNames.has(canonical)) dispatchNames.set(alias, canonical);
    }
    for (const name of candidates) {
      const displayName = getOverrideFromAgents(
        mergedAgents,
        name,
      )?.displayName;
      if (displayName) dispatchNames.set(normalizeAgentName(displayName), name);
    }
    return dispatchNames;
  };
  let dispatchNames: ReadonlyMap<string, string> | undefined;
  const customPrimaryScopes = new Map<string, string[]>();
  const getScope = (
    name: string,
    override: AgentOverrideConfig | undefined,
  ) => {
    const scope = override?.subagents;
    if (!scope || inferenceOnly) return undefined;
    if (!isDeclaredPrimary(name)) {
      console.warn(
        `[oh-my-opencode-slim] agents.${name}.subagents applies only to primary agents. Use permission.subagent to configure this specialist.`,
      );
      return undefined;
    }
    dispatchNames ??= makeDispatchNames();
    return normalizeSubagentScope(scope, name, dispatchNames);
  };
  for (const name of customAgentNames) {
    const scope = getScope(name, getOverrideFromAgents(mergedAgents, name));
    if (scope) customPrimaryScopes.set(name, scope);
  }

  const protoCustomAgents = customAgentNames.flatMap((name) => {
    const override = getOverrideFromAgents(mergedAgents, name);
    if (
      !hasCustomAgentModel(override) &&
      override?.inheritModelFrom === undefined
    ) {
      console.warn(
        `[oh-my-opencode] Custom agent '${name}' skipped: 'model' is required`,
      );
      return [];
    }

    const customPrompts = loadAgentPrompt(name, {
      preset: runtime.preset,
      projectDirectory: options?.projectDirectory,
      hostFlavor: options?.hostFlavor,
    });

    const fallbackModel =
      override.inheritModelFrom === 'orchestrator'
        ? configuredOrchestratorModel
        : primaryModel;
    if (inferenceOnly) {
      if (override.prompt !== undefined && customPrompts.prompt !== undefined) {
        resolvePrompt(name, override.prompt, customPrompts.prompt, '');
      }
      return [
        {
          name,
          config: {
            ...(override.primary === true ? { mode: 'primary' as const } : {}),
            model:
              getPrimaryModelFromOverride(override) ??
              fallbackModel ??
              DEFAULT_MODELS.oracle,
          },
        },
      ];
    }

    const scope = customPrimaryScopes.get(name);
    return [
      buildCustomAgentDefinition({
        name,
        override,
        filePrompt: customPrompts.prompt,
        fileAppendPrompt: customPrompts.appendPrompt,
        fallbackModel,
        promptSections: getPromptSections(templateScope(override, scope)),
      }),
    ];
  });

  const acpAgentNames = Object.keys(runtime.acpAgents)
    .map(normalizeCustomAgentName)
    .filter((name) => name.length > 0)
    .filter((name) => {
      if (!SAFE_AGENT_ALIAS_RE.test(name)) {
        throw new Error(
          `ACP agent name '${name}' must match /^[a-z][a-z0-9_-]*$/i`,
        );
      }
      if (
        isKnownAgentName(name) ||
        AGENT_ALIASES[name] !== undefined ||
        name.startsWith('councillor-')
      ) {
        throw new Error(
          `ACP agent '${name}' conflicts with a built-in agent name or alias`,
        );
      }
      if (customAgentNames.includes(name)) {
        throw new Error(
          `ACP agent '${name}' conflicts with a custom agent of the same name`,
        );
      }
      return !disabled.has(name);
    });

  const protoAcpAgents = acpAgentNames.map((name) => {
    const acp = runtime.acpAgents[name];
    if (!acp) throw new Error(`ACP agent '${name}' is missing config`);
    return inferenceOnly
      ? {
          name,
          config: {
            model: acp.wrapperModel ?? primaryModel ?? DEFAULT_MODELS.oracle,
          },
        }
      : buildAcpAgentDefinition(name, acp, primaryModel);
  });

  // 2. Apply overrides and default permissions to built-in subagents
  const builtInSubAgents = protoSubAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override, inferenceOnly);
    }
    applyModelInheritance(agent, override);
    if (!inferenceOnly) {
      applyDefaultPermissions(
        agent,
        registeredTools,
        skillPermissions[agent.name],
        runtime,
      );
    }
    return agent;
  });

  const customSubAgents = protoCustomAgents.map((agent) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (override) {
      applyOverrides(agent, override, inferenceOnly);
    }
    applyModelInheritance(agent, override);
    if (!inferenceOnly) {
      applyDefaultPermissions(
        agent,
        registeredTools,
        skillPermissions[agent.name],
        runtime,
        override?.primary === true,
        customPrimaryScopes.get(agent.name),
      );
    }
    return agent;
  });

  const acpSubAgents = protoAcpAgents.map((agent) => {
    if (!inferenceOnly) {
      applyDefaultPermissions(agent, registeredTools, undefined, runtime);
    }
    return agent;
  });

  // Build dynamic councillor agents from council config (flatten mode).
  // Each councillor becomes a dispatchable subagent with its own model,
  // so the orchestrator can delegate to them via `subagent()` with native
  // panes at depth 1.
  const councillorOverride = getOverrideFromAgents(mergedAgents, 'councillor');
  // Shared inference settings do not replace seat models or variants.
  const seatInference = {
    temperature: councillorOverride?.temperature,
    options: councillorOverride?.options,
  };
  // No default color: unconfigured seats keep the host's distinct palette.
  const councillorColor =
    councillorOverride?.color ??
    getOverrideFromAgents(mergedAgents, 'council')?.color;
  const councillorAgents = buildCouncillorAgents(
    runtime,
    disabled,
    nestedDispatchEnabled,
    inferenceOnly,
  ).map((agent) => {
    applyOverrides(agent, seatInference, inferenceOnly);
    if (!inferenceOnly) {
      if (councillorColor) agent.config.color ??= councillorColor;
      // Councillor factory maps grant the Slim AST search tool by default;
      // when disabled the grant is dead config, while the factory wildcard
      // deny (and the explicit `ast_grep_replace` deny) still stands.
      stripUnregisteredSlimAstFactoryTools(
        agent.config.permission,
        registeredTools,
      );
      applyDefaultPermissions(
        agent,
        registeredTools,
        skillPermissions.councillor,
        runtime,
      );
    }
    return agent;
  });

  const allSubAgents = [
    ...builtInSubAgents,
    ...customSubAgents,
    ...acpSubAgents,
    ...councillorAgents,
  ];

  if (!inferenceOnly) {
    for (const agent of [...acpSubAgents, ...councillorAgents]) {
      agent.config.prompt = appendTaskRejectionInstruction(
        appendObserverDispatchInstruction(
          agent.config.prompt ?? '',
          nestedDispatchEnabled && agent.name.startsWith('councillor-'),
        ),
      );
    }
  }

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorModel =
    firstModelId(orchestratorOverride?.model) ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', {
    preset: runtime.preset,
    projectDirectory: options?.projectDirectory,
    hostFlavor: options?.hostFlavor,
  });
  const orchestratorScope = getScope('orchestrator', orchestratorOverride);
  const orchestrator: AgentDefinition = inferenceOnly
    ? {
        name: 'orchestrator',
        config:
          typeof orchestratorModel === 'string' && orchestratorModel
            ? { model: orchestratorModel }
            : {},
      }
    : createOrchestratorAgent(orchestratorModel);

  const inlineOrchestratorPrompt = orchestratorOverride?.prompt;
  if (!inferenceOnly) {
    orchestrator.config.prompt = resolvePromptWithSections({
      agentName: 'orchestrator',
      inlinePrompt: inlineOrchestratorPrompt,
      filePrompt: orchestratorPrompts.prompt,
      fallbackPrompt: orchestrator.config.prompt ?? '',
      appendPrompt: orchestratorPrompts.appendPrompt,
      sections: getPromptSections(
        templateScope(orchestratorOverride, orchestratorScope),
      ),
    });
  } else if (
    inlineOrchestratorPrompt !== undefined &&
    orchestratorPrompts.prompt !== undefined
  ) {
    resolvePrompt(
      'orchestrator',
      inlineOrchestratorPrompt,
      orchestratorPrompts.prompt,
      '',
    );
  }

  if (orchestratorOverride) {
    applyOverrides(orchestrator, orchestratorOverride, inferenceOnly);
  }
  applyModelInheritance(orchestrator, orchestratorOverride);
  if (!inferenceOnly) {
    applyDefaultPermissions(
      orchestrator,
      registeredTools,
      skillPermissions.orchestrator,
      runtime,
      true,
      orchestratorScope,
    );
  }

  // Collect all display names from orchestrator and all subagents
  const displayNameMap = new Map<string, string>();
  if (orchestrator.displayName) {
    displayNameMap.set('orchestrator', orchestrator.displayName);
  }
  for (const agent of allSubAgents) {
    if (agent.displayName) {
      displayNameMap.set(agent.name, agent.displayName);
    }
  }

  const inOrchestratorScope = (name: string) =>
    orchestratorScope === undefined || orchestratorScope.includes(name);

  const extraOrchestratorPromptsList = (
    inferenceOnly ? [] : [...builtInSubAgents, ...customSubAgents]
  )
    .filter((agent) => inOrchestratorScope(agent.name))
    .map((agent) => {
      const override = getOverrideFromAgents(mergedAgents, agent.name);
      return override?.orchestratorPrompt;
    })
    .filter((prompt): prompt is string => Boolean(prompt));

  const acpOrchestratorPrompts = (
    inferenceOnly
      ? []
      : acpSubAgents.filter((agent) => inOrchestratorScope(agent.name))
  ).map((agent) => {
    const acp = runtime.acpAgents[agent.name];
    if (acp?.orchestratorPrompt) return acp.orchestratorPrompt;
    return [
      `@${agent.name}`,
      `- Lane: External ACP-connected agent (${
        acp?.command ?? 'unknown command'
      })`,
      `- Role: ${agent.description ?? `External ACP agent ${agent.name}`}`,
      '- **Delegate when:** The user explicitly asks for this ACP-backed agent, or the task matches its role and benefits from software/subscription-specific capabilities outside OpenCode.',
      '- **Do not delegate when:** The built-in specialists can handle the task more directly or local file ownership would conflict with another writer lane.',
      '- **Delegation prompt:** Include an explicitly requested inner ACP selector in the delegation brief (for example, "Inner ACP selector: <value>").',
      '- **Result handling:** Treat returned output as external-agent work. Reconcile any reported file changes before continuing.',
    ].join('\n');
  });

  // Validate display names
  const usedDisplayNames = new Set<string>();
  for (const [, displayName] of displayNameMap) {
    const normalizedDisplayName = normalizeAgentName(displayName);
    if (!isSafeDisplayName(normalizedDisplayName)) {
      throw new Error(
        `displayName '${normalizedDisplayName}' must match /^[a-z][a-z0-9_-]*$/i`,
      );
    }
    if (usedDisplayNames.has(normalizedDisplayName)) {
      throw new Error(
        `Duplicate displayName '${normalizedDisplayName}' assigned to multiple agents`,
      );
    }
    usedDisplayNames.add(normalizedDisplayName);
  }
  for (const displayName of usedDisplayNames) {
    if (
      (ALL_AGENT_NAMES as readonly string[]).includes(displayName) ||
      customAgentNames.includes(displayName) ||
      acpAgentNames.includes(displayName)
    ) {
      throw new Error(
        `displayName '${displayName}' conflicts with an agent name`,
      );
    }
  }

  if (inferenceOnly) return [orchestrator, ...allSubAgents];

  const applyDisplayScope = (
    agent: AgentDefinition,
    scope: string[] | undefined,
  ) => {
    const override = getOverrideFromAgents(mergedAgents, agent.name);
    if (!scope || hasExplicitDelegationPermission(override)) return;
    const stance =
      typeof agent.config.permission === 'object'
        ? agent.config.permission.task
        : undefined;
    if (typeof stance !== 'object' || stance === null) return;
    for (const name of scope) {
      const display = displayNameMap.get(name);
      if (display) stance[normalizeAgentName(display)] = 'allow';
    }
  };
  applyDisplayScope(orchestrator, orchestratorScope);
  for (const agent of customSubAgents) {
    applyDisplayScope(agent, customPrimaryScopes.get(agent.name));
  }

  const rewritePrompt = (promptText: string) => {
    let text = promptText;
    for (const [internalName, displayName] of displayNameMap) {
      text = text.replace(
        new RegExp(`@${escapeRegExp(internalName)}\\b`, 'g'),
        `@${normalizeAgentName(displayName)}`,
      );
    }
    return text;
  };

  if (orchestrator.config.prompt) {
    orchestrator.config.prompt = rewritePrompt(orchestrator.config.prompt);
  }
  const rewrittenOverrides = extraOrchestratorPromptsList.map(rewritePrompt);
  const rewrittenAcps = acpOrchestratorPrompts.map(rewritePrompt);

  let updatedPrompt = orchestrator.config.prompt ?? '';

  if (rewrittenOverrides.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n# Project-specific routing guidance\n\n${rewrittenOverrides.join(
      '\n\n',
    )}`;
  }

  if (rewrittenAcps.length > 0) {
    updatedPrompt = `${updatedPrompt}\n\n${rewrittenAcps.join('\n\n')}`;
  }

  // Static pointer = roster only. The seat list lives here because v2's
  // native subagent roster filters hidden agents out, so this line is the
  // orchestrator's only always-present source of seat IDs. The host adds
  // agent-param guidance ('name not in available
  // subagents → pass through model parameter', subagent.ts:31-33) that
  // actively steers away from exact-name dispatch; a roster-visible-but-@-hidden
  // agent flag upstream would let the Council Mode block's dispatch clause be
  // retired by observation.
  // The dispatch procedure is NOT mirrored here (it reads every turn): the
  // council-inject hook carries it, injected on the FIRST council keyword
  // and then standing in history. The disabled variant keeps a one-line
  // manual hint because with the hook off no block will ever appear.
  const councillorSeats = inOrchestratorScope('council')
    ? councillorAgents
        .filter((agent) => inOrchestratorScope(agent.name))
        .map((agent) => agent.name)
    : [];
  if (councillorSeats.length > 0) {
    const seatList = councillorSeats.join(', ');
    updatedPrompt = runtime.disabledHooks.has('council-inject')
      ? `${updatedPrompt}\n\n## Council\nSeats: ${seatList} — dispatch when the user asks for consensus.`
      : `${updatedPrompt}\n\n## Council\nSeats: ${seatList}`;
  }

  if (
    runtime.plugin?.routingBlock === true &&
    inlineOrchestratorPrompt === undefined &&
    orchestratorPrompts.prompt === undefined
  ) {
    const scoped = templateScope(orchestratorOverride, orchestratorScope);
    const roster =
      scoped ??
      allSubAgents
        .filter((agent) => agent.config.mode !== 'primary')
        .map((agent) => agent.name);
    updatedPrompt = `${updatedPrompt}\n\n${rewritePrompt(getPromptSections(roster).agents)}`;
  }
  orchestrator.config.prompt = updatedPrompt;

  if (!inferenceOnly) {
    for (const agent of [orchestrator, ...allSubAgents]) {
      if (customPrimaryScopes.has(agent.name) && agent.config.prompt) {
        agent.config.prompt = rewritePrompt(agent.config.prompt);
      }
      agent.config.prompt = prependBaseAgentPrompt(agent.config.prompt ?? '');
    }
  }

  return [orchestrator, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param runtime - Runtime configuration interface (plugin layer, preset-aware)
 * @param options - Optional options including projectDirectory and hostFlavor
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  runtime: RuntimeConfig,
  options?: { projectDirectory?: string; hostFlavor?: string },
): Record<string, SDKAgentConfig> {
  const agents = createAgents(runtime, options);

  return getAgentConfigsFromDefinitions(runtime, agents);
}

/** Project a previously constructed agent set without rebuilding definitions. */
export function getAgentConfigsFromDefinitions(
  runtime: RuntimeConfig,
  agents: readonly AgentDefinition[],
): Record<string, SDKAgentConfig> {
  // One merged-override derivation for the whole projection pass: every
  // agent's MCP list reads this pass-local copy instead of re-deriving
  // `runtime.agentProjection().agents` per agent.
  const mergedAgents = runtime.agentProjection().agents;
  const applyClassification = (
    name: string,
    sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    },
  ): void => {
    if (name === 'councillor' || name.startsWith('councillor-')) {
      // Internal agent - subagent mode, hidden from @ autocomplete.
      // Dynamic councillors are named councillor-<seat> (see council-agents.ts).
      sdkConfig.mode = 'subagent';
      sdkConfig.hidden = true;
    } else if (name === 'orchestrator' || sdkConfig.mode === 'primary') {
      sdkConfig.mode = 'primary';
    } else {
      sdkConfig.mode = 'subagent';
    }
  };

  const isInternalOnly = (name: string): boolean =>
    name === 'councillor' || name.startsWith('councillor-');

  const entries: Array<[string, SDKAgentConfig]> = [];

  for (const a of agents) {
    const sdkConfig: SDKAgentConfig & {
      mcps?: string[];
      displayName?: string;
      hidden?: boolean;
    } = {
      ...a.config,
      description: a.description,
      mcps: getAgentMcpList(a.name, runtime, mergedAgents),
    };

    if (a.displayName) {
      sdkConfig.displayName = a.displayName;
    }

    applyClassification(a.name, sdkConfig);

    const normalizedDisplayName = a.displayName
      ? normalizeAgentName(a.displayName)
      : undefined;

    if (normalizedDisplayName && !isInternalOnly(a.name)) {
      entries.push([normalizedDisplayName, sdkConfig]);
      entries.push([a.name, { ...sdkConfig, hidden: true }]);
      continue;
    }

    entries.push([a.name, sdkConfig]);
  }

  return Object.fromEntries(entries);
}
