import {
  getSkillPermissionsForAgent,
  getSkillPermissionsForSelection,
  type SkillSelection,
} from '../cli/skills';
import {
  assertSkillNames,
  assertSkillPolicyConfig,
} from '../utils/skill-policy-validation';
import { compilePermissionPolicy } from '../v2/permissions';
import { mergeAgentOverrides } from './presets';
import type { AgentOverrideConfig } from './schema';
import {
  normalizeAgentSkillDirectives,
  resolveAgentSkillSelection,
} from './utils';

/**
 * Local skills this agent may auto-add: those not already named by an exact
 * `permission.skill` rule. A `'*'` rule names everything, so the whole addition
 * list drops out. The rules are hashed once per agent instead of rescanned for
 * every local skill.
 */
function uncoveredLocalSkills(
  override: AgentOverrideConfig,
  localSkillNames: readonly string[],
): readonly string[] {
  const skillRules =
    typeof override.permission === 'object'
      ? override.permission.skill
      : undefined;
  if (skillRules === 'ask' || skillRules === 'deny') return [];
  if (!skillRules || typeof skillRules !== 'object') {
    return localSkillNames;
  }
  const ruledNames = new Set(Object.keys(skillRules));
  if (ruledNames.has('*')) {
    return [];
  }
  return localSkillNames.filter((skill) => !ruledNames.has(skill));
}

/** Resolve runtime-only skill directives after all agent layers are merged. */
export function resolveEffectiveAgentOverrides(
  agents: Record<string, AgentOverrideConfig>,
  projectLocalSkillNames: () => readonly string[],
  defaultSkills: Readonly<Record<string, readonly string[]>> = {},
): Record<string, AgentOverrideConfig> {
  assertSkillPolicyConfig({ agents });
  const includesLocalSkills = Object.values(agents).some(
    (override) => override.skills_include_local === true,
  );
  const localSkillNames = includesLocalSkills ? projectLocalSkillNames() : [];
  const normalized: Record<string, AgentOverrideConfig> = {};
  for (const [name, override] of Object.entries(agents)) {
    const names =
      override.skills_include_local === true
        ? uncoveredLocalSkills(override, localSkillNames)
        : [];
    normalized[name] = normalizeAgentSkillDirectives(
      { [name]: override },
      names,
      defaultSkills,
    )[name];
  }
  return normalized;
}

export type SkillPermissions = Readonly<
  Record<string, 'allow' | 'ask' | 'deny'>
>;

export type SkillAdmission = Readonly<Record<string, 'allow' | 'deny'>>;

/** Internal products: selection/admission and authorization are distinct. */
export interface EffectiveAgentProjection {
  readonly agents: Record<string, AgentOverrideConfig>;
  readonly skillSelections: Readonly<Record<string, SkillSelection>>;
  readonly skillPermissions: Readonly<Record<string, SkillPermissions>>;
  readonly skillAdmission: Readonly<Record<string, SkillAdmission>>;
}

interface SkillProjectionOptions {
  readonly localSkillNames?: readonly string[];
  readonly defaultSkills?: readonly string[];
  readonly disabledSkills?: readonly string[];
}

/** Append rules without leaving replaced keys in their earlier positions. */
function appendRules(
  base: SkillPermissions,
  rules: SkillPermissions,
): Record<string, 'allow' | 'ask' | 'deny'> {
  return Object.fromEntries([
    ...Object.entries(base).filter(([key]) => !Object.hasOwn(rules, key)),
    ...Object.entries(rules),
  ]);
}

/**
 * Compile while raw directives still distinguish deliberate grants from
 * automatic/default grants. The token resolver remains the authority for
 * surviving additions, exclusions and removals; its result alone cannot tell
 * which grants the user deliberately selected.
 */
export function composeAgentSkillPermissions(
  name: string,
  override: AgentOverrideConfig = {},
  options: SkillProjectionOptions = {},
): SkillPermissions {
  return compileSkillProducts(name, override, options).permissions;
}

