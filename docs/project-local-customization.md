# Project-local Customization

This document describes how to configure and customize oh-my-opencode-slim on a per-project (repository-specific) basis. Project-local customization lets teams and repositories define custom agents, override systemic prompts, restrict skills, and set MCP configurations without affecting global user configurations.

## Security & Trust Boundary Warning

> ⚠️ **IMPORTANT SECURITY NOTICE**
> Because project-local configuration files (`.opencode/oh-my-opencode-slim.jsonc`) and prompt templates (`.opencode/oh-my-opencode-slim/`) are loaded automatically when you open and work in a project directory, they can modify agent behaviors, enable/disable tools, and grant extra model access permissions.
> **Only work in and run OpenCode within repositories you explicitly trust.**

Configuration discovery also includes `.opencode/oh-my-opencode-slim.json[c]`
in eligible ancestor directories. This matches the host's discovery: v2 walks
through the filesystem root, even above repository and worktree boundaries;
v1 stops at the Git worktree boundary, inclusive, or the filesystem root when
there is no Git boundary. Prompt files and optional local skill grants use the
same walk. `OPENCODE_DISABLE_PROJECT_CONFIG=true` or `1` disables that project
walk, leaving user configuration available. Review and trust ancestor
directories too. On v2, `~/.opencode` is a project layer for projects under
`$HOME` and overrides matching `~/.config/opencode` settings; on v1 it must be
within the worktree walk to be inherited.

The implementation references are OpenCode v1's
[ConfigPaths.directories](https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/config/paths.ts)
and OpenCode 2.0.22's
[ConfigDiscovery](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/config/discovery.ts)
and its [filesystem walk](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/util/src/fs-util.ts).

---

## Feature Comparison

| Feature | Scope / Location | Description |
|---|---|---|
| **Configuration file** | `.opencode/oh-my-opencode-slim.json[c]` | Project-level configuration file that overrides global user settings, merging presets, agent profiles, and multiplexer integration. |
| **Custom agents** | `agents` configuration block | Define new specialized agents by keying them under `agents.<custom-name>` with required `model`, custom system `prompt`, and optional routing guidance. |
| **Built-in prompt overrides** | `.opencode/oh-my-opencode-slim/<agent>.md` | Override the built-in system prompt for any agent (e.g. `oracle.md`, `explorer.md`, `orchestrator.md`, or custom agents). Acts as the default when no inline `prompt` is set in config. |
| **Append prompts** | `.opencode/oh-my-opencode-slim/<agent>_append.md` | Append additional rules or guidelines to the existing base (inline, file, or default built-in) prompt without overriding it completely. |
| **Shared base layer** | Every constructed agent | Adds role-neutral scope, evidence, uncertainty, and truthful-validation guidance once after prompt composition. |
| **Per-agent skills** | `agents.<agent>.skills` | Explicitly restrict or authorize specific local codebase skills/scripts that this agent is allowed to execute. |
| **Automatic project-local skills** | `agents.<agent>.skills_include_local` | Opt in to granting valid names discovered under plugin-owned project skill roots and the current and ancestor native `.opencode/skills` names-only scan within the host's discovery boundary. |
| **Per-agent MCPs** | `agents.<agent>.mcps` | Assign, restrict, or authorize specific Model Context Protocol (MCP) servers (like `context7` or `gh_grep`) to specific agents. |
| **Presets** | `presets` configuration block | Bundle named agent environments. User and project preset definitions deep-merge; the active preset then merges into `agents`. |
| **Precedence** | User config, project config, presets, prompt files | Project-local settings take precedence over user-global settings, while root `agents.*` entries beat active preset entries. |

---

## Project-local resource roots

