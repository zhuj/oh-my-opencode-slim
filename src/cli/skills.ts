import { AGENT_ALIASES } from '../config/constants';
import {
  assertSkillIdentifier,
  assertSkillNames,
  assertSkillPattern,
} from '../utils/skill-policy-validation';
import { CUSTOM_SKILLS } from './custom-skills';

/**
 * A skill that is managed externally (e.g. user-installed) and needs
 * permission grants but is NOT installed by this plugin's CLI.
 */
export interface PermissionOnlySkill {
  /** Skill name - must match the name OpenCode uses for permission checks */
  name: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Human-readable description (for documentation only) */
  description: string;
}

/**
 * Skills managed externally (not installed by this plugin's CLI).
 * Entries here only affect agent permission grants - nothing is installed.
 */
export const PERMISSION_ONLY_SKILLS: PermissionOnlySkill[] = [
  {
    name: 'requesting-code-review',
    allowedAgents: ['oracle'],
    description:
      'Code review template for reviewer subagents in multi-step workflows',
  },
];

/**
 * Names of the skills an agent is granted by default when no explicit
 * `skills` list is configured: bundled custom skills plus
 * externally-managed skills whose `allowedAgents` includes `'*'` or the
 * canonical agent name. Order follows the registries: CUSTOM_SKILLS first,
 * then PERMISSION_ONLY_SKILLS.
 */
export function getDefaultGrantedSkillNames(agentName: string): string[] {
  const canonicalAgentName = AGENT_ALIASES[agentName] ?? agentName;
  const names: string[] = [];
  for (const skill of [...CUSTOM_SKILLS, ...PERMISSION_ONLY_SKILLS]) {
    assertSkillIdentifier(skill.name, 'bundled skill registry');
    if (
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(canonicalAgentName)
    ) {
      names.push(skill.name);
    }
  }
  return names;
}

/** Internal selections retain source identity after directive folding. */
export type SkillSelectionEntry =
  | {
      readonly kind: 'literal';
      readonly name: string;
      readonly effect: 'allow';
    }
  | {
      readonly kind: 'directive';
      readonly name: string;
      readonly effect: 'allow' | 'ask' | 'deny';
      readonly token: string;
    };
export type SkillSelection = readonly SkillSelectionEntry[];

function directiveSelection(
  tokens: readonly string[],
): Extract<SkillSelectionEntry, { kind: 'directive' }>[] {
  assertSkillNames(tokens, 'skill directives', true);
  return tokens.map((token) => ({
    kind: 'directive',
    token,
    name: /^[!?]/.test(token) ? token.slice(1) : token,
    effect: token.startsWith('!')
      ? 'deny'
      : token.startsWith('?')
        ? 'ask'
        : 'allow',
  }));
}

function literalSelection(names: readonly string[]): SkillSelectionEntry[] {
  assertSkillNames(names, 'literal skill IDs');
  return names.map((name) => ({ kind: 'literal', name, effect: 'allow' }));
}

function defaultSkillSelection(
  agentName: string,
  includeNamedGrants = true,
): SkillSelection {
  const grants = literalSelection(getDefaultGrantedSkillNames(agentName));
  return agentName === 'orchestrator'
    ? [...directiveSelection(['*']), ...(includeNamedGrants ? grants : [])]
    : grants;
}

/** Compatibility view only; never re-parse this lossy view as directives. */
export function skillSelectionValues(selection: SkillSelection): string[] {
  return selection.map((entry) =>
    entry.kind === 'directive' ? entry.token : entry.name,
  );
}

