/** Array-index keys are reordered ahead of other JS object properties. */
export function isIntegerIndexSkill(value: string): boolean {
  const number = Number(value);
  return (
    Number.isInteger(number) &&
    number >= 0 &&
    number < 4_294_967_295 &&
    String(number) === value
  );
}

export class InvalidSkillPolicyError extends Error {
  constructor(
    value: string,
    context: string,
    reason: 'integer-index' | 'wildcard' = 'integer-index',
  ) {
    super(
      reason === 'integer-index'
        ? `Unsupported integer-index skill identifier ${JSON.stringify(value)} in ${context}; use a non-index skill ID to preserve permission order.`
        : `Unsupported wildcard skill identifier ${JSON.stringify(value)} in ${context}; actual skill IDs must not contain ? or *.`,
    );
    this.name = 'InvalidSkillPolicyError';
  }
}

export function isSupportedSkillIdentifier(value: string): boolean {
  return !isIntegerIndexSkill(value) && !/[?*]/.test(value);
}

/** Policy patterns keep their wildcard language; only index keys reorder. */
export function assertSkillPattern(value: string, context: string): void {
  if (isIntegerIndexSkill(value))
    throw new InvalidSkillPolicyError(value, context);
}

/** Actual IDs are literal identities, not permission pattern syntax. */
export function assertSkillIdentifier(
  value: string,
  context = 'skill identity',
): void {
  assertSkillPattern(value, context);
  if (/[?*]/.test(value))
    throw new InvalidSkillPolicyError(value, context, 'wildcard');
}

/** Mirrors the existing host matcher; shared so guards use the same language. */
export function permissionPatternMatches(
  pattern: string,
  value: string,
): boolean {
  const normalized = pattern.replaceAll('\\', '/');
  const target = value.replaceAll('\\', '/');
  const variants =
    normalized.endsWith(' *') && !normalized.endsWith(' **')
      ? [normalized.slice(0, -2), normalized]
      : [normalized];
  return variants.some((variant) => {
    const expression = variant
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${expression}$`, 's').test(target);
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Prefix interpretation is confined to directive arrays, never map keys. */
export function assertSkillNames(
  value: unknown,
  context: string,
  directives = false,
): void {
  for (const name of Array.isArray(value) ? value : [value]) {
    if (typeof name !== 'string') continue;
    if (directives)
      assertSkillPattern(/^[!?]/.test(name) ? name.slice(1) : name, context);
    else assertSkillIdentifier(name, context);
  }
}

export function assertSkillPermissionMap(
  value: unknown,
  context = 'permission map',
): void {
  for (const [action, rule] of Object.entries(record(value) ?? {})) {
    if (!permissionPatternMatches(action, 'skill')) continue;
    for (const resource of Object.keys(record(rule) ?? {})) {
      assertSkillPattern(resource, `${context}.${action}`);
    }
  }
}

export function assertSkillRules(
  value: unknown,
  context = 'ordered permission rules',
): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const rule = record(entry);
    if (
      typeof rule?.action === 'string' &&
      typeof rule.resource === 'string' &&
      permissionPatternMatches(rule.action, 'skill')
    ) {
      assertSkillPattern(rule.resource, context);
    }
  }
}

function assertAgent(value: unknown, context: string): void {
  const agent = record(value);
  if (!agent) return;
  for (const key of ['skills', 'skills_add', 'skills_remove']) {
    assertSkillNames(agent[key], `${context}.${key}`, true);
  }
  assertSkillPermissionMap(agent.permission, `${context}.permission`);
}

function assertAgents(value: unknown, context: string): void {
  for (const [name, agent] of Object.entries(record(value) ?? {})) {
    assertAgent(agent, `${context}.${name}`);
  }
}

/** Inspect known raw fields before schema fallback, normalization or merging. */
export function assertSkillPolicyConfig(
  value: unknown,
  context = 'configuration',
): void {
  const config = record(value);
  if (!config) return;
  assertSkillNames(config.disabled_skills, `${context}.disabled_skills`);
  assertSkillPermissionMap(config.permission, `${context}.permission`);
  assertAgents(config.agents, `${context}.agents`);
  assertAgents(config.agent, `${context}.agent`);
  for (const [name, preset] of Object.entries(record(config.presets) ?? {})) {
    // Both supported preset spellings must be checked before safeParse can
    // discard a layer, including one with an unrelated schema violation.
    assertAgents(preset, `${context}.presets.${name}`);
    assertAgents(record(preset)?.agents, `${context}.presets.${name}.agents`);
  }
}