Plugin-owned project resources are discovered beneath category directories at
eligible ancestors from the host-supplied active directory through the
host-supplied OpenCode project/worktree boundary, including that boundary.
When the host does not provide a valid boundary, discovery fails closed rather
than substituting the process working directory. That boundary walk never steps
above the boundary or outside it through a symlink. The default ordered
prefixes are `.local`, `.local/.slim`, and `.opencode`; rules and eligible
extra skills use `rules/` and `skills/` under each prefix. The `.opencode`
prefix does not transfer native OpenCode resource ownership to the plugin:
native skills, commands, agents, and `AGENTS.md` remain host-owned.

Rules have one additional source outside that walk: `rules/` under every
OpenCode config directory (`OPENCODE_CONFIG_DIR`, then
`XDG_CONFIG_HOME/opencode` or `~/.config/opencode`). These global rules are
resolved by a separate step that the boundary walk cannot produce, and each
config directory is resolved independently so an unreadable one costs only
itself rather than the whole injection pass. Global rules keep a
`global-rules/` label in their injected heading instead of the `..`-laden
relative path the project walk would otherwise produce. Symlinks are not
resolved, so a symlinked config directory keeps the path you configured. This
source covers `rules` only; global `skills`, `commands`, and `agents` stay
host-owned.

A rule's identity is its filename, so global rules register unconditionally and
a project rule overrides a global rule of the same name:

- A project rule with the same filename replaces the global one entirely. Only
  the more specific rule is injected.
- An **empty** project rule file with that filename disables the global rule.
  It exists only to claim the name, and nothing is injected for it.
- To disable a global rule for one file rather than every file, use the
  project's own selectors (`globs`, `paths`, `applyTo`) as usual.

Matching rules are injected least specific first, so the most specific rule
appears last and reads as the final word. Rules at the same specificity are
ordered by prefix, then filename.

### How specificity is measured

Specificity is a directory's **depth**: how many hops it sits below your home
directory. Home is depth `0`, `~/work/proj` is `1`, `~/work/proj/app` is `2`.
Deeper is more specific, so ordering by ascending depth is exactly "most generic
first, most specific last" — the order injected context wants. The same measure
orders rules, skills, commands, and agents; `rules` and `skills` are the
categories the plugin discovers project-local today.

Two kinds of root sit outside that scale and are deliberately ranked below
everything a project owns:

- A root under an OpenCode config directory is machine-wide shared state, so it
  takes the smallest depth there is and always sorts first.
- A root outside your home directory takes its hop count minus a fixed offset,
  which ranks it below every home-based root while leaving its order relative to
  other non-home roots intact.

Depth is measured from the path as the project spells it. Symlinks are not
resolved, so `a/b/c/d/e` scores as written even when `a/b/c` points somewhere
else. The boundary walk still refuses any root that resolves outside the project
boundary, so this affects how a root is named and ranked, never whether it is
allowed in.

Configure `resource_prefixes` to replace that default list:

```jsonc
{
  "resource_prefixes": [".local", ".team-config"]
}
```

An explicit list replaces the defaults; a project-config list replaces a
user-config list, while omission inherits the user list. An explicit empty
list (`"resource_prefixes": []`) disables prefix-based plugin discovery of
extra rules and skills. It does not disable the separate names-only scan of
the current and eligible ancestor native `.opencode/skills` trees used by the
`skills_include_local` permission option below.

Prefixes are relative directory fragments, not paths or glob patterns.
Absolute paths and `..` traversal are rejected. Resource discovery is
deterministic: within one ancestor the configured prefix order decides, and
ancestors themselves rank by depth. Resource-specific collision rules are
described below.

## Configuration Precedence

### Hierarchical rules

For a successful `read`, `write`, `edit`, or multi-file patch operation, the
plugin uses structured resolved file paths from the host result to find matching
`.md` and `.mdc` rule files under discovered `rules/` roots. Rules support
`alwaysApply`, `globs`, `paths`, and `applyTo` frontmatter selectors, including
negative patterns. Empty or absent selectors do not match every file. Matches
are ordered by depth, then prefix order and stable filename; this is ordering,
not an override rule. Native `AGENTS.md` is not parsed or injected by this
feature.

