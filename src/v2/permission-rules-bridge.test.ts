/**
 * v2 per-session permission rules bridge (`ctx.session.update` with a
 * `permissions` payload, v2.0.5).
 *
 * The bridge installs the managed child's finalized permission policy when
 * available. The legacy exact-rule helper derives exact resources and
 * whole-tool effects (resource '*'); finalized registry policies also preserve
 * ordered native wildcard rules and capability ceilings.
 *
 * Coverage:
 * - (a) rules are applied when a plugin-managed child session is created
 * - (b) hosts without `session.update` no-op with a ONE-TIME
 *   deterministic warning (the commit-2bf290ad degradation pattern)
 * - (c) duplicate session.created delivery for the same sessionID is
 *   idempotent (applied exactly once per child)
 * - (d) the legacy helper skips wildcard patterns while whole-tool effects
 *   retain the canonical '*' resource
 * - (e) failures are logged, never thrown into the event pump
 * - matrix: every built-in agent derives a non-empty, declaration-
 *   faithful exact ruleset — whole-tool declarations included (resource
 *   = the host-canonical `'*'`), so read-only agents (which declare their
 *   capability set as whole-tool effects) never strand a child on the
 *   parent's inherited session rules
 * - gates: root sessions (no parentID) and foreign agents are never
 *   touched (session.update's `permissions` payload REPLACES the
 *   session-scoped list)
 * - wiring: the createV2Setup event pump dispatches raw session.created
 *   events into the bridge (full-setup test, fixture pattern from
 *   setup-compaction.test.ts)
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createAgents } from '../agents/index';
import { CUSTOM_SKILLS } from '../cli/custom-skills-registry';
import { PluginConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { OhMyOpenCodeLite } from '../index';
import { withTmpDir } from '../test-utils';
import { InvalidSkillPolicyError } from '../utils/skill-policy-validation';
import { compilePermissionPolicy } from './permissions';
import {
  createPermissionRulesBridge,
  createV2Setup,
  deriveExactPermissionRules,
  resetV2GenerationWarnings,
} from './setup';
import type {
  V2Context,
  V2PermissionRule,
  V2Session,
  V2SessionPromptEvent,
} from './types';

/** Task-policy fixture: nested exact patterns alongside entries that
 * cannot be expressed exactly (the '*' catch-all key, wildcard resource
 * patterns). Whole-tool string effects derive an action-scoped rule
 * (resource = '*'); nested wildcard patterns and the
 * catch-all key remain underivable. */
const TASK_POLICY = {
  '*': 'deny',
  edit: 'deny',
  bash: {
    'git push': 'ask',
    'rm -rf *': 'deny',
    '*': 'ask',
  },
  task: { explorer: 'allow' },
  webfetch: { 'https://example.com/private': 'deny' },
  skill: { codemap: 'allow' },
};

/** deriveExactPermissionRules(TASK_POLICY) — insertion order, with the
 * v1→v2 action mapping (bash → shell+bash, task → subagent). The
 * whole-tool `edit: 'deny'` derives the host-canonical `'*'`-resource
 * rule; only the wildcard-pattern shapes are skipped. */
const EXACT_RULES: V2PermissionRule[] = [
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'shell', resource: 'git push', effect: 'ask' },
  { action: 'bash', resource: 'git push', effect: 'ask' },
  { action: 'subagent', resource: 'explorer', effect: 'allow' },
  {
    action: 'webfetch',
    resource: 'https://example.com/private',
    effect: 'deny',
  },
  { action: 'skill', resource: 'codemap', effect: 'allow' },
];

type RulesCall = { sessionID: string; permissions: V2PermissionRule[] };

function makeChildCreatedEvent(
  payload: Record<string, unknown>,
  payloadKey: 'data' | 'properties' = 'data',
): Record<string, unknown> {
  return {
    type: 'session.created',
    [payloadKey]: {
      sessionID: 'ses_child_1',
      parentID: 'ses_parent',
      agent: 'probe',
      ...payload,
    },
  };
}

/** Session-domain stub: `update` captures when a function is given; the
 * no-argument shape is a reduced-host session domain without `update`. */
function makeSession(update?: (input: unknown) => Promise<unknown>): V2Session {
  return (update ? { update } : {}) as unknown as V2Session;
}

function makeBridge(options?: {
  session?: V2Session;
  policy?: unknown;
  pluginAgents?: ReadonlySet<string>;
  onUnavailable?: () => void;
  requireKnownIdentity?: boolean | (() => boolean);
  marketplaceAgentNames?: () => ReadonlySet<string>;
  knownAgentNames?: () => ReadonlySet<string>;
  defaultAgent?: () => string | undefined;
}): ReturnType<typeof createPermissionRulesBridge> {
  return createPermissionRulesBridge(options?.session, {
    permissionForAgent: (agent) =>
      agent === 'probe'
        ? options && Object.hasOwn(options, 'policy')
          ? options.policy
          : TASK_POLICY
        : undefined,
    pluginAgents: options?.pluginAgents ?? new Set(['probe']),
    ...(options?.requireKnownIdentity !== undefined
      ? { requireKnownIdentity: options.requireKnownIdentity }
      : {}),
    ...(options?.marketplaceAgentNames
      ? { marketplaceAgentNames: options.marketplaceAgentNames }
      : {}),
    ...(options?.knownAgentNames
      ? { knownAgentNames: options.knownAgentNames }
      : {}),
    ...(options?.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
    ...(options?.onUnavailable ? { onUnavailable: options.onUnavailable } : {}),
  });
}

describe('deriveExactPermissionRules', () => {
  test('derives only the exact-match entries, with v1→v2 action mapping', () => {
    expect(deriveExactPermissionRules(TASK_POLICY)).toEqual(EXACT_RULES);
  });

  test('whole-tool effects derive host-canonical *-resource rules; the string shorthand is skipped', () => {
    // A whole-tool effect (edit: 'deny') covers every resource of the
    // tool; the host-canonical expression of that scope is the `'*'`
    // resource — what `whollyDisabled` keys on and what the static agent
    // registration emits. The string shorthand applies to every ACTION
    // and is still skipped — the static agent rules carry it.
    expect(deriveExactPermissionRules('ask')).toEqual([]);
    expect(deriveExactPermissionRules({ edit: 'deny', read: 'allow' })).toEqual(
      [
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
      ],
    );
    // v1→v2 action aliasing applies to whole-tool entries too.
    expect(deriveExactPermissionRules({ bash: 'deny' })).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'bash', resource: '*', effect: 'deny' },
    ]);
    expect(deriveExactPermissionRules({ task: 'deny' })).toEqual([
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
  });

  test('question-mark wildcards are rejected like asterisks', () => {
    expect(
      deriveExactPermissionRules({ bash: { 'git push?': 'ask' } }),
    ).toEqual([]);
  });

  test('invalid shapes and invalid effects yield no rules', () => {
    expect(deriveExactPermissionRules(undefined)).toEqual([]);
    expect(deriveExactPermissionRules(null)).toEqual([]);
    expect(deriveExactPermissionRules(['edit'])).toEqual([]);
    expect(
      deriveExactPermissionRules({
        webfetch: { 'https://x.example': 'maybe' },
      }),
    ).toEqual([]);
    expect(deriveExactPermissionRules({ read: 'maybe' })).toEqual([]);
  });
});

// ── Built-in agent derivation matrix (incident: explorer derived 0 rules) ──

/** v1 tool keys the v2 evaluator addresses under a different action name. */
const V1_KEY_TO_V2_ACTIONS: Record<string, readonly string[]> = {
  task: ['subagent'],
  bash: ['shell', 'bash'],
};

function v2ActionsForV1Key(key: string): readonly string[] {
  return V1_KEY_TO_V2_ACTIONS[key] ?? [key];
}

type AgentPermissionMap = Record<
  string,
  'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
>;

/** Every whole-tool declaration (wildcard-free key, valid effect) must
 * survive derivation as an action-scoped exact rule per v2 action. */