export function getSkillPermissionsForSelection(
  selection: SkillSelection,
  disabledSkillNames: readonly string[] = [],
): Record<string, 'allow' | 'ask' | 'deny'> {
  assertSkillNames(disabledSkillNames, 'disabled_skills');
  const disabled = new Set(
    Array.isArray(disabledSkillNames) ? disabledSkillNames : [],
  );
  const permissions: Record<string, 'allow' | 'ask' | 'deny'> = { '*': 'deny' };
  for (const entry of selection) {
    switch (entry.kind) {
      case 'literal':
        assertSkillIdentifier(entry.name, 'resolved skill ID');
        break;
      case 'directive':
        assertSkillPattern(entry.name, 'resolved skill directive');
        break;
    }
    if (
      entry.effect !== 'allow' ||
      entry.name === '*' ||
      !disabled.has(entry.name)
    )
      Object.defineProperty(permissions, entry.name, {
        value: entry.effect,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  for (const name of disabled)
    Object.defineProperty(permissions, name, {
      value: 'deny',
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return permissions;
}

/** Explicit lists are config directives; registry defaults are literal IDs. */
export function getSkillPermissionsForAgent(
  agentName: string,
  skillList?: readonly string[],
  disabledSkillNames?: readonly string[],
): Record<string, 'allow' | 'ask' | 'deny'> {
  const selection =
    skillList === undefined
      ? defaultSkillSelection(agentName)
      : directiveSelection(skillList);
  return getSkillPermissionsForSelection(selection, disabledSkillNames);
}

export function resolveSkillSelection(input: {
  readonly agentName: string;
  readonly base?: readonly string[];
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
  readonly defaults?: readonly string[];
  readonly localNames?: readonly string[];
}): SkillSelection {
  const base = directiveSelection(input.base ?? []);
  const add = directiveSelection(input.add ?? []);
  directiveSelection(input.remove ?? []);
  const defaults =
    input.defaults === undefined
      ? defaultSkillSelection(
          input.agentName,
          !input.add?.length &&
            !input.remove?.length &&
            !input.localNames?.length,
        )
      : literalSelection(input.defaults);
  const locals = literalSelection(input.localNames ?? []);
  const remove = new Set(input.remove ?? []);
  const removedNames = new Set(
    [...remove].filter((token) => !/^[!?]/.test(token)),
  );
  const remaining = (input.base === undefined ? defaults : base).filter(
    (entry) =>
      entry.kind === 'directive'
        ? !remove.has(entry.token)
        : !removedNames.has(entry.name),
  );
  const excluded = new Set(
    remaining
      .filter((entry) => entry.kind === 'directive' && entry.effect === 'deny')
      .map((entry) => entry.name),
  );
  const selected = new Map<string, SkillSelectionEntry>();
  for (const entry of [
    ...remaining,
    ...add.filter(
      (entry) => !excluded.has(entry.token) && !remove.has(entry.token),
    ),
    ...locals.filter(
      (entry) => !excluded.has(entry.name) && !removedNames.has(entry.name),
    ),
  ]) {
    const key = JSON.stringify([entry.name, entry.effect]);
    if (selected.get(key)?.kind !== 'directive') selected.set(key, entry);
  }
  const list = [...selected.values()];
  if (list.some((entry) => entry.name === '*' && entry.effect === 'allow')) {
    for (const token of remove) {
      if (token.startsWith('!')) continue;
      const exclusion = `!${token}`;
      if (
        !list.some(
          (entry) => entry.kind === 'directive' && entry.token === exclusion,
        )
      )
        list.push(...directiveSelection([exclusion]));
    }
  }
  return list;
}

/**
 * Short, model-facing summary of an agent's final skill rules (the record
 * the host enforces): `''` (none), `'all'`, `'all except a, b'`, or
 * `'a, b'`. The host applies the last matching rule in key order, so a
 * named rule placed before `'*'` is shadowed and not listed.
 */
export function summarizeSkillGrants(
  rules: Readonly<Record<string, 'allow' | 'ask' | 'deny'>>,
): string {
  const entries = Object.entries(rules);
  const named = entries.slice(entries.findIndex(([name]) => name === '*') + 1);
  if (rules['*'] === 'allow') {
    const denied = named
      .filter(([, rule]) => rule !== 'allow')
      .map(([name]) => name);
    return denied.length > 0 ? `all except ${denied.join(', ')}` : 'all';
  }
  return named
    .filter(([, rule]) => rule === 'allow')
    .map(([name]) => name)
    .join(', ');
}

/**
 * Fold per-agent skill directives into an effective skills list.
 *
 * 1. Without a base `skills` list the working base is the agent's default
 *    grants (orchestrator defaults to allow-all, so its working base is
 *    `['*']`), so `skills_add` alone keeps the defaults and appends, and
 *    `skills_remove` alone prunes from the defaults.
 * 2. Explicit token removals are applied to the working base first. This
 *    lets `skills_remove: ['!name']` lift an inherited exclusion before
 *    additions are evaluated.
 * 3. Remaining exclusion (`'!name'`) tokens prevent `skills_add` from
 *    re-granting the excluded skill. Plain-name removals also suppress an
 *    addition of the same name, so removal wins over addition.
 * 4. If the result contains `'*'`, a plain-name removal is granted
 *    implicitly by the wildcard, so it is made explicit by appending the
 *    existing `'!name'` exclusion token - unless already present.
 *
 * This string view cannot encode literal/directive provenance. Policy
 * compilation must consume `resolveSkillSelection` instead of re-parsing it.
 *
 * Returns `undefined` when nothing is configured to resolve (no base, no
 * additions, no removals) so the agent keeps its default skill behavior.
 */
export function resolveEffectiveSkills(
  agentName: string,
  base: readonly string[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
  defaultSkills?: readonly string[],
): string[] | undefined {
  const selection = resolveSkillSelection({
    agentName,
    base,
    add,
    remove,
    defaults: defaultSkills,
  });
  if (base === undefined && !add?.length && !remove?.length) return undefined;
  return skillSelectionValues(selection);
}
