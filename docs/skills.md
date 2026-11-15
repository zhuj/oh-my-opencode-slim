# Skills

Skills are specialized capabilities and workflows you can assign to agents.
Unlike MCPs (which are running servers), skills are **prompt-based instructions**
loaded into an agent's context to guide decisions, workflows, and tool use.

Bundled skills are registered by the plugin at load (never copied to the user
skill directory): v1 scans the package paths and v2 registers them in-process.
Plugin updates apply on the next OpenCode restart. Skills listed in
`disabled_skills` are not registered. To override a bundled skill, create a
same-named directory under `~/.config/opencode/skills/` — directory skills take
precedence over the bundled registration.

Legacy managed copies are removed only if their content still matches the last
managed version. Edited copies are kept; disabled edited copies are moved to
`~/.config/opencode/.oh-my-opencode-slim-skill-backups/` outside the skill scan.

## Skill Slash Commands

On OpenCode V2, every skill in the host's registered skill inventory is eligible
for `/<skill-id>` unless an explicit command already owns that name or its
effective command mode is `none`.
This includes global/user skills such as `/show-me`, native project skills,
plugin-project skills, and registered bundled skills. IDs, not display names,
identify commands; duplicate IDs produce only one command. Skills with
`autoinvoke: false` still get a generic command when their effective mode is
`full` or `reference`.

### Modes and Precedence

The optional root plugin setting `skillCommandMode` selects the default mode.
Omitting it preserves `full`, the existing inline behavior:

| Mode | Generic skill-command behavior |
|------|--------------------------------|
| `full` | Inline the skill body using the existing, unchanged template. |
| `reference` | Instruct the model to load and follow the exact skill ID with the `skill` tool, then supply the original arguments in `<user-request>`. No skill body is inlined. |
| `none` | Skip generic command generation without disabling the skill itself. |

