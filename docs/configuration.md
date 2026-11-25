# Configuration Reference

Core settings, feature switches, and configuration precedence for the current
OpenCode 2.4+ plugin. The generated
[`oh-my-opencode-slim.schema.json`](../oh-my-opencode-slim.schema.json) lists
accepted fields and types. Feature-specific settings live in the guides linked
below; they are not separate configuration systems.

## Config Files

| Location | Purpose |
|---|---|
| `<user-config>/opencode.json[c]` | Native OpenCode providers, permissions and `plugins` registration |
| `<user-config>/oh-my-opencode-slim.json[c]` | User-wide Slim agents, presets and optional features |
| `<directory>/.opencode/oh-my-opencode-slim.json[c]` | Project and ancestor overrides |

Slim looks first in `OPENCODE_CONFIG_DIR` when set, then in
`$XDG_CONFIG_HOME/opencode` (or `~/.config/opencode`). It reads the first user
file found, not both. Writes target the configured user directory. JSONC accepts
comments and trailing commas; `.jsonc` wins within a directory. Use
`{env:NAME}` for environment substitution; an unset value is empty.

Loading order is user configuration, then ancestor project configurations from
the filesystem root down to the current directory. Closer layers override
matching values, preserving unrelated settings. Objects merge; ordinary arrays
replace inherited arrays. Presets and permission objects have the rules below.
Only ancestors are inherited, not siblings. Projects under `$HOME` also inherit
`~/.opencode`, which can override matching user-wide settings.

**Trust every inherited directory.** Project configurations and prompt files can
change agents, permissions and executable ACP commands. Set
`OPENCODE_DISABLE_PROJECT_CONFIG=true` or `1` to disable project configuration,
prompt and local-skill discovery while retaining user configuration.

Configuration writes preserve symlinks and update their resolved targets.
Dangling or unresolvable links make the write fail. Backups are written beside
the configuration path. Marketplace project-scoped writes target the current
project, never an ancestor.

| Environment variable | Effect |
|---|---|
| `OPENCODE_CONFIG_DIR` | Preferred user configuration directory |
| `XDG_CONFIG_HOME` | Base of the default user configuration directory |
| `OH_MY_OPENCODE_SLIM_PRESET` | Override the configured preset selection |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Skip project configuration, prompts and local-skill discovery |
| `OH_MY_OPENCODE_SLIM_DISABLE` | `1`, `true`, `yes` or `on` skips all Slim setup; OpenCode still loads the package |