Matching rules are appended to the fresh result of the file operation, leaving
the original output and earlier conversation content unchanged. Repeated
unchanged rules are deduplicated per session; changed rule content can be
included again. Rule bodies use a 50,000-token ceiling. When valid usage and
model-context evidence is available, the total budget is further capped at
half the remaining context; if usage evidence is unavailable, the fixed
ceiling is used. Malformed/unreadable rules and discovery failures
are skipped without changing the file operation's result. V1 and V2 use their
respective supported host result-path and lifecycle APIs; pathless results do
not trigger rule injection. State is cleared on session deletion and
compaction, and all state is cleared on plugin disposal.

When oh-my-opencode-slim loads, it resolves configuration properties and prompt templates across multiple layers. The inheritance precedence operates strictly as follows:

```
[Built-in Defaults]
       ↓ (overridden by)
[User Config] (global)
       ↓ (overridden by)
[Ancestor Project Configs] (host boundary to current directory)
       ↓ (overridden by)
[Environment Preset Override] (via OH_MY_OPENCODE_SLIM_PRESET env var)
       ↓ (merged into agents)
[Active Preset] (merges preset-specific agent options)
       ↓ (overridden by)
[Root Config agents.*] (individual agent configs beat preset configurations)
```

### Note on Root Overrides vs Presets

Each ancestor layer merges before the next closer layer. A nested project or
worktree can override selected agent fields without duplicating the shared
configuration above it. Within each directory, `.jsonc` takes precedence over
`.json`; sibling directories are not searched.

The root `agents.*` configuration (defined at the top level of user or project config) always takes precedence over the active preset configurations. To override a root agent choice globally, you must specify the override in the project-level root `agents.*` rather than inside a local preset configuration alone.

---

## Additive and Subtractive Skill Configuration

The `skills` array is replacement-based: when a project config defines `agents.<agent>.skills`, it replaces the inherited list wholesale. To add project-specific skills on top of an inherited list — or remove inherited skills — without duplicating that list, use the `skills_add` and `skills_remove` directives:

```jsonc
// ~/.config/opencode/oh-my-opencode-slim.jsonc (global)
{
  "agents": {
    "oracle": {
      "skills": ["codemap", "deepwork"]
    }
  }
}
```

```jsonc
// <project>/.opencode/oh-my-opencode-slim.jsonc (project-local)
{
  "agents": {
    "oracle": {
      "skills_add": ["project-architecture", "project-testing"]
    }
  }
}
```

Effective result: `codemap`, `deepwork`, `project-architecture`, `project-testing` — the global list is not duplicated.

Resolution order is deterministic: resolve the inherited/configured `skills` list, then apply `skills_add`, then apply `skills_remove`. Duplicates are removed (first occurrence wins), and `skills_remove` wins over `skills_add` for the same skill. When the effective list contains `"*"`, removals are expressed with the existing `!name` exclusion syntax (e.g. effective `["*", "!codemap"]`). The directives are folded into `skills` during agent resolution — after all layers (user config, project config, presets, runtime `/preset` switching) have determined the effective `skills` value — and stripped from the final agent configuration, so agent definitions and hooks only ever see a plain `skills` list. On an agent without a `skills` list, directives resolve against that agent's default grants, so `skills_add` keeps the defaults and appends.