A skill's `SKILL.md` YAML frontmatter can override the global mode with nested
`slim.command` set to `none`, `full`, or `reference`. A missing or invalid override
inherits the global mode. A valid `full` or `reference` override can enable a
generic command even when the global mode is `none`. See the
[configuration examples](configuration.md#skill-slash-command-mode).

These settings only control generic skill commands. They do not change skill
discovery, `disabled_skills`, or permissions. Explicit host/user commands and
the plugin's `/deepwork`, `/reflect`, and `/interview` workflows keep
their own behavior and collision precedence in every mode.

### Prompt Delivery

In `full` mode, `/show-me explain this flow` submits a normal user prompt built
from the unchanged shared skill-command template:

```text
<skill-instruction>
Base directory for this skill: /path/to/skills/show-me/
File references (@path) in this skill are relative to this directory.

...show-me body...
</skill-instruction>

<user-request>
explain this flow
</user-request>
```

In `full` mode, when the host inventory reports no body, the
`<skill-instruction>` wrapper is still emitted with an empty body rather than
falling back to a model-mediated `skill` tool load. The two directory-hint lines
are dropped when no skill directory is known, so a body is never anchored to a
wrong path.

In `reference` mode, the prompt instead asks the model to load and follow the
exact skill ID through the `skill` tool, followed by the original arguments in
`<user-request>`. It contains no inline skill body. This is a model-mediated
instruction, not an automatic tool call or a guarantee that loading succeeds.
The skill must be available to the tool, and normal skill-tool permissions and
denials still apply. Bundled skills are also registered natively on V1 through
the package skill paths; command generation does not replace that registration.

The bridge does not inject a skill body into system prompts, attach the target
through `prompt.skills`, or call `session.skill`. Arguments remain unchanged,
including whitespace, multiline input, quotes, `$ARGUMENTS`, and `$1`. Files,
agent mentions, already-attached skills, and delivery mode are forwarded
unchanged.

V1 bundled commands use `$ARGUMENTS` as the placeholder the host substitutes.
In `full` mode, their base directory is the bundled skill's directory inside
the installed package. V2 has no host substitution, so it formats the selected
prompt per invocation.

`full` spends more context per invocation and delivers the body without a
native skill-tool load, whether or not the target skill is granted to the
active agent. This does not grant permission for actions described by that
body. Choose `reference` when you want loading to go through the normal skill
tool and its permission gate instead.

### Host Scope and Refresh

On V2, the mode applies to all skills in the inventoried generic-command bridge.
On V1, it applies only to plugin-generated bundled templates. Native OpenCode
skill-to-command conversion for non-bundled skills remains host-owned and is
not controlled by these settings. Host-command precedence is unchanged.

The global `skillCommandMode` is loaded at startup. Reload the plugin (or
restart OpenCode) after changing it; an inventory refresh alone does not reload
the global setting.

A slash command whose name is in neither the merged config's command registry
nor the generated skill-command set is answered with
`Command "/<name>" not found. Use the skill tool to list available skills and
commands.` On V1 the first set is the full host and user command inventory. On
V2 `prepareCommands` receives an empty config, so that set holds only the
plugin's own reserved command names and the generated skill-command names are
the second set; a host-native V2 command is outside both.

The catalog reconciles after event consumption starts and on `skill.updated`
or `plugin.updated`, including filesystem skills registered later during host
activation. Updates are serialized and coalesced without polling or waiting for
later plugins inside setup. Host skill reloads update additions, removals, and
descriptions. Scoped events must match the instance directory and workspace;
unscoped events refresh only that instance's catalog. Generated command names
and missing-command lookups belong to that setup generation, so another
workspace's refresh or an older generation's disposal cannot replace them.

V2 also resolves per-skill `slim.command` metadata on these inventory refreshes.
It accepts paths to either `SKILL.md` or the containing directory. If the file
is unreadable or no usable path exists, it uses inline metadata when available,
otherwise the global mode. Such skills are not excluded merely because their
path or file is unavailable.

An unchanged inventory reuses the current registration. When a refresh replaces
it, the bridge removes the previous registration before reading command
collisions, so existing explicit executors are preserved. Missing or invalid
inventories leave no generated commands rather than restoring stale entries
over explicit commands. A later valid event can recover the bridge. Missing
prompt/registration APIs disable only generic commands.

`command.updated` is deliberately ignored because the bridge's own registration
emits it. A command-only reload of an earlier transform can introduce an explicit
name hidden under a generated command until the next skill/plugin update; the
host inventory lacks provenance to resolve that case automatically. Later
explicit registrations win naturally. This is not universal dynamic command
precedence. Plugin-owned project skill files are still discovered at setup;
reload the plugin to rediscover those files (see project customization).

---

## Verification and Review Budget

Use a proportionate final-state verification plan for each change. Run checks
required by repository and release instructions; add independent review or
broader evidence only when the change's risk or uncertainty warrants it.

---

## Available Skills

### Bundled in repo

| Skill | Description | Assigned to by default |
|-------|-------------|----------------------|
| [`simplify`](#simplify) | Behavior-preserving code simplification | `oracle` |
| [`codemap`](#codemap) | Repository codemap generation | `orchestrator` |
| [`clonedeps`](#clonedeps) | Local dependency source cloning | `orchestrator` |
| [`delegation`](#delegation) | Lossless model references for delegation | `orchestrator` |
| [`deepwork`](#deepwork) | Heavy/complex coding sessions workflow | `orchestrator` |
| [`verification-planning`](#verification-planning) | Design project-specific evidence before implementation | `orchestrator` |
| [`step-back`](#step-back) | Pause snowballing patches and reassess direction | `orchestrator` |
| [`deanchor`](#deanchor) | Generalize from examples instead of copying them | `orchestrator` |
| [`ai-estimates`](#ai-estimates) | Estimate task duration for a human working with AI | `orchestrator` |
| [`reflect`](#reflect) | Review repeated work and suggest reusable workflow improvements | `orchestrator` |
| [`worktrees`](#worktrees) | Safe Git worktree lane management | `orchestrator` |
| [`oh-my-opencode-slim`](#oh-my-opencode-slim) | Plugin configuration and self-improvement guidance | `orchestrator` |

For example, invoke the bundled workflows directly with `/deepwork <task>`,
`/reflect`, or `/codemap`. Skills remain available through the native skill
system on hosts that do not expose them in the slash-command catalog.

---

## simplify

**Behavior-preserving simplification for readability and maintainability.**

`simplify` is a bundled skill for clarity-focused refactoring without behavior changes. It helps `oracle` reduce unnecessary complexity, improve naming and structure, and keep simplification work scoped and reviewable.

By default, this skill is assigned to `oracle`, which owns code review, maintainability review, and simplification guidance. The `orchestrator` should route simplification requests to `oracle` instead of handling them as a top-level specialty itself.

Source: adapted from Addy Osmani's `code-simplification` skill and bundled locally as `simplify`.

---

## codemap

**Automated repository mapping through hierarchical codemaps.**

`codemap` empowers the Orchestrator to build and maintain a deep architectural understanding of any codebase. Instead of reading thousands of lines of code on every task, agents refer to hierarchical `codemap.md` files describing the *why* and *how* of each directory.

**How to use:** Ask the Orchestrator to `run codemap`. It automatically detects whether to initialize a new map or update an existing one.

**Why it's useful:**
- **Instant onboarding** - understand unfamiliar codebases in seconds
- **Efficient context** - agents read architectural summaries, saving tokens and improving accuracy
- **Change detection** - only modified folders are re-analyzed
- **Timeless documentation** - focuses on high-level design, not implementation details

See **[Codemap Skill](codemap.md)** for full documentation including manual commands and technical details.

---

## clonedeps

**Local source mirroring for important project dependencies.**

`clonedeps` helps the Orchestrator clone a small, approved set of dependency
source repositories into `.local/.slim/clonedeps/repos/` so OpenCode can inspect library
internals while keeping cloned code out of git.

The skill is assigned to `orchestrator`. The orchestrator may ask `@explorer`
to identify important dependencies and resolve official repository URLs/tags,
then asks for approval before cloning with direct git/filesystem operations.
There is intentionally no helper script; dependency discovery and ref validation
are handled by the orchestrator/explorer workflow so the skill works across
languages and repository types.

Before planning, the orchestrator checks `.local/.slim/clonedeps.json` and reuses
existing clones when possible. After cloning, it adds or updates a concise
`## Cloned Dependency Source` section in root `AGENTS.md` that lists each
read-only cloned repo path directly with a one-sentence purpose.

Safety defaults:

- direct, important dependencies only;
- max 3-5 clones by default;
- HTTPS repositories only;
- pinned tags/commits only;
- no dependency scripts are executed;
- ignore-file edits are limited to managed marker blocks.

See **[Clonedeps](clonedeps.md)** for the full workflow and file layout.

---

## delegation

**Lossless model-reference selection for delegated host calls.**

`delegation` teaches the Orchestrator the canonical
`provider/model[#variant]` format. The first slash separates the provider;
remaining slashes and all colons belong to the model ID. Only `#` separates a
variant. The skill uses the `ref` field from each `resolve_model` match and
applies variant precedence before calling a provider-required host API.

Use it whenever delegation selects or overrides a model. It stops rather than
guessing a provider, silently substituting a model, or accepting malformed
reserved delimiters.

Override fields must be supported by the active host tool schema; OpenCode v1
native `task` has no model override field. When a host exposes separate
`provider`, `model`, and `variant` fields, a separate `model` is kept lossless,
including IDs such as `inkling-small:free`. The task-session admission hook
uses that provider/model identity for routing and concurrency without
rewriting the host arguments.

`resolve_model` returns `{ matches }` from the connected provider/model registry
when the host exposes it, with the static `MODEL_MAPPINGS` preset table as a
degraded fallback. Matches retain catalog spelling and include `provider`,
`model`, and one canonical `ref`.
Results are deduplicated and ranked before the fixed 20-result cap; an empty
query lists known models, and an unmatched query returns an empty list.

Discovery checks literal catalog identities first, including nested model IDs
and colon suffixes such as `:free` or `:max`. In bare free-text queries only,
legacy colon/space suffixes recognize `off`, `low`, `medium`, `high`, `xhigh`, `max`, `minimal`,
`none`, `auto`, and `thinking`; parenthesized variants can use custom names.
Qualified references never reinterpret colon suffixes as variants:
`provider/model:max` preserves `model:max`. Variants affect query interpretation
but are not added to returned model references or checked for provider support.

Bare-name aliases support Gemini 3 Pro high/low → preview, Gemini 3.1 Pro
high/low → base, and the legacy `claude-opus-4-7-thinking` → base spelling.
Literal catalog matches take precedence over aliases. Explicit provider scopes
never spill into another provider. GPT, Claude, Kimi and GLM version separators
are normalized for matching, while output identities remain unchanged.
Existing exact/token/prefix/substring/typo tiers and lexical tie-breaking are
retained; discovery does not manufacture unavailable fallback candidates or
rewrite catalog identities used by host calls.

**Migration:** Dollar-separated references are rejected. Replace their provider
separator with `/`. Executable colon-delimited variants must use `#` instead:
`provider/model:high` now means the literal model ID `model:high`, while
`provider/model#high` selects variant `high`. Colons already in catalog IDs
remain unchanged. The redundant `ref_standard` and `ref_explicit` response
fields have been removed; consumers must use `ref`.

---

## deepwork

**Heavy/complex coding sessions and large modifications workflow.**

`deepwork` is an orchestrator workflow for building a whole product or subsystem, deep architectural work, and complex refactoring. It works like a painter: the whole picture first, then more detail in each pass, with one review gate per pass. It is surfaced two ways: as a resident bundled skill (so the model can auto-activate it when a task clearly warrants it) and via the self-contained `/deepwork <task>` command, which injects the full bundled `SKILL.md` instructions directly. The command does not depend on skill registration — users who prefer minimal resident context can list `deepwork` in `disabled_skills` without losing `/deepwork`. To also remove the command, list `deepwork` in `disabled_commands`.

Start it directly with:

```text
/deepwork <heavy coding task>
```

**How it works:**
1. Work in passes over the whole product: a thin end-to-end **sketch**, then
   **structure** (real data model, boundaries, main failure paths), then
   **detail** (hardening, crash recovery, edge cases, polish). Security and
   money/data correctness are never deferred.
2. Each pass has a one-line goal and a few lanes with disjoint write scopes.
   @designer and @fixer are separate lanes from the start; if any lanes are
   risky (state, money, concurrency, crash recovery, destructive operations),
   one short @oracle design review of the pass plan covers them before code.
3. Lanes report changed files, exact commands with exit codes, and what is
   unverified; the orchestrator accepts after checking one decisive artifact.
   Lanes run focused checks; the broad suite runs once per pass.
4. Each pass ends with broad validation, one @oracle gate scoped to that
   pass's fidelity (later-pass findings go to a known-issues list), a commit,
   and a step back: run the whole product, re-plan the next pass, and
   reorganize code that grew huge or tangled.
5. Runs autonomously to the end by default; asks only when truly blocked
   (credentials, paid commitments, irreversible or public actions, no safe
   default) or when the task asks for check-ins.

**State** (kept small; for resuming after compaction, not activity logging):

- Router head `.local/.slim/deepwork/<session-id>.md`: `status:` and `slug:` only.
  Reused on resume; never modify another session's head.
- Progress file `.local/.slim/deepwork/<task-slug>/progress.md`: ~40 lines of current
  state — pass, goal, next step, decisions, running lanes, ranked known
  issues, and concise References to project files (add a sha when its revision
  matters). No activity log.
- Deepwork-owned process files stop at head and progress. Durable verdicts,
  research, and decisions go to the project's existing tracked documentation;
  generated assets stay where their producing script or path contract requires.
- Before creating state, `.gitignore` gets `.local/.slim/deepwork/` and `.ignore` gets
  `!.local/.slim/deepwork/` plus `!.local/.slim/deepwork/**` (only missing entries).

**Migrating existing `.slim/deepwork/` trees** (one-time, per project; no tooling):

The command, skill, and post-compaction pointer all use
`.local/.slim/deepwork/`. Existing files are not moved or read from the old root
automatically.

- Keep generated or pinned assets where code, tests, or frozen pins require them.
- Promote durable old topic files individually to existing tracked project docs;
  discard transient process notes instead of bulk-migrating them.
- Existing `.runtime/receipts/` data is obsolete after the guard removal and
  may be deleted locally. Tombstone archiving remains a project convention.

**When to use:** Large-scale refactoring, multi-file architectural changes, complex feature development spanning modules.

**When NOT to use:** Simple single-file edits, trivial bug fixes, quick one-off changes.

---

## verification-planning

**Design project-specific evidence before non-trivial implementation.**

`verification-planning` is an orchestrator-only skill for planning how a
non-trivial implementation, bug fix, refactor, multi-layer change, or externally
visible behavior will be proven before work begins. It starts with the claim to
establish, its uncertainty and failure modes, then generates evidence paths from
the system's controllable inputs, state transitions, boundaries, artifacts,
invariants, reversibility, and repeatability rather than defaulting to familiar
methods.

When the system cannot expose decisive truth clearly enough, the skill may add a
verification affordance: the smallest temporary or durable capability that makes
the relevant state controllable, observable, repeatable, and diagnosable for an
agent. This lets the agent improve the system's legibility instead of accepting
weak, indirect evidence.

It selects the narrowest path by credibility, signal quality, cost, safety, and
independent inspectability or repeatability. When relevant project facilities or
constraints are unfamiliar or rapidly changing, it asks `@explorer` for focused
official and project-specific research before deciding; it does not seek generic
testing advice or research when current evidence is already decisive.

**When NOT to use:** tiny mechanical edits. It complements ordinary verification
and deepwork, does not prescribe a default mechanism, and requires approval for
verification-only dependencies, persistent instrumentation, production debug
surfaces, or structural changes. Temporary support is removed; durable support
needs a clear justification. Completed work reports what was established and its
limitations.

---

## step-back

**Pause snowballing patches and reassess direction before continuing.**

`step-back` is an orchestrator-only skill for the moment a task keeps growing
through patches: repeated fixes, workarounds, compatibility shims, or a new path
built beside an old one. Instead of quietly pushing on, the agent checks whether
it would build the thing this way from scratch. If not, it briefly tells the
user the current direction, why it is drifting, a cleaner alternative, and its
recommendation, then lets the user decide.

**When NOT to use:** small, clean, bounded edits where the current direction is
still proportional.

---

## deanchor

**Generalize from examples instead of copying them with light edits.**

`deanchor` is an orchestrator-only skill for requests that include examples,
samples, templates, or reference outputs. Examples weight a model's output
heavily, so it tends to return one of them slightly reworded. This skill has
the agent separate what the examples share (intent, constraints, taste) from
what is incidental (phrasing, length, topic, order), then produce something
original at that level and check it is not a light edit of any one example.

**When NOT to use:** when the user explicitly wants an example's exact format
reproduced.

---

## ai-estimates

**Estimate task duration for a human working with AI, not alone.**

`ai-estimates` is an orchestrator-only skill for questions about how long a
task will take, whether coding, writing, research, analysis, design, or data
work. Models learned their sense of duration from human-only work, so they
default to estimates like "a few weeks" for work AI can draft in hours. This
skill has the agent price AI-capable work at AI speed (plus review and fixes)
and human or external bottlenecks (decisions, access, approvals, real-world
testing, waiting on others) at human speed, then give a range and say which
part dominates.

**When NOT to use:** questions that are not about duration or effort.

---

## reflect

**Learn from repeated work and suggest practical workflow improvements.**

`reflect` is an orchestrator-only workflow skill for reviewing recent work,
finding repeated workflow friction, and recommending the smallest useful reusable
asset. It may suggest a skill, custom agent, command, config rule, prompt rule,
MCP permission change, or project playbook - but only when there is enough
evidence.

Use it directly with:

```text
/reflect
/reflect release workflow and checks
```

You can also use natural prompts such as:

```text
reflect on my recent workflows
find repeated work worth turning into reusable instructions
suggest skills or agent config improvements from what I keep doing
```

Listing `reflect` in `disabled_skills` also disables the `/reflect` command;
the command is not registered when the skill is disabled.

Reflect is intentionally conservative. If no repeated workflow is strong enough,
it should recommend creating nothing instead of manufacturing new assets.

**When to use:** recurring workflow friction, repeated manual processes, repeated
agent-routing preferences, or prompts/config rules that you keep re-explaining.

**When NOT to use:** one-off implementation tasks, speculative agent creation,
or broad self-improvement ideas with no usage evidence.

---

## worktrees

**Safe Git worktree lane management for isolated coding.**

`worktrees` is an orchestrator-only skill for managing Git worktrees as safe,
isolated coding lanes. Instead of polluting your current branch or juggling stash
state, the Orchestrator can set up lanes under `.local/.slim/worktrees/<slug>/` and
track them in `.local/.slim/worktrees.json`.

Other agents can be delegated tasks inside the worktree lane, but the Orchestrator coordinates the lifecycle, validation, and final integration.

Safety defaults:
- Pre-flight check on Git repo status and dirty worktrees.
- Strict confirmation gates for all git modifications (`worktree add/remove`, `merge`, `rebase`, `cherry-pick`, `reset --hard`, branch operations).
- Branch names default to `omos/<slug>` but respect custom user patterns.
- Use a proportionate final-state verification plan before final integration.

See **[Worktrees](worktrees.md)** for the detailed safety protocol.

---

## oh-my-opencode-slim

**Configure, customize, and safely improve this plugin setup.**

`oh-my-opencode-slim` is an orchestrator-only skill that teaches agents how to
configure the plugin itself: model presets, custom agents, agent prompts,
`orchestratorPrompt` delegation hints, skills, MCP permissions, optional agents,
and related OpenCode config files.

It is registered by default with the bundled skills and is available to the
Orchestrator through the default `skills: ["*"]` configuration.

The skill also tells the Orchestrator to notice repeatable workflow friction and
suggest safe config or prompt improvements. It must ask before changing config or
prompts unless the user explicitly requested the exact edit, and it reminds users
that OpenCode may need a restart for config, prompt, agent, skill, MCP, or plugin
changes to take effect.

Typical requests:

```text
Tune my oh-my-opencode-slim models for lower cost.
Add a custom API reviewer agent.
Make the Orchestrator more conservative about parallel writer agents.
Help me configure MCP access for Explorer only.
```

After config changes, expect guidance like:

```text
This should apply on the next OpenCode run; restart OpenCode if you need it immediately.
```

---

## Skills Assignment

Control which skills each agent can use in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

| Syntax | Meaning |
|--------|---------|
| `["*"]` | All installed skills |
| `["*", "!codemap"]` | All skills except `codemap` |
| `["simplify"]` | Only `simplify` |
| `["?review"]` | Select `review`, requiring permission approval |
| `[]` | No skills |
| `["!*"]` | Deny all skills |

**Rules:**
- `*` grants access to registered skills, subject to global disables and
  native permissions
- `!item` excludes a specific skill
- Conflicts (e.g. `["a", "!a"]`) → deny wins (principle of least privilege)

The orchestrator's `<Agents>` routing block shows each specialist's effective
grants (from `skills`, `disabled_skills` and `permission.skill`) on that
specialist's line (for example `Skills: simplify.`, `Skills:
all`, or `Skills: all except codemap.`). This lets the orchestrator load
skills only it has itself instead of asking a delegate that can't load them.
Specialists with no skills show nothing.

**Example:**

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "skills": ["codemap"]
      },
      "oracle": {
        "skills": ["simplify"]
      },
      "designer": {
        "skills": []
      },
      "fixer": {
        "skills": []
      }
    }
  }
}
```

### Adding or removing skills on top of an inherited list

`skills` is replaced wholesale when multiple config layers (user, project, preset) define it. To adjust an inherited list instead, use the `skills_add` / `skills_remove` directives. They are folded into the effective token list during config resolution and stripped afterwards. Authorization is compiled separately while deliberate entries can still be distinguished from automatic/default selections; a normalized list is not itself permission to load every selected skill:

| Field | Type | Meaning |
|-------|------|---------|
| `skills_add` | string[] | Skill names appended to the effective list (after `skills`) |
| `skills_remove` | string[] | Skill names removed from the effective list; removal wins over addition |
| `skills_include_local` | boolean | Selects valid current/ancestor `.opencode/skills` and `.agents/skills` names plus admitted supplemental project skills, subject to `skills_remove` and explicit permission policy |

```json
{
  "agents": {
    "oracle": {
      "skills_add": ["nexus-backend"],
      "skills_remove": ["deepwork"]
    }
  }
}
```

**Rules:**
- Duplicates are removed (first occurrence wins) before removals are applied
- If the result contains `"*"`, each removed name is appended as `"!<name>"` so the exclusion beats the wildcard grant
- On an agent without a `skills` list, directives resolve against that agent's default grants (orchestrator: all skills), so `skills_add` keeps the defaults and appends, and `skills_remove` prunes from them
- An explicit base `skills` array and surviving deliberate `skills_add` entries retain their authority over nested `permission.skill`. Add-only directives do not promote inherited defaults past an explicit ask/deny; repeating a default name in `skills_add` is a deliberate grant.
- Default and automatically discovered selections remain bounded by scalar or ordered exact/wildcard `permission.skill` rules. `skills_include_local` can select a local name without auto-allowing it: the name may remain listed/admitted while its effective decision is ask or deny.
- `skills_add` never overrides an inherited exclusion: adding a name that the effective list already excludes (as `"!<name>"`) is a no-op. To re-allow it, lift the exclusion with a `skills_remove` entry of the form `"!<name>"`
- A removal entry of the form `"!<name>"` removes the exclusion token itself (it lifts an existing exclusion); the `"*"` token is never expanded

For marketplace agents, the resolved selection also defines capability
admission. Ask/deny authorization does not enlarge that admission, and a
deliberate wildcard selection remains open-ended rather than being expanded to
currently known names. SDK/native permissions and child constraints share this
admission: later explicit host allows can win inside it, never outside it.

### Unsupported Integer-Index Skill IDs

Canonical decimal skill IDs `0` through `4294967294` are rejected because
JavaScript enumerates those object keys before other permission rules. This
also rejects directive tokens such as `?123` / `!123`, exact skill permission
rules, and exact skill resources generated by compilation. It does not ban all
numeric-looking names: `01`, `00`, `-0`, `+1`, `1.0`, `1e2`, `4294967295`, and
larger non-index strings remain supported.

Actual skill IDs must not contain `?` or `*` anywhere. The restriction covers
plugin-owned project/native-path and frontmatter identities, marketplace skill
dependencies, package/bundled defaults, discovered local IDs, and literal
`disabled_skills` entries. Literal `!` names such as `!123` remain permitted:
typed internal selection keeps these defaults and discovered names distinct
from directive operators through capability admission and permission projection.

This does not restrict wildcard **policy syntax**. The config directive arrays
`skills`, `skills_add`, and `skills_remove` keep their existing single-prefix
interpretation: `*`, `?review`, `!blocked`, and supported pattern tokens still
work. A directive `!123` still targets numeric `123` and is rejected, unlike an
actual default/discovered ID named `!123`. Permission resource patterns such as
`*`, `?`, `foo*`, and `review?` are also unchanged. There is no new escaping syntax
or config key, and numeric resources for non-skill actions remain valid.

Plugin-owned project/bundled registration and marketplace dependency/frontmatter
intake reject invalid IDs with diagnostics rather than silently treating an
explicit name as absent, choosing a fallback identity, or registering a partial
candidate list. Existing normalization still applies before validating the
identity a given intake actually uses. V2 project skills check the path-derived
host ID as well as the frontmatter permission identity when they differ.

Host-owned native/global skill catalogs are not universally enumerated or
unregistered. This is not host-wide rejection of independently registered IDs.
Their wildcard access is outside this compatibility guard; exact
invalid skill selections/rules entering plugin policy are rejected fail-closed.
See [Configuration](configuration.md#unsupported-integer-index-skill-identifiers)
for the config-loading and child prompt-admission failure contract.