Run `oh-my-opencode-slim doctor` from the project to inspect discovered layers
and warnings. Unreadable or invalid layers are normally skipped without losing
other layers. Explicit unsupported host settings instead refuse startup with
the source path before merging; a nearer override cannot hide them. See
[Upgrading](installation.md#upgrading).

Configuration snapshots revalidate file identity and referenced environment
values. See [Runtime Efficiency](runtime-efficiency.md) for cold-loading and
refresh costs.

## Minimal Setup

Merge this into an existing Council/Observer configuration. Keep your
vision-capable Observer model and `council.presets`; this example changes feature
selection, not your model lineup:

```jsonc
{
  "backgroundJobs": { "mode": "off" },
  "tui": false,
  "autoUpdate": false,
  "liveConfigRefresh": false,
  "interview": { "enabled": false },
  "marketplace": { "enabled": false },
  "companion": { "enabled": false },
  "disabled_agents": ["explorer", "oracle", "designer", "fixer"],
  "agents": {
    "orchestrator": { "skills": [] },
    "observer": { "skills": [] },
    "council": { "skills": [] },
    "councillor": { "skills": [] }
  },
  "disabled_mcps": ["context7", "gh_grep"],
  "disabled_commands": ["deepwork", "reflect"],
  "disabled_hooks": [
    "phase-reminder", "foreground-fallback", "deepwork-goal", "chat-headers",
    "cache-monitor", "tool-loop-guard", "search-path-guard",
    "absolute-path-rescue", "apply-patch"
  ],
  "disabled_tools": ["webfetch", "ast_grep_search", "ast_grep_replace", "acp_run"]
}
```

Native subagents, completion delivery, Council seat assembly and Observer remain
available. Disabled implementations are not constructed. Previously evaluated
ESM modules cannot be unloaded; restart the host to measure cold-start savings.

### Implied switches

| Switch | Additional disables normally unnecessary |
|---|---|
| `tui: false` | `sidebar: false`, `/killall`, `/subagent`, `/queue`, TUI `/preset`, pane settings |
| `interview.enabled: false` | `/interview`, `/implement`, `interview_submit_state` |
| `marketplace.enabled: false` | `marketplace_inspect`, `marketplace_manage` |
| `backgroundJobs.mode: "off"` | Slim task tools, admission queue and `/queue`; session routing unless explicitly enabled |
| Disabled `foreground-fallback` hook | `fallback.enabled: false` |
| `disabled_skills: ["reflect"]` | Disabled `/reflect` command |

These implications are one-way. Keep a granular disable if its feature remains
active, or as an explicit veto against a nearer layer enabling that feature.

## Full Option Reference

### Core and feature switches

| Option | Default | Purpose |
|---|---|---|
| `preset` | Unset | Select startup agent configuration from `presets` |
| `routingBlock` | `false` | Add a static agent inventory to the stock orchestrator prompt. The native tool provides its permission-filtered roster independently |
| `presets` | Unset | Named agent configurations; optional single-parent `extends` |
| `agents` | Unset | Overrides shared across presets; unknown safe names define custom agents |
| `setDefaultAgent` | `true` | Set the native default to Orchestrator when unset or pointing at a subagent |
| `backgroundJobs.mode` | Unset | Unset or legacy `managed` enables the admission queue and native task controls. Explicit `native` enables native task controls with an optional queue. `off` disables both |
| `backgroundJobs.queue.enabled` | Follows mode and limits | Override queue enablement. Explicit `native` enables the queue when `concurrency` is present unless this switch is `false`. `off` always disables it |
| `backgroundJobs.concurrency.defaultConcurrency` | `0` | Default cap on open native admissions in the directory. Limits accept integers from 0 to 1000. `0` means unlimited |
| `backgroundJobs.concurrency.providerConcurrency` | `{}` | Caps keyed by provider ID, overriding the default cap |
| `backgroundJobs.concurrency.modelConcurrency` | `{}` | Caps keyed by `provider/model` without a variant, overriding the provider cap |
| `sessionPresetRouting` | Follows task mode | Independently enable persisted per-session inference bindings; `native` defaults on, `off` defaults off |
| `replaceBuiltinSubagents` | `true` | Hide undeclared native `general`/`explore`; `false` keeps their host configuration |
| `tui` | `true` | Enable all Slim TUI surfaces and server-side sidebar recording |
| `sidebar` | `true` | Sidebar and its state only; other TUI features remain enabled |
| `compactSidebar` | `true` | Compact rather than expanded sidebar layout |
| `sidebarShowHiddenAgents` | `false` | Show Council internals as sidebar rows; registration and native agent visibility are unchanged |
| `liveConfigRefresh` | `true` | Watch configuration candidates for inference-profile refresh; no watcher is created without a consumer |
| `resource_prefixes` | `[".local", ".local/.slim", ".opencode"]` | Ordered project resource prefixes. An explicit empty array disables supplemental resource discovery |
| `skillCommandMode` | `"full"` | Control generated skill commands with `"full"`, `"reference"` or `"none"` |
| `stripOrchestratorModel` | `false` | Omit the configured Orchestrator model/variant so native session selection can win; an explicitly selected preset model is retained |
| `autoUpdate` | `true` | Enable Slim TUI update checks and notices; host package management is separate |
| `questionTimeoutMs` | Unset/`0` | Opt-in automatic answer for eligible unanswered questions; enabled range 60,000–2,147,483,647 ms |
| `image_routing` | Observer-dependent | `auto` relays supported attachments when native vision is unavailable; `direct` leaves them inline |
| `interview.enabled` | `true` | Enable the Interview subsystem |
| `marketplace.enabled` | `true` | Enable Marketplace operations and activation |
| `companion.enabled` | `false` | Enable the optional desktop Companion |
| `multiplexer.type` | `"none"` | Select an optional child-pane backend |
| `multiplexer.agents` | `["*"]` | Filter which subagents open panes, not which can run; see [Multiplexer Configuration](multiplexer-integration.md#configuration) |

`questionTimeoutMs` requires an attached Slim TUI with `tui` enabled. It answers
questions that permit custom responses, never permissions or closed-choice
requests. Restart the TUI after changing it; an already-open question is not
re-armed on restart.

Observer is disabled by default. Removing it from `disabled_agents` enables the
agent; configure a model that accepts images. When `image_routing` is omitted,
it resolves to `auto` with Observer enabled and `direct` otherwise. Explicit
`auto` requires Observer. Vision-capable request models keep their attachments
inline; `direct` leaves Observer available for manual delegation. Supported
pasted images saved under `.opencode/images/<session>/` remain until you remove
them. PDFs, remote-only images and tool-produced media are not automatically
saved by this relay.

### Disable lists

| Option | Effect |
|---|---|
| `disabled_agents` | Remove named specialists; default `["observer"]`. Orchestrator and bare Councillor are protected |
| `disabled_tools` | Skip Slim tool registration and implementation loading; native tools are unaffected |
| `disabled_hooks` | Stop the named interception/injection/observation hooks; see [Hooks](#hooks) |
| `disabled_commands` | Remove only the named Slim command; see [Slash Commands](#slash-commands) |
| `disabled_mcps` | Do not register the selected built-in MCP servers |
| `disabled_skills` | Do not register/grant selected bundled skills, even if a preset requests them |

Disabling Slim `webfetch` preserves the native tool. Disabling `acp_run` also
removes wrapper agents that cannot execute. Council is absent when unconfigured;
explicitly disabling `council` removes its seat chain too. Individual dynamic
`councillor-<seat>` agents can be disabled by exact name.

## Agent Settings and Presets

The same agent fields work under root `agents` and a preset. Put a value inside
presets when it should vary by lineup; root `agents` overrides every preset.

| Field | Meaning |
|---|---|
| `model` | Scalar `provider/model`, or a non-empty ordered chain of IDs / `{ id, variant }` entries |
| `variant` | Provider-specific variant; overrides the first chain entry's variant |
| `temperature` | Number 0–2; omission retains the host default |
| `options` | Provider-specific inference options |
| `inheritModelFrom` | `session` or `orchestrator`; follow the live model instead of a configured primary |
| `prompt` | Nonempty inline replacement; wins over a prompt file |
| `orchestratorPrompt` | Additional routing guidance for a non-Orchestrator specialist |
| `description` | Short description of when to delegate, shown in the native `subagent` roster |
| `displayName` | Unique user-facing alias, not a new canonical agent name |
| `color` | Six-digit hex or `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info` |
| `skills`, `skills_add`, `skills_remove`, `skills_include_local` | Native skill grants and inherited-list adjustments; see [Skills](skills.md#skills-assignment) |
| `mcps` | Plugin MCP selection (`*`, `!name`, explicit list); not a native agent property |
| `permission` | Ordered permission map or scalar action; see [Agent Permissions](#agent-permissions) |

### Preset inheritance

```jsonc
{
  "preset": "review",
  "presets": {
    "base": {
      "oracle": { "model": "provider/model-a" },
      "fixer": { "model": "provider/model-b" }
    },
    "review": {
      "extends": "base",
      "oracle": { "model": "provider/model-c" }
    }
  }
}
```

One parent is supported. Overlapping agent fields follow:

**ancestor preset < child preset < root `agents` < native host configuration**.

Inheritance cycles and missing parents are errors. New preset names use letters,
digits, `-` and `_`; reserved JavaScript properties and `__omo_*` are rejected.
Existing names outside that syntax remain selectable.

### Runtime Preset Switching

The configured `preset` selects startup agent settings. With session routing
enabled, `/preset <name>` applies resolved subagent inference settings to the
current session, not the global default. The TUI manager also offers **Global
default**, which writes configuration. Named session bindings survive restarts
and remain pinned until reapplied; default-bound roots refresh on admission.
See [Preset Switching](presets/preset-switching.md) for scope and failure rules.

`sessionPresetRouting: false` skips the binding store, session RPC and native
executor wrapper without disabling static presets or global editing. With
routing off, children use registered agent settings. `disabled_commands:
["preset"]` removes command/RPC/editor entry points but is not the internal
routing switch. Live refresh only updates inference fields, not prompts,
permissions, skills, MCPs or registration; those require a new host generation.

### Model references and inheritance

Qualified model references use `provider/model[#variant]`. The first slash
separates the provider. Further slashes and literal colons belong to the model
ID. For example, `openrouter/team/model:free#high` selects the
`team/model:free` model from `openrouter` with variant `high`. Use
`resolve_model` to check available references before adding them to a preset.

- `model: { "dynamic": "selected" }` asks OpenCode to use the current session
  model. It clears a configured agent model and its fallback chain, preserving
  an explicit nonempty agent variant. Scalar `"opencode_model"` and
  `"inherit"` are accepted as legacy spellings.
- A concrete scalar `model` wins over `inheritModelFrom` in the same effective override.
- Inheritance without a model clears a lower-layer model, including a host
  model. Both sources follow the live session/Orchestrator selection.
- An array plus inheritance follows the live model while retaining the array as
  its fallback chain. The followed model is not retried as a chain candidate.
- An inline chain-head variant belongs to that model and is cleared during
  inheritance; set an agent-level variant when it should apply regardless.
- Without either field, normal precedence applies; unconfigured Fixer retains
  its Explorer-model default.
- Do not put array + `inheritModelFrom: "session"` on Orchestrator itself: there
  is no separate model to follow, and it would clear its native selection.

Independent specialists move from their primary only after a confirmed parent
fallback abandons that provider. Request/content-policy failures and manual
selections do not cause that move. Each child otherwise uses its own chain;
see [Model fallback](#model-fallback).

### Agent Display Names

Aliases are normalized by trimming whitespace and an optional `@`. They must be
unique and cannot collide with canonical agent names. Mentions in the final
Orchestrator prompt and custom routing snippets use the configured display name;
TUI history, models and click targets stay keyed by canonical identity. Aliases
and colors are frozen until reload. Unconfigured colors use the host palette;
Councillor color overrides Council color for seats.

## Prompt Overriding

Create replacement or append files under
`<user-config>/oh-my-opencode-slim/` or
`<directory>/.opencode/oh-my-opencode-slim/`:

| File | Effect |
|---|---|
| `<agent>.md` | Default replacement when no inline `prompt` exists |
| `<agent>_append.md` | Append after whichever base prompt wins |

### Prompt Lookup Precedence

Replacement and append files are resolved **independently**:

1. Current project's `<preset>/<agent>.md`, then `<agent>.md`.
2. Repeat that order in each ancestor, nearest first.
3. Preset files in the user search directories, in [config lookup order](#config-files).
4. Root prompt files in the same user search order.

The corresponding `_append.md` uses the same search. A nearer root file beats a
farther preset-specific file. Only the first file of each kind is used; ancestor
append files are not concatenated. A preset without an inline prompt can share
a root prompt file across lineups. Project discovery obeys the trust/disable
rules in [Config Files](#config-files).

### Prompt Composition Rules

The base is **inline `prompt` > resolved file > agent default**. When inline and
file prompts coexist, Slim warns that inline wins. Append text follows that
base, separated by two newlines. File and append inputs can come from different
locations. Slim prepends its shared agent instructions to the resulting prompt.

For selective reuse, put `<!-- slim-prompt-template:v1 -->` on the first line of
a replacement or append input. References such as `{{slim.section.agents}}`
render the supported section in place. The available sections are
`intent_gate`, `agents`, `task_management`, `verification`, `orchestration`,
`delegation` and `result_synthesis`. Escape a reference with a leading
backslash to keep it literal. Unknown or malformed references in a marked
template fail load with the template source. Plain prompts keep their text.

When a primary declares `subagents`, the `agents` section uses the same
normalized allowlist as the projected permission. If an explicit delegation
permission takes precedence, the section is empty and OpenCode supplies the
effective roster through its native tool.

### Host Vocabulary in Custom Prompts

Use native `subagent`, `agent` and `sessionID` names in every supplied prompt:
inline strings, files, append files, custom/ACP routing and Council seat
guidance. Slim does not rewrite delegation vocabulary. Display-name substitution
is separate: it rewrites `@<internalName>` mentions in the final Orchestrator
prompt and routing snippets.

Put role-specific delegation criteria in the agent's `description`. OpenCode
includes it in the native `subagent` roster. Slim separately identifies hidden
Council seats, which are not in that roster.

### Custom Routing Guidance (`orchestratorPrompt`)

Non-Orchestrator agents can add routing guidance under a project-specific
section of the Orchestrator prompt. Use this for cross-agent policy rather than
repeating `description`. It is omitted for disabled agents. Start the guidance
with `@<agent-name>`; setting it on Orchestrator is rejected.

## Custom Agents

Unknown safe names under `agents` create specialists by default:

```jsonc
{
  "agents": {
    "reviewer": {
      "model": "provider/model",
      "prompt": "Review the named code; report evidence and risks, do not edit.",
      "description": "Use for focused code-risk reviews, not routine edits.",
      "permission": { "*": "deny", "read": "allow", "glob": "allow", "grep": "allow" }
    }
  }
}
```

Custom agents need a model or `inheritModelFrom` and cannot collide with built-in, ACP, display or
reserved Council-seat identities. Missing models are reported and skipped.
`librarian` remains a reserved alias for Explorer: explicit Explorer fields win;
use `explorer` in new configuration. Legacy generated MCP-pair repairs are
reported by `doctor`; customized permissions are not inferred or rewritten.

Set `primary: true` on a custom agent to make it selectable as a native primary.
Use `subagents: ["fixer", "@researcher"]` on the orchestrator or a custom primary
to scope its delegation. The entries accept registered names or configured
display aliases. Slim compiles the list to ordered native rules with a
wildcard deny followed by exact allows. An empty list denies all delegation.
A configured `permission.task` or `permission.subagent` takes precedence,
and native OpenCode user permissions still apply. Use native rules directly
for wildcard patterns or delegates registered outside Slim.

## Agent Permissions

`permission` accepts `"ask"`, `"allow"`, `"deny"`, or an object mapping actions
to those values or pattern maps. On V2, Slim maps `bash` to native `shell` and
`task` to native `subagent`; `execute` is the separate Code Mode dispatcher.
Allowing it does not grant its inner tools. Unknown/MCP action keys pass through.

**Key order is precedence: last matching rule wins.** Put the wildcard base
first and specific exceptions after it:

```jsonc
"permission": {
  "*": "deny",
  "read": "allow",
  "glob": "allow",
  "grep": "allow",
  "bash": { "*": "ask", "git status*": "allow" },
  "task": "deny"
}
```

Permission objects preserve authored order across layer merging. Later-layer
entries follow inherited entries. Unmentioned inherited rules at least as
restrictive as the later wildcard remain after it (`deny > ask > allow`); to
lift an inherited deny, name the action explicitly. Such inherited pattern
maps retain their order, with looser entries raised to the later wildcard's
restriction. Nested maps use the same rule against their own `*`; the base's
wildcard stays its fallback. This is not a blanket permission-widening merge.

`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`,
`lsp` and `skill` support patterns. `todowrite`, `question`, `webfetch`,
`websearch`, `codesearch` and `doom_loop` accept scalar actions only.
Subagents deny questions by default; explicit per-agent configuration can
change that. Parent task controls, package ceilings and native policy still
apply at their own execution seams.

### Merge semantics

1. Explicit `permission` supplies the base.
2. Resolved skill directives, explicit skill permission rules and local
   discoveries are merged in order. Explicit selections, removals and disabled
   skill IDs keep their configured effect. Automatic additions honor author
   rules.
3. MCP selections fill only missing `<mcp>_*` keys; explicit action entries win.
4. Native host rules and role/package capability ceilings can further restrict
   the resulting grants.

Use Skills/MCP arrays for those selections and permission rules for file,
shell, delegation and other actions. See [MCPs](mcps.md) and
[Marketplace](marketplace.md#customize-an-installed-agent) for their ceilings.

### Native Delegation Permissions

Set ordered `subagent` rules in **OpenCode's** `opencode.json[c]`. For example,
permit only `fixer` when the active agent is `orchestrator`:

```jsonc
{
  "agents": {
    "orchestrator": {
      "permissions": [
        { "action": "subagent", "resource": "*", "effect": "deny" },
        { "action": "subagent", "resource": "fixer", "effect": "allow" }
      ]
    }
  }
}
```

Use the exact registered IDs, including a configured visible alias where used.
To keep Council under a restrictive policy, allow its synthesis agent and the
configured `councillor-<seat>` IDs as well. OpenCode enforces the rules even for
hidden seats. Existing Slim `permission.task` maps still project to native rules.

### Local skills and skill policies

`skills_include_local: true` adds discovered native project skills and the
accepted supplemental skills from `resource_prefixes`. Native skills win
name collisions. Overlapping supplemental roots are searched nearest ancestor
first, then in prefix order. Hidden directories and hidden skill names are
skipped. An empty `resource_prefixes` list leaves native skill discovery to
OpenCode. See [Skills](skills.md) for command modes and resource layout.

In skill selection arrays, `*` allows all, `!name` denies a name, and `?name`
asks before use. Names may be patterns where the host permission language
supports them. `skills_add` and `skills_remove` adjust the inherited list. An
actual discovered or disabled skill ID must be literal and cannot contain
`*` or `?`. Exact decimal IDs from `0` through `4294967294` are rejected in
skill policy because JavaScript would reorder those keys and change the
decision. For example, `123*` is a valid rule pattern, and `01` is a valid
literal ID.

## Model fallback

| Setting | Default | Effect |
|---|---|---|
| `fallback.enabled` | `true` | Enable automatic model-chain intervention |
| `fallback.maxRetries` | `3` | Host retries tolerated before advancing the chain; `0` advances immediately |
| `fallback.retryDelayMs` | `500` | Delay placed on the host retry decision after a model switch; `0` disables that delay |

This is not native provider retry configuration or a wall-clock deadline. Slim
switches the model in place, leaving the host to retry the same turn. Request
rejections and spent allowance skip the retry budget; a host-announced wait
over 30 minutes bypasses it too. Authentication 401 gets one same-model retry
per turn before failover.

The chain is scanned from its head, excluding tried/request-rejected models and
providers abandoned by this session or its parent. Provider marks expire after
30 minutes; another provider-level switch refreshes the age. Independent children
keep their own chain. When no candidate remains, one last-entry retry may run;
otherwise the host decision is left unchanged. Spent-allowance providers do not
get that sticky retry. Short retry/per-minute wording is treated as a rate
limit, not permanent allowance exhaustion; free-tier billing errors remain
permanent billing errors.

The retry budget remains spent across model switches and new user turns. A
successful `stop`, `tool-calls` or `length` step, successful execution, session
deletion, or fresh descent from the configured primary re-arms it. Returning
through a fallback restore or landing on an exhausted primary is not itself
fresh recovery. Request-rejected models stay excluded until the next external
prompt even if other recovery resets occur.

OpenCode ends content-filter steps without a retry-hook call. Slim uses the
failed-step evidence to switch and continue that same session. The host reports
child periods; Slim adds no second completion notifier. A late model switch is
reconciled only if the observed selection is still its source or target; a
newer user-selected model is untouched.

`fallback.enabled: false` stops intervention but retains retry bookkeeping for
live/session-applied configuration. `disabled_hooks: ["foreground-fallback"]`
is the cold disable and removes the manager/hook entirely. Explicit retired
`continuationPolicy` or `initialRetryDelayMs` keys refuse startup with their
source path, even when the hook/task controls are off. Failed live refresh keeps
the last valid profiles. Remove the keys; see [Upgrading](installation.md#upgrading).

## Background Job Management

`backgroundJobs.mode` selects Slim's admission and task tools. OpenCode owns
spawn, continuation, steering, completion delivery and restart recovery. The
queue gates native calls with parent-scoped dependencies and directory-wide
admission limits. See [Background Orchestration](background-orchestration.md)
for queue controls, retained listing and native lifecycle behavior.

## Hooks

| `disabled_hooks` value | What is stopped |
|---|---|
| `phase-reminder` | Fixed-anchor workflow reminder on the first eligible Orchestrator message |
| `council-inject` | First-keyword Council procedure injection; seat assembly remains active |
| `deepwork-goal` | Disk progress-pointer reminder, once per compaction epoch |
| `foreground-fallback` | Model-chain manager and retry intervention |
| `chat-headers` | Slim Copilot internal-initiator HTTP header |
| `cache-monitor` | Observation-only prompt-cache warnings |
| `tool-loop-guard` | Repeated-call warning/blocking |
| `search-path-guard` | Search path preflight |
| `absolute-path-rescue` | Unambiguous recovery of guessed absolute paths |
| `apply-patch` | Native patch input validation/recovery |

Guards are optional protections: disabling them exposes raw host behavior.
Dedicated subsystem switches are not hook names. Unknown hook/command names
are stripped with warnings; a list consisting only of unknown names is treated
as unset so a lower layer's list still applies.

## Slash Commands

`disabled_commands` accepts `interview`, `implement`, `deepwork`, `reflect`,
`preset`, `killall`, `subagent` and `queue`. A disabled command is neither registered nor
intercepted, leaving a same-named user command alone. Disabling the `reflect`
skill also disables its command; disabling `deepwork` skill alone does not
remove its self-contained command.

`killall`, `subagent` and `queue` are TUI commands. `tui: false` removes the entire Slim
TUI surface; granular command disables leave other TUI features active. See
[Skills](skills.md) for workflow commands and [Preset Switching](presets/preset-switching.md)
for `/preset`.

### Generated skill commands

Set `skillCommandMode` to `"full"` to inline skill content, `"reference"` to
direct the agent to load the exact skill by ID, or `"none"` to omit generic
skill commands. A skill can override the global choice with `slim.command`
in its `SKILL.md` frontmatter. Explicit commands and skill availability are
independent of this setting. See [Skill Slash Commands](skills.md#skill-slash-commands).

## Feature Guides

| Feature | Authoritative details |
|---|---|
| Council lineup, synthesis and failures | [Council](council.md) |
| Skills and inherited-list adjustments | [Skills](skills.md) |
| Built-in MCP selection | [MCPs](mcps.md) |
| ACP process configuration and inner models | [ACP Agents](acp-agents.md) |
| Interview server/dashboard and questions | [Interview](interview.md) |
| Marketplace activation and package restrictions | [Marketplace](marketplace.md) |
| TUI panes, layouts and deployment modes | [Multiplexer Integration](multiplexer-integration.md) |
| Companion appearance, binary and compositor rules | [Companion](companion.md) |
| Enhanced fetch and extraction | [Webfetch](webfetch.md) |
| Native integration and verification | [OpenCode 2 adapter](../src/v2/codemap.md) |

## Invalid or Retired Settings

The option tables above contain active settings only. `doctor` reports retired
keys and unsupported host limits with their source paths. Positive legacy
wall-clock watchdog limits refuse startup. The legacy `managed` mode retains
admission settings and runs child sessions through OpenCode's native Jobs.
See [Upgrading](installation.md#upgrading) for retired board, alias,
reusable-session and periodic wake settings.