function coversWholeToolDeclarations(
  rules: V2PermissionRule[],
  map: AgentPermissionMap,
): boolean {
  for (const [tool, value] of Object.entries(map)) {
    if (typeof value !== 'string') continue;
    if (value !== 'allow' && value !== 'deny' && value !== 'ask') continue;
    if (tool.includes('*') || tool.includes('?')) continue;
    for (const action of v2ActionsForV1Key(tool)) {
      if (
        !rules.some(
          (rule) =>
            rule.action === action &&
            rule.resource === '*' &&
            rule.effect === value,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** No-widening gate: every derived rule must trace back to a declaration —
 * either the whole-tool entry its resource names, or a nested non-wildcard
 * pattern entry on a tool key that maps to the rule's action. */
function everyRuleIsDeclared(
  rules: V2PermissionRule[],
  map: AgentPermissionMap,
): boolean {
  for (const rule of rules) {
    const declared = Object.entries(map).some(([tool, value]) => {
      if (!v2ActionsForV1Key(tool).includes(rule.action)) return false;
      if (
        rule.resource !== '*' &&
        (rule.resource.includes('*') || rule.resource.includes('?'))
      )
        return false;
      if (value === rule.effect && rule.resource === '*') return true;
      return (
        !!value &&
        typeof value === 'object' &&
        value[rule.resource] === rule.effect
      );
    });
    if (!declared) return false;
  }
  return true;
}

/** Host-canonical rule shapes: no wildcard ACTIONS; resources are the
 * whole-tool `'*'` or wildcard-free patterns. */
function rulesAreHostCanonical(rules: V2PermissionRule[]): boolean {
  return rules.every(
    (rule) =>
      !rule.action.match(/[*?]/) &&
      (rule.resource === '*' || !rule.resource.match(/[*?]/)),
  );
}

/** Real resolved permission maps from the production agent pipeline
 * (createAgents + applyDefaultPermissions — exactly what the bridge's
 * permissionForAgent receives via the config() hook). Council mode is
 * enabled so the councillor (the one built-in that DECLARES a read-only
 * tool set) and the synthesis-only council agent are part of the matrix. */
function builtInAgentPermissionMaps(): Map<string, AgentPermissionMap> {
  const dir = 'v2-perm-rules-matrix';
  RuntimeConfig.reset(dir);
  RuntimeConfig.init(
    dir,
    PluginConfigSchema.parse({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
    }),
  );
  const maps = new Map<string, AgentPermissionMap>();
  for (const agent of createAgents(RuntimeConfig.get(dir))) {
    maps.set(agent.name, (agent.config.permission ?? {}) as AgentPermissionMap);
  }
  return maps;
}

describe('built-in agent permission-rule derivation matrix', () => {
  // Shared, computed once: deriving from the real resolved maps keeps the
  // matrix honest against definition drift.
  let maps: Map<string, AgentPermissionMap>;
  beforeAll(() => {
    maps = builtInAgentPermissionMaps();
  });

  test('the expected built-in roster is present', () => {
    for (const name of [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'council',
      'councillor',
    ]) {
      expect(maps.has(name), `agent ${name} missing from matrix`).toBe(true);
    }
  });

  test.each([
    'orchestrator',
    'explorer',
    'oracle',
    'designer',
    'fixer',
    'council',
    'councillor',
  ])('%s derives a non-empty, declaration-faithful rule set', (name) => {
    const map = maps.get(name) as AgentPermissionMap;
    const rules = deriveExactPermissionRules(map);
    // Incident fix: 0 rules meant the bridge skipped session.update and
    // the child stayed on inherited parent session rules.
    expect(rules.length).toBeGreaterThan(0);
    expect(rulesAreHostCanonical(rules)).toBe(true);
    expect(coversWholeToolDeclarations(rules, map)).toBe(true);
    expect(everyRuleIsDeclared(rules, map)).toBe(true);
  });

  test('councillor (declared read-only set) derives read-class allow rules', () => {
    const rules = deriveExactPermissionRules(
      maps.get('councillor') as AgentPermissionMap,
    );
    for (const action of [
      'read',
      'glob',
      'grep',
      'lsp',
      'list',
      'codesearch',
      'ast_grep_search',
    ]) {
      expect(rules).toContainEqual({
        action,
        resource: '*',
        effect: 'allow',
      });
    }
    // The declared write-class boundary is carried too.
    for (const action of ['edit', 'write', 'apply_patch']) {
      expect(rules).toContainEqual({
        action,
        resource: '*',
        effect: 'deny',
      });
    }
  });

  test('council (synthesis-only) derives no allow rules', () => {
    const rules = deriveExactPermissionRules(
      maps.get('council') as AgentPermissionMap,
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.effect !== 'allow')).toBe(true);
  });

  test('fixer and designer derive question deny rules (default flip)', () => {
    for (const name of ['fixer', 'designer'] as const) {
      const rules = deriveExactPermissionRules(
        maps.get(name) as AgentPermissionMap,
      );
      expect(rules).toContainEqual({
        action: 'question',
        resource: '*',
        effect: 'deny',
      });
    }
  });

  test('explorer row (incident): bridge applies the derived rules to the child session', async () => {
    const calls: RulesCall[] = [];
    const bridge = createPermissionRulesBridge(
      makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      {
        permissionForAgent: (agent) => maps.get(agent),
        pluginAgents: new Set(maps.keys()),
      },
    );

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'explorer' }),
    );

    // Before the fix this was 0 calls ("no exact-match rules derivable")
    // and the child kept the parent's inherited session-scoped rules.
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses_child_1');
    expect(calls[0].permissions.length).toBeGreaterThan(0);
    expect(rulesAreHostCanonical(calls[0].permissions)).toBe(true);
    expect(calls[0].permissions).toContainEqual({
      action: 'question',
      resource: '*',
      effect: 'deny',
    });
  });

  test('councillor row: applied rules include the read-class allows', async () => {
    const calls: RulesCall[] = [];
    const bridge = createPermissionRulesBridge(
      makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      {
        permissionForAgent: (agent) => maps.get(agent),
        pluginAgents: new Set(maps.keys()),
      },
    );

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'councillor' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].permissions).toContainEqual({
      action: 'read',
      resource: '*',
      effect: 'allow',
    });
    expect(calls[0].permissions).toContainEqual({
      action: 'grep',
      resource: '*',
      effect: 'allow',
    });
  });
});