See [Skills Assignment](skills.md#adding-or-removing-skills-on-top-of-an-inherited-list) for the full rule set, including behavior when no `skills` list is configured.

### Including all project-local skills automatically

When a repository carries project skills under the default or configured
`skills/` roots, set `skills_include_local: true` to opt in to granting those
discovered skill names without repeating each name in `skills_add`. Native
 OpenCode skills remain host-owned; the plugin's current and eligible ancestor
`.opencode/skills` scan used for this option reads names only and does not load
or register their content:

```text
.opencode/skills/
└── project-architecture/SKILL.md  # name: project-architecture
.agents/skills/
├── project-testing/SKILL.md       # name: project-testing
└── project-release/SKILL.md       # name: project-release
```

```jsonc
// <project>/.opencode/oh-my-opencode-slim.jsonc
{
  "agents": {
    "oracle": {
      "skills_include_local": true
    }
  }
}
```

The flag opts into automatically granting valid discovered project skill names.
The native names-only scan includes current and ancestor
`.opencode/skills/**/SKILL.md` trees within the host's discovery boundary;
duplicate names are included once, and sibling trees are not searched.
Extra skill content is made available through the host's supported skill API;
discovering a skill by itself does not grant agent permission. Plugin-owned
project skill candidates require a nonempty `name` frontmatter field, which is
their identity rather than the directory name. For native V2 collision checks,
the host's own fallback applies when its optional `name` is omitted: a top-level
Markdown filename or a `SKILL.md` parent-directory name. New files are picked
up on normal plugin/host initialization; discovery does not add a filesystem
watcher.

For native V2 skills, keep the frontmatter name aligned with the host's skill ID
when using automatic grants, so name-based permission rules target the intended
 host skill. The option works in global user config and may be overridden per
 project. Names are granted once; sibling trees are not searched. New files are
 picked up on normal initialization rather than through a filesystem watcher.

It composes with the existing directives. For example, include all project-local skills but exclude one from `fixer`:

```jsonc
{
  "agents": {
    "fixer": {
      "skills_include_local": true,
      "skills_remove": ["project-release"]
    }
  }
}
```

`skills_remove`, explicit `!deny`, disabled-skill policy, and explicit
`?ask` permissions retain their existing precedence over automatic inclusion.
Known native skill-name collisions keep the host definition; duplicate names
among plugin-owned roots retain the first candidate in deterministic resolver
order. Keep names unique across all host and plugin skill sources. The plugin
does not scan unrelated user/global sources just to detect collisions. This
option does not grant global skills, configured external paths, or URL skill
sources.
The existing safety checks remain: symlinked native `.opencode` or `skills`
roots pointing outside their ancestor location are skipped, and symlinked skill
entries are not followed. Compatibility directories are outside the names-only
scan's scope. OpenCode remains responsible for registering and loading skills.

### V1 and V2 host integration

On OpenCode V1, eligible extra skill directories are added to the mutable
`skills.paths` before host discovery, without replacing existing paths. On V2,
eligible extra skill definitions are registered through the public skill
transform API. Both integrations exclude native host-owned roots and known
collisions; the host continues to own available-skill rendering and content.
The current and eligible ancestor `.opencode/skills` permission-name scan is
names-only, including when `resource_prefixes` is empty. These plugin-owned additions are discovered
during normal initialization, not by a watcher.

On V2 these registered project skills also join the event-driven `/<skill-id>`
command catalog, alongside global/user and registered bundled skills. Explicit
commands own collisions. The body is always inlined; command activation delivers
the skill content whether or not the skill is granted to the active agent.
Arguments and attachments are preserved. Reload to rediscover these
plugin-owned files; host skill/plugin inventory updates reconcile the command
catalog automatically. See [Skill Slash Commands](skills.md#skill-slash-commands)
 for lifecycle and command-only reload limits. Global skills, configured
 external paths, URL sources, and unrelated compatibility directories remain
 outside this option's scope. Symlinked roots resolving outside their ancestor
 location and symlinked skill entries are skipped.

---

## Prompt Lookup Precedence

When looking up markdown prompt template files (such as `<agent>.md` or `<agent>_append.md`), oh-my-opencode-slim searches directories in a strict hierarchical order. Precedence is evaluated for the replacement prompt file and the append prompt file **independently** in the following sequence:

1. **Project Preset Directory**
   `<project>/.opencode/oh-my-opencode-slim/<preset>/<agent>.md` (if preset is active and safe)
2. **Project Root Directory**
   `<project>/.opencode/oh-my-opencode-slim/<agent>.md`
3. **Ancestor Directories, Nearest First**
   Repeat the preset-directory then root-directory lookup in each ancestor's
   `.opencode/oh-my-opencode-slim/`, through the host's boundary. A nearer root
   prompt beats a farther preset-specific prompt.
4. **User Preset Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<preset>/<agent>.md`
5. **User Root Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<agent>.md`

Replacement and append files can come from different levels. Only the first
matching file of each kind is used; ancestor append files are not concatenated.
Inline prompt precedence and the composition rules below are unchanged.

---

## Prompt Composition Rules

For any agent, the final system prompt is computed dynamically. Precedence
is **inline > file > agent default**:

1. **Resolve the effective base prompt:**
   ```
   effectiveBase = inlinePrompt ?? filePrompt ?? defaultAgentPrompt
   ```
   - `inlinePrompt` is the `prompt` string set directly in
     `agents.<agent>.prompt` (config or preset).
   - `filePrompt` is the content of the resolved `<agent>.md` replacement
     file (located according to the Prompt Lookup Precedence).
   - `defaultAgentPrompt` is the agent's supplied default prompt
     (bundled or packaged), or `"You are the <name> specialist."`
     for custom agents.

   An explicit inline `prompt` always wins over a prompt file. The file
   acts as a shared default — useful for the "shared prompt, per-preset
   model" pattern where the file holds the common base and each preset
   only overrides `model` and `variant`.

2. **Conflict warning:**
   When both an inline `prompt` and a `<agent>.md` file exist, a
   `console.warn` is emitted at agent construction:
   ```
   [oh-my-opencode] Agent '<name>': inline prompt overrides prompt file
   (<name>.md). Remove the inline prompt to use the file.
   ```
   This is informational — the inline prompt takes effect as expected. The
   warning surfaces the conflict so you know the file is being ignored.

3. **Append prompt:**
   - If an append file `<agent>_append.md` is resolved, it is appended to
     the `effectiveBase` separated by two newlines:
     ```
     finalPrompt = effectiveBase + "\n\n" + appendPrompt
     ```
   - Otherwise:
     ```
     finalPrompt = effectiveBase
     ```

4. **Shared base layer:**
   Every agent returned by the plugin is finalized with the same deterministic
   role-neutral prefix after the effective prompt, append prompt, display-name
   rewrites, and routing guidance are composed:
   ```
   finalPrompt = sharedBasePrompt + "\n\n" + composedRolePrompt
   ```
   A replacement prompt replaces the role-specific body, not this shared
   prefix. The base layer is also applied to custom agents, ACP wrappers, and
   dynamic councillor agents.

### Host Vocabulary in Custom Prompts

Prompt text you supply is used **verbatim** for delegation vocabulary — the
plugin never rewrites delegation calls in it (`task(...)` on v1,
`subagent(...)` on v2). Separately, display-name substitution rewrites
`@<internalName>` mentions to the agent's `displayName` throughout the final
orchestrator prompt (inline, file, and append orchestrator prompts) and in
`orchestratorPrompt`/ACP routing snippets (see
[Display name rewriting](#custom-routing-guidance-orchestratorprompt) below).
The host you run on therefore determines the delegation vocabulary embedded in
that text:

| Host (plugin entry) | Delegation call | Agent param | Resume param |
|---|---|---|---|
| v1 (`opencode`) | `task(...)` | `subagent_type` | `task_id` |
| v2 (`opencode2`) | `subagent(...)` | `agent` | `sessionID` |

This applies to **every** prompt you supply:

- inline `agents.<agent>.prompt`,
- `<agent>.md` replacement and `<agent>_append.md` files,
- `orchestratorPrompt` routing snippets,
- custom and ACP agent prompts,
- council `presets.<name>.<councillor>.prompt` guidance.

A prompt that hard-codes delegation calls is therefore **not portable** between
v1 and v2 — keep a host-specific version for each.

The control-tool names (`task_status`, `task_message`,
`task_reply`, `task_revive`, `task_cancel`) are identical on both hosts. On v2
they take `sessionID` and also accept `task_id` as a deprecated alias (never
emitted).

---

## Prompt Section Templates

Replacement and append prompt files can opt into deterministic sections that
are generated when the agent definitions are constructed. The feature is
opt-in: the first line of the prompt file must be exactly:

```md
<!-- slim-prompt-template:v1 -->
```

After the marker, use these placeholders:

| Placeholder | Injected content |
|---|---|
| `{{slim.section.intent_gate}}` | Per-turn intent classification and authorization boundaries. |
| `{{slim.section.agents}}` | Safe agent aliases available to the current configuration. |
| `{{slim.section.task_management}}` | Whether the orchestrator wake scheduler is enabled. |
| `{{slim.section.verification}}` | Diagnostics, tests, build, and runtime verification guidance. |
| `{{slim.section.orchestration}}` | High-level outcome ownership and phase separation. |
| `{{slim.section.delegation}}` | Bounded briefs, dependencies, write ownership, and parallel lanes. |
| `{{slim.section.result_synthesis}}` | Reconciliation of specialist reports and verified evidence. |

Example `.opencode/oh-my-opencode-slim/orchestrator.md`:

```md
<!-- slim-prompt-template:v1 -->

# Repository Workflow

{{slim.section.intent_gate}}

{{slim.section.agents}}

{{slim.section.orchestration}}

{{slim.section.delegation}}

{{slim.section.result_synthesis}}

Keep repository-specific instructions below these generated sections.
```

The same rendering applies to `<agent>.md` replacement prompts and
`<agent>_append.md` append prompts. Inline `agents.<agent>.prompt` values still
override replacement files, but a resolved append file is still appended and
rendered. Unmarked file bodies remain byte-for-byte unchanged and do not opt
into section substitution accidentally; the shared base is still added to the
final agent prompt. Escape a placeholder as
`\{{slim.section.agents}}` when it must remain literal; unknown or malformed
placeholders fail agent construction with the prompt source in the error.

Sections contain construction-time configuration only. They never include the
current user message, timestamps, session identifiers, live task state, or
other per-request values, which keeps the prompt prefix deterministic for
provider prompt caching.

---

## Custom Routing Guidance (`orchestratorPrompt`)

Every non-orchestrator agent (both built-in and custom) can define an `orchestratorPrompt`. This snippet is automatically injected into the central **Orchestrator** prompt to instruct it on when and how to delegate tasks to this agent.

- **Additive Routing Guidance:** The local config snippet is grouped under a clear markdown header (`# Project-specific routing guidance`) at the end of the orchestrator prompt. It does not replace the default routing blocks.
- **Display name rewriting:** Any mentions of `@<internalName>` within the `orchestratorPrompt` are automatically mapped to the agent's custom `displayName` if one was defined.
- **Disabled agents:** If an agent is disabled via the `disabled_agents` config option, its `orchestratorPrompt` is **not** injected.
- **Orchestrator agent constraint:** The orchestrator agent itself cannot define an `orchestratorPrompt`. Setting `agents.orchestrator.orchestratorPrompt` will be rejected by the schema.

---

## Examples

### Overriding Oracle prompt in active preset

Your project has the config `.opencode/oh-my-opencode-slim.jsonc`:

```json
{
  "preset": "backend-preset",
  "presets": {
    "backend-preset": {
      "oracle": {
        "model": "anthropic/claude-3-5-sonnet",
        "prompt": "You are the project senior backend oracle. Focus strictly on NestJS."
      }
    }
  }
}
```

If you also place a file under `.opencode/oh-my-opencode-slim/backend-preset/oracle.md` containing:
```
Your primary focus is auditing backend security and performance.
```
The inline preset `prompt` takes precedence over the file, so the effective
base prompt becomes `"You are the project senior backend oracle. Focus
strictly on NestJS."`. A `console.warn` fires noting the file is being
overridden. To use the file prompt instead, remove the inline `prompt` from
the preset config.