function compileSkillProducts(
  name: string,
  override: AgentOverrideConfig,
  options: SkillProjectionOptions,
): {
  selection: SkillSelection;
  permissions: SkillPermissions;
  admission: SkillAdmission;
} {
  assertSkillPolicyConfig({ agents: { [name]: override } });
  assertSkillNames(options.localSkillNames, 'local skill names');
  // Keep provenance alongside the compatibility view: literal IDs must never
  // return through the directive parser, even after normalization.
  const selection = resolveAgentSkillSelection(name, override, {
    localNames: options.localSkillNames,
    defaults: options.defaultSkills,
  });
  const effective = selection
    .filter((entry) => entry.kind === 'directive')
    .map((entry) => entry.token);
  const generated = getSkillPermissionsForSelection(
    selection,
    options.disabledSkills,
  );
  const admission: SkillAdmission = Object.fromEntries(
    Object.entries(generated).map(([key, effect]) => [
      key,
      effect === 'deny' ? 'deny' : 'allow',
    ]),
  );
  const skillRule =
    typeof override.permission === 'object'
      ? override.permission.skill
      : undefined;
  if (skillRule === undefined)
    return { selection, permissions: generated, admission };

  const configured =
    typeof skillRule === 'string' ? { '*': skillRule } : skillRule;
  let permissions = appendRules(generated, configured);
  const automaticPolicy = compilePermissionPolicy({
    baselineRules: [],
    hostRules: Object.entries(permissions).map(([resource, effect]) => ({
      action: 'skill',
      resource,
      effect,
    })),
  });
  for (const key of Object.keys(generated)) {
    if (!/[*?]/.test(key))
      permissions = appendRules(permissions, {
        [key]: automaticPolicy.decide('skill', key),
      });
  }
  const explicit = new Set([
    ...(override.skills ?? []),
    ...(override.skills_add ?? []),
  ]);
  const deliberate = getSkillPermissionsForAgent(
    name,
    (effective ?? []).filter((token) => explicit.has(token)),
  );
  // Only a base list selects a whole-tool default. Add-only directives must
  // not turn the inherited/default grants into deliberate exceptions.
  if (
    override.skills === undefined &&
    !['*', '?*', '!*'].some(
      (token) => explicit.has(token) && effective?.includes(token),
    )
  )
    delete deliberate['*'];
  if (
    override.skills !== undefined &&
    !['*', '?*', '!*'].some(
      (token) => effective?.includes(token) && explicit.has(token),
    )
  ) {
    // An explicit base denies unselected names, not selected local additions.
    // Keep their bounded decisions behind that floor and ahead of deliberate
    // named grants. Explicit wildcard tokens retain their own resolver order.
    permissions = appendRules(permissions, { '*': 'deny' });
    for (const key of Object.keys(generated)) {
      if (key !== '*')
        permissions = appendRules(permissions, {
          [key]: automaticPolicy.decide('skill', key),
        });
    }
    delete deliberate['*'];
  }
  permissions = appendRules(permissions, deliberate);

  const protectedNames = new Set([
    ...(effective ?? [])
      .filter((token) => token.startsWith('!') || token.startsWith('?'))
      .map((token) => token.slice(1)),
    ...(override.skills_remove ?? []).filter((token) => !/^[!?]/.test(token)),
    ...(options.disabledSkills ?? []),
  ]);
  // Keep surviving token gates and explicit removals/disabled names final.
  // Wildcard tokens retain their resolver order relative to exact exceptions.
  for (const key of protectedNames) {
    if (key === '*') continue;
    const effect = Object.hasOwn(generated, key) ? generated[key] : 'deny';
    if (effect !== 'allow')
      permissions = appendRules(permissions, { [key]: effect });
  }
  return { selection, permissions, admission };
}

export function compileEffectiveAgentProjection(
  agents: Record<string, AgentOverrideConfig>,
  localSkillNames: () => readonly string[],
  options: {
    readonly defaultSkills?: Readonly<Record<string, readonly string[]>>;
    readonly disabledSkills?: readonly string[];
  } = {},
): EffectiveAgentProjection {
  assertSkillPolicyConfig({ agents });
  assertSkillNames(options.disabledSkills, 'disabled_skills');
  for (const skills of Object.values(options.defaultSkills ?? {}))
    assertSkillNames(skills, 'default skill IDs');
  const raw = mergeAgentOverrides({}, agents);
  const names = Object.values(raw).some((agent) => agent.skills_include_local)
    ? localSkillNames()
    : [];
  const normalized = resolveEffectiveAgentOverrides(
    raw,
    () => names,
    options.defaultSkills,
  );
  const skillPermissions: Record<string, SkillPermissions> = {};
  const skillSelections: Record<string, SkillSelection> = {};
  const skillAdmission: Record<string, SkillAdmission> = {};
  for (const name of new Set([
    ...Object.keys(raw),
    ...Object.keys(options.defaultSkills ?? {}),
  ])) {
    const products = compileSkillProducts(name, raw[name] ?? {}, {
      localSkillNames: names,
      defaultSkills: options.defaultSkills?.[name],
      disabledSkills: options.disabledSkills,
    });
    skillPermissions[name] = products.permissions;
    skillSelections[name] = products.selection;
    skillAdmission[name] = products.admission;
  }
  return {
    agents: normalized,
    skillSelections,
    skillPermissions,
    skillAdmission,
  };
}