describe('createPermissionRulesBridge', () => {
  beforeEach(() => {
    resetV2GenerationWarnings();
  });

  test('without session.get, ordinary prompts continue but observed unknown children block', async () => {
    const ordinary = makeBridge({
      session: makeSession(),
    });
    await expect(
      ordinary.ensurePromptPermission('ses_ordinary_root'),
    ).resolves.toBeUndefined();

    const marketplace = makeBridge({
      session: makeSession(),
      requireKnownIdentity: true,
    });
    await marketplace.observeEvent({
      type: 'session.created',
      data: { sessionID: 'ses_marketplace_child', parentID: 'ses_parent' },
    });
    await expect(
      marketplace.ensurePromptPermission('ses_marketplace_child'),
    ).rejects.toThrow('child session identity is unknown');

    await ordinary.dispose();
    await marketplace.dispose();
  });

  test('blocks an unobserved root prompt when marketplace policy is active and lookup is unavailable', async () => {
    const bridge = makeBridge({
      session: makeSession(),
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
    });

    await expect(
      bridge.ensurePromptPermission('ses_unobserved_marketplace_root'),
    ).rejects.toThrow('child session identity is unknown');
    await bridge.dispose();
  });

  test.each([
    ['marketplace finalizes before the child event', true],
    ['the child event precedes marketplace finalization', false],
  ])(
    'reads marketplace readiness live when %s',
    async (_order, finalizedBeforeChild) => {
      let finalized = finalizedBeforeChild;
      const marketplace = makeBridge({
        session: makeSession(),
        requireKnownIdentity: () => finalized,
      });
      if (!finalizedBeforeChild) {
        await marketplace.observeEvent({
          type: 'session.created',
          data: {
            sessionID: 'ses_deferred_marketplace_child',
            parentID: 'ses_parent',
            agent: 'unclassified-agent',
          },
        });
        await expect(
          marketplace.ensurePromptPermission('ses_deferred_marketplace_child'),
        ).resolves.toBeUndefined();
        finalized = true;
      } else {
        await marketplace.observeEvent({
          type: 'session.created',
          data: {
            sessionID: 'ses_deferred_marketplace_child',
            parentID: 'ses_parent',
            agent: 'unclassified-agent',
          },
        });
      }
      await expect(
        marketplace.ensurePromptPermission('ses_deferred_marketplace_child'),
      ).rejects.toThrow('child session identity is unknown');
      await marketplace.dispose();
    },
  );

  test('blocks direct root marketplace agents without replacing root permissions', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      pluginAgents: new Set(['probe', 'package-agent']),
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent', 'PackageAlias']),
    });
    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'ses_root_package', agent: 'package-agent' },
    });

    await expect(
      bridge.ensurePromptPermission('ses_root_package'),
    ).rejects.toThrow('direct root marketplace agent');
    expect(calls).toEqual([]);
    await bridge.dispose();
  });

  test('resolves root identities without an agent before admitting marketplace prompts', async () => {
    let lookupCount = 0;
    const bridge = makeBridge({
      session: {
        get: async () => {
          lookupCount += 1;
          return {
            data: {
              sessionID: 'ses_root_without_agent',
              agent: 'host-orchestrator',
            },
          };
        },
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
      knownAgentNames: () => new Set(['host-orchestrator']),
      pluginAgents: new Set(['probe']),
    });
    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'ses_root_without_agent' },
    });

    await expect(
      bridge.ensurePromptPermission('ses_root_without_agent'),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(1);
    await bridge.dispose();
  });

  test('admits a known foreign root from the created event without a session lookup', async () => {
    let lookupCount = 0;
    const bridge = makeBridge({
      session: {
        get: async () => {
          lookupCount += 1;
          throw new Error('session lookup must not run');
        },
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
    });
    await bridge.observeEvent({
      type: 'session.created',
      data: {
        sessionID: 'ses_permission_reviewer',
        agent: 'permission-reviewer',
      },
    });

    await expect(
      bridge.ensurePromptPermission('ses_permission_reviewer'),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(0);
    await bridge.dispose();
  });

  test('admits a known foreign root when the first prompt races ahead of session.created', async () => {
    let lookupCount = 0;
    let resolveLookup!: (value: {
      data: { sessionID: string; agent: string };
    }) => void;
    const bridge = makeBridge({
      session: {
        get: () => {
          lookupCount += 1;
          return new Promise((resolve) => {
            resolveLookup = resolve;
          });
        },
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
    });

    // The prompt hook runs before the asynchronous event pump has observed
    // session.created. It must await the deterministic lookup before it
    // admits the prompt; there is no sleep or retry.
    let settled = false;
    const pending = bridge
      .ensurePromptPermission('ses_permission_reviewer_race')
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(lookupCount).toBe(1);
    expect(settled).toBe(false);

    resolveLookup({
      data: {
        sessionID: 'ses_permission_reviewer_race',
        agent: 'permission-reviewer',
      },
    });
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);

    // A late created event must reuse the cached identity, not re-query.
    await bridge.observeEvent({
      type: 'session.created',
      data: {
        sessionID: 'ses_permission_reviewer_race',
        agent: 'permission-reviewer',
      },
    });
    await expect(
      bridge.ensurePromptPermission('ses_permission_reviewer_race'),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(1);
    await bridge.dispose();
  });

  test('uses the created event when it arrives during the first-prompt lookup', async () => {
    let lookupCount = 0;
    let resolveLookup!: (value: {
      data: { sessionID: string; agent: string };
    }) => void;
    const bridge = makeBridge({
      session: {
        get: () => {
          lookupCount += 1;
          return new Promise((resolve) => {
            resolveLookup = resolve;
          });
        },
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
    });

    const pending = bridge.ensurePromptPermission(
      'ses_permission_reviewer_overlap',
    );
    await Promise.resolve();
    expect(lookupCount).toBe(1);

    await bridge.observeEvent({
      type: 'session.created',
      data: {
        sessionID: 'ses_permission_reviewer_overlap',
        agent: 'permission-reviewer',
      },
    });
    resolveLookup({
      data: {
        sessionID: 'ses_permission_reviewer_overlap',
        agent: 'permission-reviewer',
      },
    });
    await expect(pending).resolves.toBeUndefined();
    expect(lookupCount).toBe(1);

    await expect(
      bridge.ensurePromptPermission('ses_permission_reviewer_overlap'),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(1);
    await bridge.dispose();
  });

  test('fails closed for a root without an agent when session lookup is unavailable', async () => {
    const bridge = makeBridge({
      session: makeSession(),
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
    });
    await bridge.observeEvent({
      type: 'session.created',
      data: { sessionID: 'ses_root_without_agent' },
    });

    await expect(
      bridge.ensurePromptPermission('ses_root_without_agent'),
    ).rejects.toThrow('child session identity is unknown');
    await bridge.dispose();
  });

  test('admits an agentless stored root session (`opencode run` without `--agent`) when marketplace agents are installed and default agent is non-marketplace (#1661)', async () => {
    let lookupCount = 0;
    const bridge = makeBridge({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          lookupCount += 1;
          // Host session record present, no parentID and no agent field
          return {
            data: {
              id: sessionID,
              directory: '/tmp/project',
            },
          };
        },
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
      knownAgentNames: () =>
        new Set(['orchestrator', 'probe', 'package-agent']),
      pluginAgents: new Set(['orchestrator', 'probe', 'package-agent']),
      defaultAgent: () => 'orchestrator',
    });

    await expect(
      bridge.ensurePromptPermission('ses_cli_run_default_agent'),
    ).resolves.toBeUndefined();
    expect(lookupCount).toBe(1);
    await bridge.dispose();
  });

  test('denies an agentless stored root session when its resolved default agent is a marketplace agent (#1661)', async () => {
    const bridge = makeBridge({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: {
            id: sessionID,
            directory: '/tmp/project',
          },
        }),
        update: async () => ({}),
      } as unknown as V2Session,
      requireKnownIdentity: () => true,
      marketplaceAgentNames: () => new Set(['package-agent']),
      knownAgentNames: () => new Set(['orchestrator', 'package-agent']),
      pluginAgents: new Set(['orchestrator', 'package-agent']),
      defaultAgent: () => 'package-agent',
    });

    await expect(
      bridge.ensurePromptPermission('ses_cli_run_marketplace_default'),
    ).rejects.toThrow(
      "direct root marketplace agent 'package-agent' cannot be admitted",
    );
    await bridge.dispose();
  });

  test('admits identified foreign-agent children without replacing their rules', async () => {
    const updates: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        updates.push(input as RulesCall);
        return {};
      }),
      pluginAgents: new Set(['probe']),
      requireKnownIdentity: () => true,
      knownAgentNames: () => new Set(['host-foreign-agent']),
    });
    await bridge.observeEvent(
      makeChildCreatedEvent({ agent: 'host-foreign-agent' }),
    );

    await expect(
      bridge.ensurePromptPermission('ses_child_1'),
    ).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    await bridge.dispose();
  });

  test('(a) applies exact-match rules on a plugin-managed child session', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toEqual([
      { sessionID: 'ses_child_1', permissions: EXACT_RULES },
    ]);
  });

  test('(a-legacy) reads the legacy `properties` payload spelling', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}, 'properties'));

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses_child_1');
  });

  test('(c) duplicate session.created for the same sessionID applies once', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    const event = makeChildCreatedEvent({});
    await bridge.observeSessionCreated(event);
    await bridge.observeSessionCreated(event);
    await bridge.observeSessionCreated(makeChildCreatedEvent({}, 'properties'));

    expect(calls).toHaveLength(1);
  });

  test('(b) absent capability: no-op with a one-time deterministic warning', async () => {
    const warnings: string[] = [];
    const onUnavailable = () => warnings.push('warn');

    // Host without a session domain at all...
    const domainless = makeBridge({ onUnavailable });
    await domainless.observeSessionCreated(makeChildCreatedEvent({}));
    // ...and a host whose session domain lacks the update method. Both
    // take the same capability-probe path.
    const updateless = makeBridge({
      session: makeSession(),
      onUnavailable,
    });
    await updateless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_2' }),
    );

    // ONE warning per plugin process (module-global latch), never faked
    // success: no rules were applied anywhere.
    expect(warnings).toHaveLength(1);

    // The latch is the only repeat-suppressor: after a reset the next
    // degraded host observation warns again (once).
    resetV2GenerationWarnings();
    await updateless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_3' }),
    );
    expect(warnings).toHaveLength(2);
  });

  test('(d) emitted rules are host-canonical (whole-tool * resource, no pattern wildcards)', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toHaveLength(1);
    expect(calls[0].permissions).toHaveLength(EXACT_RULES.length);
    for (const rule of calls[0].permissions) {
      expect(rule.action).not.toMatch(/[*?]/);
      expect(rule.resource === '*' || !rule.resource.match(/[*?]/)).toBe(true);
      expect(['allow', 'deny', 'ask']).toContain(rule.effect);
    }
  });

  test('(e) a throwing update() is absorbed, never thrown into the pump', async () => {
    const bridge = makeBridge({
      session: makeSession(async () => {
        throw new Error('host rejected the ruleset');
      }),
    });

    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
    // Every retry attempt stays fail-soft; the retry itself is covered
    // by (e-retry).
    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
  });

  test('(e-retry) a failed application is retried by a duplicate session.created', async () => {
    // Regression (review on #1194): the applied marker used to be set
    // before the host call, so a rejected update() permanently stranded
    // the child on inherited session rules. Completion must latch only
    // on success; failure releases the slot for the next event.
    let attempts = 0;
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient host failure');
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(1);

    // A duplicate event retries the failed application and succeeds.
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(1);

    // Success latches: further duplicates do not re-apply.
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    expect(attempts).toBe(2);
  });

  test('prompt-side application shares the in-flight update and surfaces failure', async () => {
    let finishUpdate!: () => void;
    const bridge = makeBridge({
      session: makeSession(
        () =>
          new Promise((resolve) => {
            finishUpdate = () => resolve({});
          }),
      ),
    });
    const eventApply = bridge.observeEvent(makeChildCreatedEvent({}));
    let promptDone = false;
    const promptApply = bridge
      .ensurePromptPermission('ses_child_1')
      .then(() => {
        promptDone = true;
      });
    await Promise.resolve();
    expect(promptDone).toBe(false);
    finishUpdate();
    await Promise.all([eventApply, promptApply]);
    expect(promptDone).toBe(true);

    const failed = makeBridge({
      session: makeSession(async () => {
        throw new Error('update failed');
      }),
    });
    await failed.observeEvent(makeChildCreatedEvent({}));
    await expect(failed.ensurePromptPermission('ses_child_1')).rejects.toThrow(
      'update failed',
    );
  });

  test('session.created observation remains pending until its rules update completes', async () => {
    let finishUpdate!: () => void;
    const bridge = makeBridge({
      session: makeSession(
        () =>
          new Promise((resolve) => {
            finishUpdate = () => resolve({});
          }),
      ),
    });
    let downstreamCanContinue = false;
    const dispatch = bridge
      .observeSessionCreated(makeChildCreatedEvent({}))
      .then(() => {
        downstreamCanContinue = true;
      });

    await Promise.resolve();
    expect(downstreamCanContinue).toBe(false);
    finishUpdate();
    await dispatch;
    expect(downstreamCanContinue).toBe(true);
  });

  test('unrelated session events do not stale an outstanding identity lookup', async () => {
    let resolveLookup!: (value: unknown) => void;
    const calls: RulesCall[] = [];
    const getCalls: string[] = [];
    const bridge = makeBridge({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          getCalls.push(sessionID);
          return await new Promise((resolve) => {
            resolveLookup = resolve;
          });
        },
        update: async (input: RulesCall) => {
          calls.push(input);
          return {};
        },
      } as unknown as V2Session,
    });

    const admission = bridge.ensurePromptPermission('ses_lookup_a');
    await Promise.resolve();
    expect(getCalls).toEqual(['ses_lookup_a']);
    await bridge.observeEvent({
      type: 'session.created',
      data: {
        sessionID: 'ses_unrelated_b',
        parentID: 'ses_parent',
        agent: 'probe',
      },
    });
    resolveLookup({
      data: { parentID: 'ses_parent', agent: 'probe' },
    });
    await admission;

    expect(calls.map(({ sessionID }) => sessionID)).toEqual([
      'ses_unrelated_b',
      'ses_lookup_a',
    ]);
    await bridge.dispose();
  });

  test.each([
    {
      description: 'changed creation',
      event: {
        type: 'session.created',
        data: {
          sessionID: 'ses_lookup_a',
          parentID: 'ses_parent',
          agent: 'host-agent',
        },
      },
    },
    {
      description: 'agent selection',
      event: {
        type: 'session.agent.selected',
        data: {
          sessionID: 'ses_lookup_a',
          parentID: 'ses_parent',
          agent: 'host-agent',
        },
      },
    },
    {
      description: 'deletion',
      event: {
        type: 'session.deleted',
        data: { sessionID: 'ses_lookup_a' },
      },
    },
  ])(
    'a stale identity lookup cannot overwrite a later $description event',
    async ({ event }) => {
      let resolveLookup!: (value: unknown) => void;
      const calls: RulesCall[] = [];
      const bridge = makeBridge({
        session: {
          get: async () =>
            await new Promise((resolve) => {
              resolveLookup = resolve;
            }),
          update: async (input: RulesCall) => {
            calls.push(input);
            return {};
          },
        } as unknown as V2Session,
      });

      const admission = bridge.ensurePromptPermission('ses_lookup_a');
      await Promise.resolve();
      await bridge.observeEvent(event);
      resolveLookup({
        data: { parentID: 'ses_parent', agent: 'probe' },
      });
      await admission;

      expect(calls).toHaveLength(0);
      await bridge.dispose();
    },
  );

  test('duplicate creation events share one in-flight permission update', async () => {
    let finishUpdate!: () => void;
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        await new Promise<void>((resolve) => {
          finishUpdate = resolve;
        });
        return {};
      }),
    });
    const first = bridge.observeEvent(makeChildCreatedEvent({}));
    await Promise.resolve();
    const duplicate = bridge.observeEvent(makeChildCreatedEvent({}));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    finishUpdate();
    await Promise.all([first, duplicate]);
    expect(calls).toHaveLength(1);
    await bridge.dispose();
  });

  test('dispose prevents any later permission writes', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });
    await bridge.dispose();
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    await expect(bridge.ensurePromptPermission('ses_child_1')).rejects.toThrow(
      'disposed',
    );
    expect(calls).toHaveLength(0);
  });

  test('malformed events resolve without throwing (fail-soft)', async () => {
    const bridge = makeBridge({
      session: makeSession(async () => {
        throw new Error('must not be called');
      }),
    });
    await expect(
      bridge.observeSessionCreated(undefined as never),
    ).resolves.toBeUndefined();
    await expect(
      bridge.observeSessionCreated({ type: 'session.created' }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.observeSessionCreated({
        type: 'session.execution.started',
        data: { sessionID: 'ses_child_1' },
      }),
    ).resolves.toBeUndefined();
  });

  test('root sessions (no parentID) are never touched', async () => {
    const calls: RulesCall[] = [];
    const warnings: string[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      onUnavailable: () => warnings.push('warn'),
    });

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ parentID: undefined }),
    );

    // session.update `permissions` REPLACES the session-scoped list — a
    // root session must not even probe the capability.
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('child sessions of foreign agents are never touched', async () => {
    const calls: RulesCall[] = [];
    const warnings: string[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      pluginAgents: new Set(['probe']),
      onUnavailable: () => warnings.push('warn'),
    });

    // agent 'build' is a host/user agent, not plugin-defined
    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'build' }),
    );
    // no agent on the event at all — attribution impossible, skip
    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: undefined }),
    );

    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('an empty exact-match derivation skips the host call', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      // Wildcard-only shapes are the genuinely underivable case: the
      // catch-all key needs a wildcard on both axes and the MCP-style
      // suffixed key carries one in the action.
      policy: { '*': 'deny', 'github_*': 'allow' },
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toHaveLength(0);
  });

  test('an explicitly compiled empty policy does not replace session permissions', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      policy: [],
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toHaveLength(0);
  });

  test('an unavailable policy fails without latching the child as applied', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      policy: undefined,
    });

    await bridge.observeEvent(
      makeChildCreatedEvent({ sessionID: 'ses_child_missing_policy' }),
    );
    await expect(
      bridge.ensurePromptPermission('ses_child_missing_policy'),
    ).rejects.toThrow('permission policy unavailable');
    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_missing_policy' }),
    );
    expect(calls).toHaveLength(0);
  });

  test('dispose awaits held update and rejects an admission crossing cleanup', async () => {
    let finishUpdate!: () => void;
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession((input) => {
        calls.push(input as RulesCall);
        return new Promise((resolve) => {
          finishUpdate = () => resolve({});
        });
      }),
    });
    const eventApply = bridge.observeEvent(
      makeChildCreatedEvent({ sessionID: 'ses_child_held' }),
    );
    const admission = bridge.ensurePromptPermission('ses_child_held');
    let admissionSucceeded = false;
    const observedAdmission = admission.then(
      () => {
        admissionSucceeded = true;
      },
      () => {
        // The strict admission promise below is asserted separately; observe
        // its rejection here too so the lifecycle test has no stray rejection.
      },
    );
    await Promise.resolve();

    let disposalFinished = false;
    const disposal = bridge.dispose().then(() => {
      disposalFinished = true;
    });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);
    expect(admissionSucceeded).toBe(false);

    finishUpdate();
    await expect(admission).rejects.toThrow('barrier expired');
    await eventApply;
    await Promise.all([observedAdmission, disposal]);
    expect(disposalFinished).toBe(true);
    expect(admissionSucceeded).toBe(false);
    expect(calls).toHaveLength(1);
    await bridge.dispose();
    expect(calls).toHaveLength(1);
  });
});

