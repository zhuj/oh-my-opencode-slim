# Hierarchical Resource Loading — Capability Map

This map describes the implemented resource-loading boundaries in the v3.0.7
port. OpenCode owns native `AGENTS.md`, skill loading, commands, and agents;
Slim adds project rules and supplemental skill sources through the supported
host interfaces.

## Shared prefix contract

The ordered `resource_prefixes` setting supplies project-local resource roots.
Current adapters discover `rules/` and `skills/`; `commands/` and `agents/`
remain reserved categories without extra-prefix file loaders.

- Defaults are `.local`, `.local/.slim`, and `.opencode`.
- An explicit list replaces the inherited list. An empty list disables
  prefix-based discovery, while native skill-name scans and global rules
  remain independent sources.
- Each adapter appends its category, such as
  `<ancestor>/.local/rules/` or `<ancestor>/.local/.slim/skills/`.
- The resolver walks from the host's active directory to its project/worktree
  boundary, inclusive. Missing or invalid boundaries produce no project roots.
- Prefixes must be relative and cannot traverse `..`. Canonical paths enforce
  containment and deduplication; symlinks cannot escape the boundary.
- Root records preserve configured path spelling. Depth orders generic roots
  before specific roots: home is depth zero, `~/work` is one, and
  `~/work/project` is two. Config-directory roots precede project roots; roots
  outside home use a separate depth band.
- Each adapter owns collision rules. Rules choose the most specific file of a
  given basename; skills keep native identities and select the most specific
  supplemental candidate, using prefix order to break ties.

The native name-only scan for `skills_include_local` covers current and
eligible ancestor `.opencode/skills/**/SKILL.md` and
`.agents/skills/**/SKILL.md` trees. It uses the host's configuration-discovery
boundary, which differs from the confined supplemental-resource boundary on
V2. It reads names without registering native content and remains active when
`resource_prefixes` is empty.

## Capability status

| Capability | Current behavior | Implementation |
|---|---|---|
| Prefix contract | Validated defaults, replacement semantics, confined ancestor traversal, deterministic root ordering. | `src/config/project-resource-paths.ts`, `src/config/schema.ts` |
| Project rules | Matches Markdown rules after supported file operations and appends context to fresh tool results, with per-session deduplication and token budgets. Native `AGENTS.md` is untouched. | `src/hooks/rules-injector/` |
| Global rules | Reads `rules/` from OpenCode config directories independently. A more specific same-named project file replaces a global rule; an empty winning file suppresses it. | `src/hooks/rules-injector/global-roots.ts`, `matcher.ts` |
| Supplemental project skills | Discovers extra skill directories, excludes host-owned roots and known identities, and exposes admitted content through V1 skill paths or V2 skill transforms. | `src/config/project-skills.ts`, `project-skill-host-adapter.ts`, `src/v2/project-skill-loader.ts` |
| Skill policy | Compiles selection, capability admission, and ordered authorization together. Automatic/default selections respect explicit permission rules; deliberate additions, exclusions, removals, and global disables retain precedence. | `src/config/effective-agent-overrides.ts`, `src/utils/skill-policy-validation.ts` |
| Generic skill commands | V2 exposes eligible host inventory IDs as commands; V1 applies the same modes to bundled templates. `full`, `reference`, and `none` are selected by `skillCommandMode` and per-skill `slim.command`. Explicit commands keep collision precedence. | `src/skill-command-mode.ts`, `src/v2/skill-commands.ts`, `skill-command-lifecycle.ts` |
| Prompt templates | Marked inline, replacement, and append prompts expand static sections. Primary agent inventories honor the release's delegation scopes. Core agent prompts receive one shared static base layer. | `src/agents/prompt-template.ts`, `prompt-sections.ts`, `prompt-layers.ts` |
| Extra-prefix command files | No plugin loader. Native command directories remain host-owned. | Deferred |
| Delegated skill context | No separate plugin loader that injects requested skill bodies into child system prompts. | Deferred |
| Extra-prefix agent files | No plugin loader; the supported V2 agent editor cannot add arbitrary agent IDs. Config-defined custom agents retain the existing release registration path. | Deferred |

## Runtime ownership

V1 supplements native discovery by appending eligible skill directories to
`skills.paths` without replacing existing paths. Bundled skills also use their
package paths. V2 registers supplemental and bundled skills through public
skill transforms and checks native inventory/collision identities before
admission. Native sources remain authoritative.

Skill discovery does not itself grant permission. `skills_include_local`
selects discovered names for an agent, while compiled permission rules can
still require consent or deny access. Plugin-owned IDs cannot contain skill
wildcard metacharacters or integer-index names that would reorder permission
rules. Literal names and directive tokens retain distinct provenance.

Generic V2 commands refresh after event consumption begins and on matching
skill/plugin inventory events. Each setup generation owns its registration
and generated-name reader; refresh or disposal in one workspace cannot change
another workspace's missing-command decisions. Unchanged inventories reuse
registrations, and replacement disposes the old transform before collision
reads. No filesystem watcher or system-prompt injection is added for skills.

Rules inject only into fresh file-operation output. Prompt-template sections
contain configuration and host capabilities, never current user messages,
live task state, timestamps, or session identifiers. Release primary scopes,
feature gates, and native host delegation mechanisms remain in force.

## References and verification

See [Project-local Customization](docs/project-local-customization.md),
[Skills](docs/skills.md), and [Configuration](docs/configuration.md) for usage,
precedence, and host-specific limits. Focused unit and mocked host tests cover
path confinement, native collisions, ordered permission policy, scoped prompt
sections, command refresh, and concurrent setup teardown. Live OpenCode process
tests require explicit user authorization under the repository's test policy.
