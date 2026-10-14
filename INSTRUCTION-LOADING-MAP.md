# Hierarchical Resource Loading — Capability Map

**Status:** capability map and design spec approved; implementation plan in progress

**Design spec:** `.local/docs/specs/2026-09-27/design/index.md`
**Scope:** project-local plugin resource discovery; OpenCode-native
`AGENTS.md` and resource loading remain host-owned.
**Skill exception:** the current-project `.opencode/skills` name scan remains
for `skills_include_local` permissions only, even when `resource_prefixes` is
empty; skill-content discovery remains host-owned.

## Shared prefix contract

One ordered `resource_prefixes` setting supplies the directory prefixes used
for `rules`, `skills`, `commands`, and (reserved for future use) `agents`.

- Defaults: `.local/`, `.local/.slim/`, `.opencode/`.
- An explicit list replaces the defaults; an explicit empty list disables
  plugin-owned prefix discovery.
- At each applicable ancestor, a resource adapter appends its own category
  directory, e.g. `<ancestor>/.local/rules/` or
  `<ancestor>/.local/.slim/skills/`.
- Search walks from the active directory up to and including the OpenCode
  project/worktree boundary, never above it.
- Prefix paths must remain inside that boundary. Normalize and deduplicate
  paths; reject traversal and symlink escapes.
- The common resolver returns ordered candidates. Each resource adapter owns
  its collision and precedence rules; do not impose one universal merge rule.
- That shared order is path depth: hops below the home directory, so ascending
  depth is generic-to-specific and a deeper directory always wins a collision.
  Config-directory roots take the smallest depth; roots outside home take their
  hop count minus a fixed offset. Depth reads the path as spelled, and symlinks
  are not resolved.

## Capabilities and build order

| Capability | Responsibility | Depends on | Status |
|---|---|---|---|
| `resource-prefix-contract` | Config schema, defaults/override semantics, ancestor traversal, path confinement and deterministic candidate ordering. | — | Plan phase 1 |
| `hierarchical-rules` | Discover and match plugin-owned Markdown rules after relevant file operations; inject matching context without duplicating `AGENTS.md` or mutating cached prompt prefixes. | `resource-prefix-contract` | Plan phase 2 |
| `global-rules` | Resolve `rules/` under every OpenCode config directory as a user-global source that the prefix contract's boundary walk cannot produce. A rule's identity is its filename: a project rule overrides a same-named global rule, and an empty project rule file disables it. Each config directory resolves independently, and symlinks are not resolved. Rules only; global skills, commands, and agents stay host-owned. | `resource-prefix-contract` | Implemented |
| `hierarchical-skills` | Discover extra project skill roots for existing per-agent permission policy and expose eligible content through the supported V1/V2 host APIs. Keep host-native skill roots host-owned. | `resource-prefix-contract` | Plan phase 3 |
| `project-command-files` | Discover command Markdown beneath configured `commands/` roots and register additively without replacing host commands. | `resource-prefix-contract` | Follow-up |
| `skill-command-bridge` | Expose eligible discovered skills as slash commands where the host does not already do so; preserve collision behavior. | `hierarchical-skills` | Follow-up |
| `delegated-skill-context` | Resolve only explicitly requested delegated skills and pass allowed content into child-agent system context. | `hierarchical-skills` | Follow-up |
| Extra-prefix custom-agent definitions | Register new custom agent IDs from configured `agents/` roots. | Future host API support | Deferred on V1 and V2 for cross-version consistency |

## Host-owned boundaries

- OpenCode remains the sole loader of hierarchical `AGENTS.md`.
- Native `.opencode/skills/`, `.opencode/commands/`, and `.opencode/agents/`
  remain host-owned and must not be registered a second time by the plugin.
- V1 supports `skills.paths` mutation in its config hook; V2 has no mutable
  global config hook and uses skill/command domain transforms instead.
- V2's agent editor has no add-agent operation. Therefore, extra-prefix custom
  agent definitions are deferred rather than implemented only for V1.
- Skill names must not depend on V1 host duplicate-resolution order; the host
  does not guarantee a deterministic winner for duplicate skill names.

## Approval and implementation gates

1. The initial design spec covers the prefix contract/resolver and the rules
   and skills adapters. It must be approved before implementation planning.
2. Command-file loading, skill-derived commands, and delegated skill context
   remain later, separately specified slices.
3. Extra-prefix agent definitions remain out of scope until the supported V2
   API can safely register new agent IDs.
4. Every implementation slice needs focused tests, relevant documentation, and
   the repository's CI checks. Real OpenCode runtime tests remain prohibited
   unless explicitly authorized.