async function withFixture<T>(
  callback: (fixtureRoot: string) => Promise<T>,
): Promise<T> {
  const originalEnv = { ...process.env };

  return await withTmpDir(async (tmp) => {
    const configDir = path.join(tmp, 'config');
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      // Minimal hermetic fixture (mirrors setup-compaction.test.ts) plus
      // one exact-match task-policy entry on a default agent, so the
      // wiring test has a derivable rule waiting for the child event.
      JSON.stringify({
        companion: { enabled: false },
        agents: {
          explorer: {
            permission: {
              // Nested pattern maps are schema-valid on bash (the
              // whole-tool keys like webfetch take plain actions only).
              bash: { 'git push': 'ask' },
            },
          },
        },
      }),
    );
    process.env.OPENCODE_CONFIG_DIR = configDir;
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(tmp, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(tmp, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = path.join(tmp, 'logs');
    process.env.OPENCODE_TEST_HOME = path.join(tmp, 'home');
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    resetV2GenerationWarnings();
    try {
      return await callback(tmp);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
  });
}

function makeSetupContext(projectDir: string): Record<string, unknown> {
  return {
    app: { name: 'opencode', version: 'v2-permission-bridge-test' },
    options: {},
    location: {
      directory: projectDir,
      project: { id: 'project', directory: projectDir, canonical: projectDir },
    },
    agent: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: () => {},
          remove: () => {},
        });
        return { dispose: () => {} };
      },
      reload: async () => ({}),
      list: async () => [],
    },
    mcp: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ list: () => [], set: () => {} });
        return { dispose: () => {} };
      },
    },
    session: { hook: async () => ({ dispose: () => {} }) },
  };
}

