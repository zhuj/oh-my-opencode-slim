import { describe, expect, test } from 'bun:test';
import { resolveEffectiveAgentOverrides } from './effective-agent-overrides';
import type { AgentOverrideConfig } from './schema';

/**
 * Byte-level parity guards for the local-skill filter.
 *
 * The filter is hashed (one `Set` of permission rule names per agent) instead
 * of scanning the rule-name array per local skill. These goldens pin the exact
 * serialized output - key order included - so the swap cannot silently reorder
 * skills, drop a `*` short-circuit, or change an empty-permission result.
 *
 * Goldens were captured from the pre-hashing implementation.
 */

/** Deliberately unsorted so any accidental sort is visible in the goldens. */
const LOCAL_SKILLS = ['zeta-local', 'exact', 'alpha-local', 'review'];

describe('resolveEffectiveAgentOverrides byte parity', () => {
  test("wildcard '*' rule suppresses every automatic local addition", () => {
    const result = resolveEffectiveAgentOverrides(
      {
        explorer: {
          permission: { skill: { '*': 'deny' } },
          skills: ['explicit'],
          skills_add: ['added'],
          skills_include_local: true,
        },
      },
      () => LOCAL_SKILLS,
    );

    expect(JSON.stringify(result)).toBe(
      '{"explorer":{"permission":{"skill":{"*":"deny"}},"skills":["explicit","added"]}}',
    );
    // Pre-existing contract: the supplier is consulted once whenever any agent
    // opts into local skills, wildcard or not; '*' only drops the additions.
    let supplierCalls = 0;
    const counted = resolveEffectiveAgentOverrides(
      {
        explorer: {
          permission: { skill: { '*': 'deny' } },
          skills: ['explicit'],
          skills_add: ['added'],
          skills_include_local: true,
        },
      },
      () => {
        supplierCalls += 1;
        return LOCAL_SKILLS;
      },
    );
    expect(supplierCalls).toBe(1);
    expect(JSON.stringify(counted)).toBe(JSON.stringify(result));
  });

  test('exact rules grant only the uncovered local skills, in source order', () => {
    const result = resolveEffectiveAgentOverrides(
      {
        oracle: {
          permission: { skill: { exact: 'deny', review: 'ask' } },
          skills: ['?ask', '!deny'],
          skills_include_local: true,
        },
      },
      () => LOCAL_SKILLS,
    );

    expect(JSON.stringify(result)).toBe(
      '{"oracle":{"permission":{"skill":{"exact":"deny","review":"ask"}},"skills":["?ask","!deny","zeta-local","alpha-local"]}}',
    );
  });

  test('empty skill-rule table grants every local skill', () => {
    const result = resolveEffectiveAgentOverrides(
      {
        fixer: { permission: { skill: {} }, skills: ['base'] },
      },
      () => [],
    );
    expect(JSON.stringify(result)).toBe(
      '{"fixer":{"permission":{"skill":{}},"skills":["base"]}}',
    );

    const withLocal = resolveEffectiveAgentOverrides(
      {
        fixer: {
          permission: { skill: {} },
          skills: ['base'],
          skills_include_local: true,
        },
      },
      () => LOCAL_SKILLS,
    );
    expect(JSON.stringify(withLocal)).toBe(
      '{"fixer":{"permission":{"skill":{}},"skills":["base","zeta-local","exact","alpha-local","review"]}}',
    );
  });

  test('missing and scalar permissions behave like an empty rule table', () => {
    const missing = resolveEffectiveAgentOverrides(
      { librarian: { skills: ['base'], skills_include_local: true } },
      () => LOCAL_SKILLS,
    );
    expect(JSON.stringify(missing)).toBe(
      '{"librarian":{"skills":["base","zeta-local","exact","alpha-local","review"]}}',
    );

    const scalar = resolveEffectiveAgentOverrides(
      {
        librarian: { permission: 'allow', skills: ['base'] },
      } as unknown as Record<string, AgentOverrideConfig>,
      () => LOCAL_SKILLS,
    );
    expect(JSON.stringify(scalar)).toBe(
      '{"librarian":{"permission":"allow","skills":["base"]}}',
    );
  });

  test('per-agent hashing preserves record and skills key order', () => {
    const result = resolveEffectiveAgentOverrides(
      {
        explorer: {
          permission: { skill: { exact: 'deny' } },
          skills: ['a'],
          skills_include_local: true,
        },
        oracle: { skills: ['b'] },
        fixer: {
          permission: { skill: { '*': 'allow' } },
          skills: ['c'],
          skills_include_local: true,
        },
      },
      () => LOCAL_SKILLS,
    );

    expect(Object.keys(result)).toEqual(['explorer', 'oracle', 'fixer']);
    expect(JSON.stringify(result)).toBe(
      '{"explorer":{"permission":{"skill":{"exact":"deny"}},"skills":["a","zeta-local","alpha-local","review"]},"oracle":{"skills":["b"]},"fixer":{"permission":{"skill":{"*":"allow"}},"skills":["c"]}}',
    );
  });

  test('repeated calls on one input are structurally identical', () => {
    const input: Record<string, AgentOverrideConfig> = {
      oracle: {
        permission: { skill: { exact: 'deny', review: 'ask' } },
        skills: ['?ask', '!deny'],
        skills_include_local: true,
      },
    };
    const supplier = () => LOCAL_SKILLS;

    expect(
      JSON.stringify(resolveEffectiveAgentOverrides(input, supplier)),
    ).toBe(JSON.stringify(resolveEffectiveAgentOverrides(input, supplier)));
  });
});