describe('createV2Setup permission rules wiring', () => {
  test.each(['project', 'bundled'] as const)(
    'R1: invalid %s skill setup cannot silently register a partial plugin',
    async (source) => {
      await withFixture(async (root) => {
        const ctx = makeSetupContext(root);
        if (source === 'project') {
          const directory = path.join(root, '.local', 'skills', 'probe');
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            path.join(directory, 'SKILL.md'),
            '---\nname: 123\ndescription: fixture\n---\nbody',
          );
        } else {
          ctx.skill = {
            transform: async () => {
              throw new InvalidSkillPolicyError(
                '123',
                'bundled registration fixture',
              );
            },
          };
        }
        let cleanup: (() => void | Promise<void>) | undefined;
        try {
          const started = createV2Setup()(ctx as unknown as V2Context).then(
            (dispose) => {
              cleanup = dispose;
            },
          );
          await expect(started).rejects.toBeInstanceOf(InvalidSkillPolicyError);
        } finally {
          await cleanup?.();
        }
      });
    },
  );

  test.each(['valid', 'transient'] as const)(
    'R1: invalid finalized skill policy blocks prompt without latching (%s)',
    async (after) => {
      await withFixture(async (root) => {
        await Bun.write(
          path.join(root, 'config', 'oh-my-opencode-slim.json'),
          JSON.stringify({
            autoUpdate: false,
            companion: { enabled: false },
            agents: { explorer: { permission: { skill: 'allow' } } },
          }),
        );
        const native: Array<Record<string, unknown>> = [];
        const updates: RulesCall[] = [];
        let mode: 'valid' | 'invalid' | 'transient' = 'valid';
        let transform!: (draft: unknown) => unknown;
        let prompt!: (event: V2SessionPromptEvent) => Promise<void>;
        let finishEvent:
          | ((value: IteratorResult<Record<string, unknown>>) => void)
          | undefined;
        const ctx = {
          ...makeSetupContext(root),
          agent: {
            transform: async (callback: typeof transform) => {
              transform = callback;
              return { dispose() {} };
            },
            list: async () => {
              if (mode === 'transient')
                throw new Error('temporary host lookup failure');
              return native.map((agent) =>
                mode === 'invalid' && agent.id === 'explorer'
                  ? {
                      ...agent,
                      permissions: [
                        { action: 'skill', resource: '*', effect: 'allow' },
                        { action: 'skill', resource: '123', effect: 'deny' },
                      ],
                    }
                  : agent,
              );
            },
          },
          session: {
            hook: async (name: string, callback: typeof prompt) => {
              if (name === 'prompt') prompt = callback;
              return { dispose() {} };
            },
            get: async () => ({
              id: 'ses_r1_child',
              parentID: 'ses_parent',
              agent: 'explorer',
            }),
            update: async (input: RulesCall) => {
              updates.push(input);
              return {};
            },
          },
          event: {
            subscribe: () => ({
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<Record<string, unknown>>>(
                    (resolve) => {
                      finishEvent = resolve;
                    },
                  ),
                return: async () => {
                  const end = { done: true, value: undefined } as const;
                  finishEvent?.(end);
                  return end;
                },
              }),
            }),
          },
        } as unknown as V2Context;
        const cleanup = await createV2Setup()(ctx);
        try {
          await transform({
            list: () => native,
            get: () => undefined,
            default() {},
            remove() {},
            update: (
              id: string,
              mutate: (agent: Record<string, unknown>) => void,
            ) => {
              let agent = native.find((entry) => entry.id === id);
              if (!agent) {
                agent = { id };
                native.push(agent);
              }
              mutate(agent);
            },
          });
          expect(
            native.find((agent) => agent.id === 'explorer')?.permissions,
          ).toContainEqual({ action: 'skill', resource: '*', effect: 'allow' });
          const event: V2SessionPromptEvent = {
            sessionID: 'ses_r1_child',
            messageID: 'msg_r1',
            prompt: { text: 'fixture' },
          };
          mode = 'invalid';
          await expect(prompt(event)).rejects.toThrow(/integer-index skill/);
          await expect(prompt(event)).rejects.toBeInstanceOf(
            InvalidSkillPolicyError,
          );
          await expect(prompt(event)).rejects.toThrow(/integer-index skill/);
          expect(updates).toHaveLength(0);
          mode = after;
          await prompt(event);
          expect(updates).toHaveLength(1);
          await prompt(event);
          expect(updates).toHaveLength(1);
        } finally {
          await cleanup();
        }
      });
    },
  );

  test.each([
    { getAvailable: true, updateAvailable: true },
    { getAvailable: false, updateAvailable: true },
    { getAvailable: true, updateAvailable: false },
    {
      getAvailable: true,
      updateAvailable: true,
      abortRegistrationFailure: true,
    },
    {
      getAvailable: true,
      updateAvailable: true,
      neverSettleUpdate: true,
    },
  ])(
    'setup prompt barrier capability probe %#',
    async ({
      getAvailable,
      updateAvailable,
      abortRegistrationFailure = false,
      neverSettleUpdate = false,
    }) => {
      await withFixture(async (fixtureRoot) => {
        const calls: RulesCall[] = [];
        const projectDir = path.join(fixtureRoot, 'project');
        let transformAgents!: (draft: unknown) => void;
        const nativeAgents: Array<Record<string, unknown>> = [
          {
            id: 'explorer',
            permissions: [
              { action: 'read', resource: 'src/**', effect: 'deny' },
              { action: 'read', resource: 'src/public.ts', effect: 'allow' },
            ],
          },
        ];
        let transformsApplied = false;
        let publishEvent!: (event: Record<string, unknown>) => Promise<void>;
        let promptHandler:
          | ((event: V2SessionPromptEvent) => Promise<void>)
          | undefined;
        let holdRulesUpdate = false;
        let heldUpdatePending = false;
        let finishRulesUpdate!: (error?: Error) => void;
        const firstRulesUpdate = Promise.withResolvers<void>();
        const failedUpdateSessions = new Set<string>();
        const failedLookupSessions = new Set<string>();
        const getCalls: string[] = [];
        let pendingLookupSessionID: string | undefined;
        let rejectPendingLookup!: (error: Error) => void;
        let registrationDisposals = 0;
        let cleanedUp = false;
        const eventQueue: Array<{
          event: Record<string, unknown>;
          processed: () => void;
        }> = [];
        let acknowledgeEvent: (() => void) | undefined;
        let wakeEvent: (() => void) | undefined;
        let eventStreamStopped = false;
        const requiredRegistrationError = new Error(
          'required context registration failed',
        );
        const heldRegistrationDisposal = Promise.withResolvers<void>();
        const ctx = {
          app: { name: 'opencode', version: 'v2-perm-rules-test' },
          options: {},
          location: {
            directory: projectDir,
            project: {
              id: 'proj_perm_rules',
              directory: projectDir,
              canonical: projectDir,
            },
          },
          agent: {
            transform: async (cb: (draft: unknown) => void) => {
              transformAgents = cb;
              return {
                dispose: () => {
                  registrationDisposals += 1;
                },
              };
            },
            reload: async () => ({}),
            list: async () => {
              return nativeAgents;
            },
          },
          mcp: {
            transform: async (callback: (draft: unknown) => void) => {
              callback({
                list: () => [],
                get: () => undefined,
                set: () => {},
                update: () => {},
                remove: () => {},
              });
              return { dispose: () => {} };
            },
            reload: async () => {},
          },
          session: {
            hook: async (name: string, callback: unknown) => {
              if (name === 'context' && abortRegistrationFailure) {
                throw requiredRegistrationError;
              }
              if (name === 'prompt') {
                promptHandler = callback as typeof promptHandler;
              }
              return {
                dispose: () => {
                  if (name === 'prompt' && abortRegistrationFailure) {
                    return heldRegistrationDisposal.promise;
                  }
                  registrationDisposals += 1;
                },
              };
            },
            ...(getAvailable
              ? {
                  get: async ({ sessionID }: { sessionID: string }) => ({
                    data: await (async () => {
                      getCalls.push(sessionID);
                      if (sessionID === pendingLookupSessionID) {
                        // Only the first lookup races session.created. A lookup
                        // after deletion must be a fresh, settled host read.
                        pendingLookupSessionID = undefined;
                        return await new Promise<never>((_resolve, reject) => {
                          rejectPendingLookup = reject;
                        });
                      }
                      if (failedLookupSessions.has(sessionID)) {
                        throw new Error('session lookup failed');
                      }
                      return sessionID === 'ses_probe_root'
                        ? { agent: 'orchestrator' }
                        : sessionID === 'ses_probe_foreign'
                          ? { parentID: 'ses_parent', agent: 'host-agent' }
                          : { parentID: 'ses_parent', agent: 'explorer' };
                    })(),
                  }),
                }
              : {}),
            ...(updateAvailable
              ? {
                  update: async (input: RulesCall) => {
                    calls.push(input);
                    if (failedUpdateSessions.has(input.sessionID)) {
                      throw new Error('held permission update failed');
                    }
                    if (
                      neverSettleUpdate &&
                      input.sessionID === 'ses_probe_child'
                    ) {
                      await new Promise<void>((resolve) => {
                        finishRulesUpdate = () => resolve();
                        firstRulesUpdate.resolve();
                      });
                    }
                    if (holdRulesUpdate && !neverSettleUpdate) {
                      heldUpdatePending = true;
                      await new Promise<void>((resolve, reject) => {
                        finishRulesUpdate = (error) =>
                          error ? reject(error) : resolve();
                        firstRulesUpdate.resolve();
                      });
                      heldUpdatePending = false;
                    }
                    return {};
                  },
                }
              : {}),
          },
          event: {
            subscribe: () => ({
              [Symbol.asyncIterator]: () => ({
                next: async (): Promise<
                  IteratorResult<Record<string, unknown>>
                > => {
                  // The pump requests the next event only after all handlers
                  // for the previous one settle, including the deletion bridge.
                  acknowledgeEvent?.();
                  acknowledgeEvent = undefined;
                  while (eventQueue.length === 0 && !eventStreamStopped) {
                    await new Promise<void>((resolve) => {
                      wakeEvent = resolve;
                    });
                  }
                  const queued = eventQueue.shift();
                  acknowledgeEvent = queued?.processed;
                  return queued
                    ? { value: queued.event, done: false }
                    : { value: undefined, done: true };
                },
                return: async () => {
                  eventStreamStopped = true;
                  wakeEvent?.();
                  return { value: undefined, done: true } as IteratorResult<
                    Record<string, unknown>
                  >;
                },
              }),
            }),
          },
        } as unknown as V2Context;
        publishEvent = (event) => {
          const processed = Promise.withResolvers<void>();
          eventQueue.push({ event, processed: processed.resolve });
          wakeEvent?.();
          wakeEvent = undefined;
          return processed.promise;
        };

        const setupPromise = createV2Setup()(ctx);
        if (abortRegistrationFailure) {
          try {
            const startedAt = Date.now();
            await expect(setupPromise).rejects.toBe(requiredRegistrationError);
            expect(Date.now() - startedAt).toBeLessThan(6_000);
          } finally {
            // Keep rollback bounded during the assertion, then release the
            // simulated host disposer so no pending fixture survives this test.
            heldRegistrationDisposal.resolve();
          }
          return;
        }
        const cleanup = await setupPromise;

        try {
          // Simulate the host's batch flush after setup returned.
          transformsApplied = true;
          transformAgents({
            list: () => nativeAgents,
            get: () => undefined,
            default: () => {},
            // Like the host, finalized agent reads reflect plugin registration.
            update: (
              id: string,
              mutate: (agent: Record<string, unknown>) => void,
            ) => {
              let agent = nativeAgents.find((entry) => entry.id === id);
              if (!agent) {
                agent = { id };
                nativeAgents.push(agent);
              }
              mutate(agent);
            },
            remove: () => {},
          });
          expect(transformsApplied).toBe(true);
          expect(promptHandler).toBeDefined();
          const bridgeEnabled = updateAvailable;
          const prompt = promptHandler as NonNullable<typeof promptHandler>;
          holdRulesUpdate = bridgeEnabled;
          if (getAvailable && bridgeEnabled && !neverSettleUpdate) {
            pendingLookupSessionID = 'ses_probe_child';
          }
          let admissionFinished = false;
          let admissionError: unknown;
          const admission = prompt({
            sessionID: 'ses_probe_child',
            messageID: 'msg_before_creation',
            prompt: { text: 'prompt before child creation' },
          }).then(
            () => {
              admissionFinished = true;
            },
            (error: unknown) => {
              admissionError = error;
            },
          );
          if (getAvailable && bridgeEnabled) {
            await Promise.resolve();
            expect(getCalls).toContain('ses_probe_child');
          }
          const childCreated = publishEvent({
            type: 'session.created',
            data: {
              sessionID: 'ses_probe_child',
              parentID: 'ses_probe_parent',
              agent: 'explorer',
            },
          });
          if (bridgeEnabled) await firstRulesUpdate.promise;
          if (neverSettleUpdate) {
            expect(calls).toHaveLength(1);
            await Promise.all([admission, childCreated]);
            expect(String(admissionError)).toContain('timed out');
            await publishEvent({
              type: 'session.created',
              data: {
                sessionID: 'ses_probe_next',
                parentID: 'ses_probe_parent',
                agent: 'explorer',
              },
            });
            expect(calls.map(({ sessionID }) => sessionID)).toEqual([
              'ses_probe_child',
              'ses_probe_next',
            ]);
            finishRulesUpdate();
            await cleanup();
            cleanedUp = true;
            expect(registrationDisposals).toBeGreaterThan(0);
            expect(calls).toHaveLength(2);
            await expect(
              (promptHandler as NonNullable<typeof promptHandler>)({
                sessionID: 'ses_probe_late',
                messageID: 'msg_late',
                prompt: { text: 'late prompt' },
              }),
            ).rejects.toThrow('disposed');
            expect(calls).toHaveLength(2);
            return;
          }
          if (!bridgeEnabled) {
            await Promise.all([admission, childCreated]);
            expect(calls).toHaveLength(0);
            const managedPrompt = (
              promptHandler as NonNullable<typeof promptHandler>
            )({
              sessionID: 'ses_probe_managed',
              messageID: 'msg_managed',
              prompt: { text: 'managed child input' },
            });
            await managedPrompt;
            await (promptHandler as NonNullable<typeof promptHandler>)({
              sessionID: 'ses_probe_foreign',
              messageID: 'msg_foreign',
              prompt: { text: 'foreign child input' },
            });
            await (promptHandler as NonNullable<typeof promptHandler>)({
              sessionID: 'ses_probe_root',
              messageID: 'msg_root',
              prompt: { text: 'root input' },
            });
            expect(calls).toHaveLength(0);
            return;
          }
          expect(calls).toHaveLength(1);
          expect(heldUpdatePending).toBe(true);
          if (getAvailable) {
            rejectPendingLookup(new Error('creation beat identity lookup'));
            await Promise.resolve();
            expect(admissionFinished).toBe(false);
          } else {
            await admission; // update-only pre-creation prompt degrades
            expect(admissionFinished).toBe(true);
          }
          let knownAdmissionFinished = false;
          const knownAdmission = prompt({
            sessionID: 'ses_probe_child',
            messageID: 'msg_probe_child',
            prompt: { text: 'first child input' },
          }).then(() => {
            knownAdmissionFinished = true;
          });
          await Promise.resolve();
          expect(knownAdmissionFinished).toBe(false);
          finishRulesUpdate();
          await Promise.all([admission, knownAdmission, childCreated]);
          expect(admissionError).toBeUndefined();
          expect(knownAdmissionFinished).toBe(true);
          if (getAvailable) expect(admissionFinished).toBe(true);
          holdRulesUpdate = false;

          // Positive root/foreign and managed identities skip the optional lookup.
          await publishEvent({
            type: 'session.created',
            data: { sessionID: 'ses_probe_root', agent: 'orchestrator' },
          });
          await publishEvent({
            type: 'session.created',
            data: {
              sessionID: 'ses_probe_foreign',
              parentID: 'ses_parent',
              agent: 'host-agent',
            },
          });
          await publishEvent({
            type: 'session.created',
            data: {
              sessionID: 'ses_probe_barrier',
              parentID: 'ses_parent',
              agent: 'explorer',
            },
          });
          expect(calls.at(-1)?.sessionID).toBe('ses_probe_barrier');
          const getCallsAfterKnownManaged = getCalls.length;
          await prompt({
            sessionID: 'ses_probe_root',
            messageID: 'msg_root',
            prompt: { text: 'root prompt' },
          });
          await prompt({
            sessionID: 'ses_probe_foreign',
            messageID: 'msg_foreign',
            prompt: { text: 'foreign prompt' },
          });
          expect(getCalls).toHaveLength(getCallsAfterKnownManaged);

          // Unknown lookup failure degrades this admission, but a later child
          // creation still applies the native projection.
          failedLookupSessions.add('ses_probe_unknown');
          await (promptHandler as NonNullable<typeof promptHandler>)({
            sessionID: 'ses_probe_unknown',
            messageID: 'msg_unknown',
            prompt: { text: 'unknown identity prompt' },
          });
          if (getAvailable) expect(getCalls).toContain('ses_probe_unknown');
          const priorCalls = calls.length;
          await publishEvent({
            type: 'session.created',
            data: {
              sessionID: 'ses_probe_unknown',
              parentID: 'ses_parent',
              agent: 'explorer',
            },
          });
          expect(calls).toHaveLength(priorCalls + 1);

          // A known managed identity never consults get, and a failed update
          // rejects prompt admission rather than reporting false success.
          failedUpdateSessions.add('ses_probe_failed');
          await publishEvent({
            type: 'session.created',
            data: {
              sessionID: 'ses_probe_failed',
              parentID: 'ses_parent',
              agent: 'explorer',
            },
          });
          const beforeFailedPromptLookupCount = getCalls.length;
          await expect(
            (promptHandler as NonNullable<typeof promptHandler>)({
              sessionID: 'ses_probe_failed',
              messageID: 'msg_failed',
              prompt: { text: 'must not proceed' },
            }),
          ).rejects.toThrow('held permission update failed');
          expect(getCalls).toHaveLength(beforeFailedPromptLookupCount);

          if (getAvailable) {
            const updatesBeforeAgentSelection = calls.length;
            await publishEvent({
              type: 'session.agent.selected',
              data: { sessionID: 'ses_probe_child', agent: 'host-agent' },
            });
            const lookupsBeforeForeignPrompt = getCalls.length;
            await (promptHandler as NonNullable<typeof promptHandler>)({
              sessionID: 'ses_probe_child',
              messageID: 'msg_selected_foreign',
              prompt: { text: 'selected foreign agent' },
            });
            expect(getCalls).toHaveLength(lookupsBeforeForeignPrompt);
            expect(calls).toHaveLength(updatesBeforeAgentSelection);

            await publishEvent({
              type: 'session.agent.selected',
              data: { sessionID: 'ses_probe_child', agent: 'explorer' },
            });
            expect(calls).toHaveLength(updatesBeforeAgentSelection + 1);
            const lookupsBeforeDeletedPrompt = getCalls.length;
            await publishEvent({
              type: 'session.deleted',
              data: { sessionID: 'ses_probe_child' },
            });
            await (promptHandler as NonNullable<typeof promptHandler>)({
              sessionID: 'ses_probe_child',
              messageID: 'msg_after_delete',
              prompt: { text: 'after deletion' },
            });
            expect(getCalls.length).toBe(lookupsBeforeDeletedPrompt + 1);
          }
          expect(calls[0].sessionID).toBe('ses_probe_child');
          // The fixture's exact-match entry made it through the derivation
          // (v1 `bash` maps to the v2 `shell` + `bash` actions).
          expect(calls[0].permissions).toContainEqual({
            action: 'shell',
            resource: 'git push',
            effect: 'ask',
          });
          expect(calls[0].permissions).toContainEqual({
            action: 'bash',
            resource: 'git push',
            effect: 'ask',
          });
          const childPolicy = compilePermissionPolicy({
            baselineRules: [],
            hostRules: calls[0].permissions,
          });
          expect(childPolicy.decide('read', 'src/public.ts')).toBe('allow');
          expect(childPolicy.decide('read', 'src/other.ts')).toBe('deny');
          // Host read exceptions stay ordered and effective even when the
          // plugin appends unrelated declarative deny ceilings afterward.
          expect(
            calls[0].permissions
              .filter((rule) => rule.action === 'read')
              .slice(-2),
          ).toEqual([
            { action: 'read', resource: 'src/**', effect: 'deny' },
            { action: 'read', resource: 'src/public.ts', effect: 'allow' },
          ]);
          expect(
            calls[0].permissions.some(
              (rule) =>
                rule.action === 'shell' &&
                rule.resource === 'git push' &&
                rule.effect === 'ask',
            ),
          ).toBe(true);
        } finally {
          if (holdRulesUpdate) finishRulesUpdate();
          if (!cleanedUp) await cleanup();
        }
      });
    },
    20_000,
  );
  test('forwards complete permission names to the injected factory after discovery', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const skillDir = path.join(
        projectDir,
        '.opencode',
        'skills',
        'local-one',
      );
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: local-one\n---\nlocal',
      );
      const ctx = makeSetupContext(projectDir);
      ctx.skill = {
        list: async () => ({
          location: {},
          data: [{ id: 'editor-only', name: 'Editor display name' }],
        }),
      };
      let received: Record<string, unknown> | undefined;
      const cleanup = await createV2Setup(async (input) => {
        received = input as Record<string, unknown>;
        return await OhMyOpenCodeLite(input);
      })(ctx as unknown as V2Context);
      try {
        expect(received?.projectSkillPermissionNames).toEqual(['local-one']);
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('grants only discovered candidates and local OpenCode names, not native or editor names', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const createSkill = (root: string, name: string) => {
        const directory = path.join(root, name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, 'SKILL.md'),
          `---\nname: ${name}\n---\nfixture`,
        );
      };
      createSkill(path.join(projectDir, '.opencode', 'skills'), 'local-only');
      createSkill(path.join(projectDir, '.claude', 'skills'), 'native-only');
      createSkill(path.join(projectDir, '.local', 'skills'), 'eligible');
      const ctx = makeSetupContext(projectDir);
      ctx.skill = {
        list: async () => ({
          location: {},
          data: [{ id: 'editor-only', name: 'Editor display name' }],
        }),
      };
      let receivedNames: unknown;
      const cleanup = await createV2Setup(async (input) => {
        receivedNames = (input as Record<string, unknown>)
          .projectSkillPermissionNames;
        return await OhMyOpenCodeLite(input);
      })(ctx as unknown as V2Context);
      try {
        expect(receivedNames).toEqual(['local-only', 'eligible']);
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('omits supplemental names when a native scan is incomplete', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const nativeRoot = path.join(projectDir, '.claude', 'skills');
      mkdirSync(nativeRoot, { recursive: true });
      writeFileSync(path.join(nativeRoot, 'broken.md'), '---\nname: broken');
      const eligible = path.join(projectDir, '.local', 'skills', 'eligible');
      mkdirSync(eligible, { recursive: true });
      writeFileSync(
        path.join(eligible, 'SKILL.md'),
        '---\nname: eligible\n---',
      );
      const ctx = makeSetupContext(projectDir);
      let received: Record<string, unknown> | undefined;
      const cleanup = await createV2Setup(async (input) => {
        received = input as Record<string, unknown>;
        return await OhMyOpenCodeLite(input);
      })(ctx as unknown as V2Context);
      try {
        expect(received).not.toHaveProperty('projectSkillPermissionNames');
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('editor list failure withholds candidates and names but still calls factory', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const nativeDir = path.join(projectDir, '.claude', 'skills', 'native');
      const eligible = path.join(projectDir, '.local', 'skills', 'eligible');
      mkdirSync(nativeDir, { recursive: true });
      mkdirSync(eligible, { recursive: true });
      writeFileSync(path.join(nativeDir, 'SKILL.md'), '---\nname: native\n---');
      writeFileSync(
        path.join(eligible, 'SKILL.md'),
        '---\nname: eligible\n---',
      );
      const ctx = makeSetupContext(projectDir);
      ctx.skill = {
        list: async () => {
          throw new Error('editor unavailable');
        },
      };
      let calls = 0;
      let received: Record<string, unknown> | undefined;
      const added: string[] = [];
      ctx.skill.transform = async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          add: (entry: { id: string }) => added.push(entry.id),
        });
        return { dispose: () => {} };
      };
      const cleanup = await createV2Setup(async (input) => {
        calls++;
        received = input as Record<string, unknown>;
        return await OhMyOpenCodeLite(input);
      })(ctx as unknown as V2Context);
      try {
        expect(calls).toBe(1);
        expect(received).not.toHaveProperty('projectSkillPermissionNames');
        expect(added).toEqual(CUSTOM_SKILLS.map(({ name }) => name));
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('incomplete editor inventory preserves the shared local-skill opt-in', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const skillDir = path.join(
        projectDir,
        '.opencode',
        'skills',
        'local-one',
      );
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: local-one\n---',
      );
      const configDir = process.env.OPENCODE_CONFIG_DIR as string;
      await Bun.write(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          companion: { enabled: false },
          agents: { oracle: { skills_include_local: true } },
        }),
      );
      const ctx = makeSetupContext(projectDir);
      ctx.skill = {
        list: async () => {
          throw new Error('editor unavailable');
        },
      };
      const registered: Array<{ name: string; [key: string]: unknown }> = [];
      ctx.agent.transform = async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          default: () => {},
          update: (
            name: string,
            update: (agent: Record<string, unknown>) => void,
          ) => {
            const agent: Record<string, unknown> = {};
            update(agent);
            registered.push({ name, ...agent });
          },
          remove: () => {},
        });
        return { dispose: () => {} };
      };
      const cleanup = await createV2Setup(OhMyOpenCodeLite)(
        ctx as unknown as V2Context,
      );
      try {
        const oracle = registered.find(({ name }) => name === 'oracle');
        expect(oracle).toBeDefined();
        expect(JSON.stringify(oracle)).toContain('local-one');
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('collision discovery retains native local opt-in without duplicate candidates', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const createSkill = (root: string, name: string) => {
        const directory = path.join(root, name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, 'SKILL.md'),
          `---\nname: ${name}\n---`,
        );
      };
      createSkill(
        path.join(projectDir, '.claude', 'skills'),
        'native-conflict',
      );
      createSkill(
        path.join(projectDir, '.opencode', 'skills'),
        'local-conflict',
      );
      createSkill(path.join(projectDir, '.local', 'skills'), 'native-conflict');
      createSkill(path.join(projectDir, '.local', 'skills'), 'local-conflict');
      createSkill(path.join(projectDir, '.local', 'skills'), 'editor-conflict');
      const ctx = makeSetupContext(projectDir);
      ctx.skill = {
        list: async () => ({
          location: {},
          data: [{ id: 'editor-conflict', name: 'Editor display name' }],
        }),
      };
      let received: Record<string, unknown> | undefined;
      const addedSkills: string[] = [];
      ctx.skill.transform = async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          add: (skill: { id: string }) => addedSkills.push(skill.id),
        });
        return { dispose() {} };
      };
      const cleanup = await createV2Setup(async (input) => {
        received = input as Record<string, unknown>;
        return await OhMyOpenCodeLite(input);
      })(ctx as unknown as V2Context);
      try {
        expect(received?.projectSkillPermissionNames).toEqual([
          'local-conflict',
        ]);
        expect(addedSkills).not.toContain('native-conflict');
        expect(addedSkills).not.toContain('local-conflict');
        expect(addedSkills).not.toContain('editor-conflict');
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('uses configured resource prefixes as a replacement, including explicit empty prefixes', async () => {
    await withFixture(async (fixtureRoot) => {
      const projectDir = path.join(fixtureRoot, 'project');
      const configDir = process.env.OPENCODE_CONFIG_DIR as string;
      const customSkill = path.join(
        projectDir,
        '.custom',
        'skills',
        'custom-one',
      );
      const defaultSkill = path.join(
        projectDir,
        '.opencode',
        'skills',
        'default-one',
      );
      mkdirSync(customSkill, { recursive: true });
      mkdirSync(defaultSkill, { recursive: true });
      writeFileSync(
        path.join(customSkill, 'SKILL.md'),
        '---\nname: custom-one\n---\ncustom',
      );
      writeFileSync(
        path.join(defaultSkill, 'SKILL.md'),
        '---\nname: default-one\n---\ndefault',
      );
      const registrations: string[][] = [];
      const base = makeSetupContext(projectDir);
      base.skill = {
        list: async () => ({ location: {}, data: [] }),
        transform: async (callback: (draft: unknown) => void) => {
          const added: Array<{ id: string }> = [];
          callback({
            list: () => [],
            add: (item: { id: string }) => added.push(item),
          });
          registrations.push(added.map(({ id }) => id));
          return { dispose: () => {} };
        },
      };

      await Bun.write(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          companion: { enabled: false },
          resource_prefixes: ['.custom'],
        }),
      );
      const cleanupCustom = await createV2Setup()(base as unknown as V2Context);
      await cleanupCustom();
      expect(registrations).toContainEqual(['custom-one']);

      registrations.length = 0;
      await Bun.write(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          companion: { enabled: false },
          resource_prefixes: [],
        }),
      );
      const cleanupEmpty = await createV2Setup()(base as unknown as V2Context);
      await cleanupEmpty();
      expect(registrations).toEqual([CUSTOM_SKILLS.map(({ name }) => name)]);
    });
  }, 20_000);

  test('the event pump applies child session rules via ctx.session.update', async () => {
    await withFixture(async (fixtureRoot) => {
      const calls: RulesCall[] = [];
      const eventHandled = Promise.withResolvers<void>();
      // Explicit native overrides, independent of the plugin's MCP defaults.
      const nativeAgents: Array<Record<string, unknown>> = [
        {
          id: 'explorer',
          permissions: [
            { action: 'context7_*', resource: '*', effect: 'deny' },
            { action: 'read', resource: 'src/**', effect: 'deny' },
            { action: 'read', resource: 'src/public.ts', effect: 'allow' },
          ],
        },
      ];
      const projectDir = path.join(fixtureRoot, 'project');
      const ctx = {
        ...makeSetupContext(projectDir),
        app: { name: 'opencode', version: 'v2-perm-rules-test' },
        options: {},
        location: {
          directory: projectDir,
          project: {
            id: 'proj_perm_rules',
            directory: projectDir,
            canonical: projectDir,
          },
        },
        agent: {
          transform: async (cb: (draft: unknown) => void) => {
            cb({
              list: () => nativeAgents,
              get: (id: string) =>
                nativeAgents.find((agent) => agent.id === id),
              default: () => {},
              update: (
                id: string,
                mutate: (agent: Record<string, unknown>) => void,
              ) => {
                let agent = nativeAgents.find((entry) => entry.id === id);
                if (!agent) {
                  agent = { id };
                  nativeAgents.push(agent);
                }
                mutate(agent);
              },
              remove: () => {},
            });
            return { dispose: () => {} };
          },
          reload: async () => ({}),
          list: async () => nativeAgents,
        },
        session: {
          hook: async () => ({ dispose: () => {} }),
          update: async (input: RulesCall) => {
            calls.push(input);
            return {};
          },
        },
        event: {
          subscribe: async function* () {
            yield {
              type: 'session.created',
              data: {
                sessionID: 'ses_probe_child',
                parentID: 'ses_probe_parent',
                agent: 'explorer',
              },
            };
            eventHandled.resolve();
          },
        },
      } as unknown as V2Context;

      const cleanup = await createV2Setup()(ctx);

      try {
        await eventHandled.promise;
        expect(calls).toHaveLength(1);
        expect(calls[0].sessionID).toBe('ses_probe_child');
        // The fixture's exact-match entry made it through the derivation
        // (v1 `bash` maps to the v2 `shell` + `bash` actions).
        expect(calls[0].permissions).toContainEqual({
          action: 'shell',
          resource: 'git push',
          effect: 'ask',
        });
        expect(calls[0].permissions).toContainEqual({
          action: 'bash',
          resource: 'git push',
          effect: 'ask',
        });
        // Ordered native host rules survive compilation unchanged, including
        // the later exception: the read deny precedes the public.ts allow,
        // and no compiled read rule or ask rule follows (the deny ceiling
        // replays after them — see compileChildPermissions in
        // src/agents/registry.ts — but this fixture's explorer baseline
        // declares no read rules, so the exception is final).
        const compiledPermissions = calls[0].permissions;
        const narrowDenyIndex = compiledPermissions.findIndex(
          (rule) =>
            rule.action === 'read' &&
            rule.resource === 'src/**' &&
            rule.effect === 'deny',
        );
        const publicAllowIndex = compiledPermissions.findIndex(
          (rule) =>
            rule.action === 'read' &&
            rule.resource === 'src/public.ts' &&
            rule.effect === 'allow',
        );
        expect(narrowDenyIndex).toBeGreaterThanOrEqual(0);
        expect(publicAllowIndex).toBeGreaterThan(narrowDenyIndex);
        const afterAllow = compiledPermissions.slice(publicAllowIndex + 1);
        expect(afterAllow.some((rule) => rule.action === 'read')).toBe(false);
        expect(afterAllow.some((rule) => rule.effect === 'ask')).toBe(false);
        expect(
          afterAllow.some(
            (rule) => rule.action !== 'read' && rule.effect === 'deny',
          ),
        ).toBe(true);
        // Exception-level semantics: the public.ts allow survives the
        // ceiling, everything else read-scoped stays denied.
        const decideCompiled = (action: string, resource: string): string => {
          const match = compiledPermissions.findLast(
            (rule) =>
              (rule.action === '*' || rule.action === action) &&
              (rule.resource === '*' ||
                rule.resource === resource ||
                (rule.resource.endsWith('/**') &&
                  resource.startsWith(rule.resource.slice(0, -3)))),
          );
          return match?.effect ?? 'ask';
        };
        expect(decideCompiled('read', 'src/public.ts')).toBe('allow');
        expect(decideCompiled('read', 'src/other.ts')).toBe('deny');
        expect(
          calls[0].permissions.some(
            (rule) =>
              rule.action === 'shell' &&
              rule.resource === 'git push' &&
              rule.effect === 'ask',
          ),
        ).toBe(true);
        // Finalized policies retain wildcard namespace ceilings, unlike the
        // legacy exact-only projection exercised by the unit tests above.
        expect(calls[0].permissions).toContainEqual({
          action: 'context7_*',
          resource: '*',
          effect: 'deny',
        });
      } finally {
        await cleanup();
      }
    });
  }, 20_000);

  test('derives only the exact observer allow from the task pattern', () => {
    // The '*' deny is skipped by the wildcard gate; it keeps living in the
    // static agent registration. Only the exact observer allow survives.
    expect(
      deriveExactPermissionRules({
        task: { '*': 'deny', observer: 'allow' },
      }),
    ).toEqual([{ action: 'subagent', resource: 'observer', effect: 'allow' }]);
  });
});
