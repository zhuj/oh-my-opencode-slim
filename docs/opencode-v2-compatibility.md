# OpenCode v2 (`opencode2`) Compatibility

oh-my-opencode-slim installs and runs on **both** OpenCode v1 (`opencode`)
and OpenCode v2 (`opencode2`) from a single published package. This document
describes how each host loads the plugin, what is supported where, and how to
register it.

The repository baseline is **oh-my-opencode-slim v3.0.6** (see `package.json`). Earlier adapter notes recorded live host verification on **OpenCode v2.0.7**; that remains historical evidence, not a runtime check of the current release. The v2 type mirror is pinned to `@opencode/plugin` 2.1.2 and is compile-time coverage, not live 2.1.2 verification. The plugin requires OpenCode v2.0.7+ on v2 hosts; older v2 hosts are unsupported.
Bundled-skill delivery requires the host's in-process skill registration
channel (a `ctx.skill` draft with `add`), available on OpenCode v2 hosts. On
v1 hosts bundled skills are **not** registered in the native skill inventory:
the legacy disk-copy sync was removed, and v1-era skill drafts expose
`{source, list}` rather than `add`. The separate legacy bundled slash commands
deliver body templates by default (`skillCommandMode: "full"`); the modes only
control plugin-bundled commands on V1, not native non-bundled skill conversion.
`/deepwork` retains its self-contained workflow.
The adapter targets the v2 plugin API surface (see
[The v2 plugin API surface](#the-v2-plugin-api-surface-this-adapter-uses)),
and the compile-time mirror guard below is pinned to `@opencode/plugin`
2.1.2. Typecheck covers the consumed listing filters, nullable continuation
cursors, native execution event envelope, compaction result names and the
existing hook/permission contracts. This is not live 2.1.2 verification.

The 2.1 replay renames do not require rewriting host-owned data here: the
compaction bridge leaves `result.native` and `metadata.keepID` untouched.
OMO does not use the removed credential-configuration write shape in its
adapter. The list shim implements only the directory/parent filters its
callers consume, not every filter exposed by the host API.

## Shell and MCP permission compatibility

The v2 permission adapter maps legacy `bash` declarations to `shell`
(and retains the `bash` spelling), including command-pattern rules. It does
not map them to `execute`: on OpenCode v2, `execute` is the CodeMode
JavaScript dispatcher, not the shell tool. Configure `execute` separately
when a role needs CodeMode tools. A wildcard deny still requires an explicit
`execute` grant; allowing the dispatcher does not grant the individual MCP
or shell actions it invokes. v1 SDK permission maps keep their original keys.

For example, an agent may deny `bash`, allow `execute`, deny `research_*`,
and allow only `research_lookup`. The child permission compiler preserves
that explicitly named MCP exception when reapplying the namespace deny,
while keeping other namespace actions denied. Replayed exceptions are bounded
by the final declared policy: an earlier allowance overridden by a later
resource denial is not restored, and partial allowances retain their narrower
restrictions. A stricter host deny or ask
for the action (including narrower resources) still wins. Overlapping
wildcard-action grants remain conservatively bounded; this is not a general
permission-widening rule. These mappings are source-checked against OpenCode
v2.0.18 and v2.0.32; they do not represent a new live-host certification.

## How it works

The package's default export is an object:

```ts
export default {
  id: 'oh-my-opencode-slim',
  server: OhMyOpenCodeLite, // v1 plugin function (PluginInput) => Promise<Hooks>
  setup: createV2Setup(),   // v2 promise-plugin setup (ctx) => Promise<cleanup>
};
```

There is deliberately **no `tui` key** on this export: hosts validate a
server plugin module's `tui` field (it must be a function and must not
coexist with `server`), so a boolean `tui: true` marker gets the whole
plugin rejected with "invalid tui export".

- **v1 loader** (`readV1Plugin` in `packages/opencode/src/plugin/shared.ts`)
  detects an object with a `server` field and calls `plugin.server(input)`
  with the full v1 `PluginInput`. Extra keys (such as `setup`) are ignored on
  this path.
- **Embedded v2 pass on v1 hosts.** Every v1 host (≥ v1.17.10) also boots
  the v2 core, which reads the same config (migrating `plugin:` entries to
  `plugins:`) and calls `setup(ctx)` with a registration-only context
  (agent/aisdk/catalog/command/integration/plugin/reference/skill — no
  tool/session/event/mcp/generate). A dual-export plugin registered via the
  v1 `plugin:` key therefore gets **both** invocations: full v1
  functionality flows through `server()`, while the parallel pass produces
  the expected `[v2] … failed` / `bridges: 4` log noise (see
  [Environment caveats](#environment-caveats)). A v2 `plugins:` entry yields
  the setup pass alone — v1 does not convert v2 plugin declarations into v1
  hooks.
- **v2 loader** (`PluginModule` schema in
  `packages/core/src/plugin/supervisor.ts`) decodes `default` as
  `{ id, setup }` (Effect Schema 4 rejects function defaults) and calls
  `setup(ctx)` via the promise-plugin bridge.
- **v2 TUI** loads the `./tui` entry unconditionally: the TUI runtime runs
  its own `kind: "tui"` loader pass over the same plugin list and resolves
  the entry through the package's `exports["./tui"]` map — the server-side
  export plays no role in that discovery.

The runtime entries and public marketplace contract are built separately:

| Export | File | Build | Externals |
|---|---|---|---|
| `.` (main) | `dist/index.js` | `build:plugin` | zod, jsdom, jsonc-parser, solid-js, @opencode-ai/*, @opentui/* (shared with v1 host) |
| `./server` | `dist/server/index.js` | `build:v2` | jsdom and jsonc-parser (otherwise self-contained for v2) |
| `./tui` | `dist/tui2.js` | `build:tui` | same external set as `build:plugin` (composes the v1 TUI entry; inlines zod) |
| `./marketplace-contract` | `dist/marketplace-contract/index.js` | `build:marketplace-contract` | zod and semver |

The optional `@opentui/*` pins (0.5.11) provide the v2 TUI entry's rendering
stack. The development-only `@opencode/plugin` 2.1.2 contract declares an
optional OpenTUI peer floor of `>=0.6.6`. Runtime pins stay unchanged in
this patch; TUI runtime compatibility with 2.1.2 is unverified. `@opentui/solid` pins
`solid-js` exactly (0.5.12 still requires 1.9.12), so any future OpenTUI
bump must re-check that pin.

v2's plugin resolver tries the `server` subpath first
(`subpaths: ["server", ""]`), which the exports map resolves directly to
`dist/server/index.js` — the self-contained v2 server bundle, and the
artifact the release check requires. Local source development registers an
external shim directory instead of pointing at `dist/` (see
[Local source development](#local-source-development-no-publishing)); v1
uses the main entry.

Upstream npm naming split with the stable line: v2 ships as
`@opencode/plugin` / `@opencode/client` / `@opencode/sdk` / `@opencode/cli`
(at `2.0.x`), while `@opencode-ai/plugin` and `@opencode-ai/sdk` are V1-only
packages that will never carry the v2 surface. The plugin
intentionally keeps its v1 runtime pins and hand-mirrors the subset of the v2
plugin context it consumes in `src/v2/types.ts` — the v1 host must be able to
load the main build with no v2 package installed. This is a known tradeoff,
not an oversight: the mirror is refreshed by hand and can drift from
upstream, so every v2 release bump needs a deliberate diff of
`src/v2/types.ts` against the new `@opencode/plugin`. That diff is
backed by a compile-time tripwire: `src/v2/mirror-conformance.ts` — typechecked
against the `@opencode/plugin` devDependency, pinned to the audited
version — fails `bun run typecheck` when either the mirror or the
pinned official surface drifts (hook-name sets, key payload fields).
The guard file must stay non-test-suffixed: tsconfig excludes
test-suffixed files from tsc, so a `.test.ts` guard silently checks
nothing.

Verified live on OpenCode v2 (all bridges green — health check
`bridges:11`, +1 on hosts that accept the `session.model.request` hook
name for the chat.headers bridge; the event stream and bridges are exercised end-to-end on the stable host;
since the council 2026-10-23 removal the plugin creates no wake scheduler on
v2 — terminal delivery is the host's native background notifier). v2 conformance is compile-time-pinned by the
mirror-conformance guard against the `@opencode/plugin` 2.1.2
devDependency and exercised by the mock-driven bridge tests. Every optional v2
API the adapter touches is capability-probed at runtime (`s.switchModel`,
`s.wait`, `s.list`, `s.remove`, …), so a host lacking an optional capability
degrades that single feature with a log line instead of breaking the load. The configured MCP namespace inventory is a
required input to finalized-registry permission policy: a host without
`ctx.mcp.transform` is unsupported and setup fails with an actionable error.
The session hooks are the deliberate exception: on full contexts they
register unconditionally and a
registration failure fails setup (see
[The v2 adapter](#the-v2-adapter-srcv2setupts)).
`ctx.mcp.transform` is present in **all** v2.0.x stable hosts. Its inventory
snapshot is required to preserve host-only MCP namespace policy; missing it is
not an optional-degradation path.

## The v2 adapter (`src/v2/setup.ts`)

### Cancellation contract limitation

The installed v1 `ToolContext` exposes `abort: AbortSignal`; the installed
`@opencode/plugin@2.0.18` promise `ToolContext` exposes `signal: AbortSignal`
and calls `execute(input, context)`. `adaptTool` forwards the explicit third
argument first, then `context.signal`, then the legacy `context.abort`, with an
inert signal only when none is available. The third argument remains a
per-invocation integration seam and override, **not a claimed v2 Context
field**. This promise-tool contract does not imply that every v2 Effect or host
Context shape exposes a signal.

The locally inspected upstream `packages/core/src/tool/tool.ts` defines an
Effect-based v2 `Context` with session, agent, assistant-message and tool-call
IDs, but no `AbortSignal`; that is a separate context shape from the installed
promise `ToolContext`. The declaration establishes the promise interface, but
the native host runtime was not executed, so end-to-end host cancellation is
not established. Queued admission has the corresponding explicit
`handleToolExecuteBefore` dependency `signal`; current host hooks do not supply
it. Cancellation releases only that call's unbound admission, never its running
prerequisites. Cancelling `task_wait` only unsubscribes the waiter.

In-process dependency fixtures exercise the v1 before-hook ordering from
upstream `packages/opencode/src/session/tools.ts` and the v2 adapter's unknown
input boundary, then strict native validation after extension stripping. They
do **not** prove extension survival through every v2 host schema decoder; the
available Effect-based source differs from this promise-adapter contract.

`setup(ctx)` wraps the existing v1 factory rather than reimplementing it:

1. Builds a v1-shaped `PluginInput` from the v2 context
   (`src/v2/client-shim.ts`): the project directory from `ctx.location`,
   and a shim `client` that **really delegates** the v1 SDK call shapes to
   v2 flat session calls — `session.get`, `session.abort`→`interrupt`
   (`resume: false` aborts the active run), `session.messages`→`context`
   (mapped entries preserve the v2 terminal metadata — `time.completed`,
   `finish`, `error` — and the 2.0.8 trailing `idle` lifecycle marker maps
   to the skippable v1 `system` role, so transcript classification works
   natively on v2). After completed compaction, terminal-evidence reads
   restore persisted history through paginated `session.messages` when
   available, stopping once the pre-revive baseline or queued prompt is
   found. This preserves child completion identity without reading older
   history unnecessarily. Recovery scans stop after 10 pages of 100 messages
   or four seconds total; exhausting either budget leaves completion
   unconfirmed rather than trusting a partial result. Bounded tail reads
   still fetch only the requested page;
   ordinary context reads and parent-alias recovery remain unchanged.
   Hosts without persisted-message reads retain incomplete context and do
   not bypass missing-baseline checks. `session.prompt` (default `delivery: "steer"`;
   `noReply: true` maps to `delivery: "queue", resume: false` — or `delivery: "steer", resume: false` when the v1-shaped body carries an explicit `delivery: 'steer'` from `task_message`),
   `session.update`→
   `session.update` (`{sessionID, title}`), `session.delete`→`remove` (same
   `DELETE /api/session/:id`), and `session.list` (v2 `Session.Info` page → the v1
   `{data}` envelope with `directory` derived from `location` and `outcome`
   mapped, used by the interview dashboard's session scan and the
    orchestrator-wake children enumeration). OpenCode 2.1 exposes `list`:
    the shim drains its cursor pages, sends root-only filters as real `null`,
    and refuses incomplete enumeration after 1000 sessions or four seconds.
    The final empty page is included in the read budget. Older cursorless
    extensions still work; v2.0.x hosts without `list` retain the degraded
    path. These adapter checks do not establish live 2.1 compatibility (see
   [Not exposed to plugins: `session.list` / `session.remove`](#not-exposed-to-plugins-sessionlist-sessionremove)).
   The shim marks the input `hostFlavor: 'v2'` and never fakes success
   shapes: methods the host lacks degrade with an honest log (or are
   omitted entirely, as with `session.get`, so capability probes see the
   truth).
2. Invokes `OhMyOpenCodeLite(pluginInput)` to reuse **all** existing build
   logic (config, agents, tools, hooks, job board, multiplexer, companion).
3. Runs the v1 `config()` hook against a synthesized config to resolve agent
   models and the slash commands.
4. Bridges the returned v1 `Hooks` into v2 registrations:
   - `agent` → `ctx.agent.transform` (model/prompt/permission adaptation +
     `subagent`/`shell` permission mapping + `draft.default("orchestrator")`).
     On v2 hosts the generated orchestrator/council prompts use
     native wording (`subagent` tool, `agent` param). No delegation-vocabulary
     rewriting is applied: every user-supplied prompt must be written in the
     host's own vocabulary directly — inline `prompt`, `<agent>.md`/append files,
     `orchestratorPrompt` snippets, custom and ACP agent prompts, and council
     councillor prompts. Separately, display-name substitution rewrites
     `@<internalName>` mentions to the agent's `displayName` throughout the
     final orchestrator prompt (inline, file, and append orchestrator prompts)
     and in `orchestratorPrompt`/ACP routing snippets. The adapter also
     **removes OpenCode's built-in `general`/`explore` subagents** at
     registration time, before the native agent snapshot, so slim's agents
     are the only delegation targets; a host config entry declaring either
     name under `agents` (v2) or `agent` (legacy) opts that agent out of
     removal — unless the entry itself requests disabling
     (`disable`/`disabled: true`), which keeps the built-in removed.
    - `tool` → `ctx.tool.transform` (zod shape → JSON schema; execute
      shimmed; every registration carries `options: {codemode: false}` —
      see the feature matrix note below)
   - `mcp` → `ctx.mcp.transform` (`draft.set(name, adaptMcpServer(cfg))` for
     the built-in MCPs)
   - `command` → `ctx.command.transform` — v2 command drafts are add-only:
     `draft.add({name, description, execute})`. `execute` submits a
     `<omos-cmd-command data-name="...">` marker as a user prompt; the
     session context hook recovers it and dispatches to the v1
     `command.execute.before` hook (deepwork/reflect/loop)
   - Registered skills use a separate `skill-commands.ts` executor bridge,
     not the marker/template adapter. Its lifecycle controller reads
     `{location, data}` from `ctx.skill.list()` after event consumption starts
     and on matching `skill.updated` / `plugin.updated` events. It disposes its
     own transform before reading fresh collisions from `ctx.command.list()`.
     Serial, coalesced refreshes include later activation and skill reloads;
     teardown stops pending work and disposes any in-flight registration.
     `command.updated` is ignored to avoid self-triggered loops; command-only
     reloads of earlier transforms can hide new explicit collisions until the
     next skill/plugin event. All inventoried skills use the effective mode:
     a valid `SKILL.md` frontmatter `slim.command` override, otherwise the
     startup `skillCommandMode` setting (default `full`). Missing or invalid
     overrides inherit the global mode; `full` or `reference` can opt in even
     when the global mode is `none`. `full` keeps the unchanged inline
     `<skill-instruction>` template with its base-directory hint; `reference`
     instead instructs the model to load and follow the exact skill ID with
     the `skill` tool, with no inline body. Both wrap the original arguments in
     `<user-request>` and preserve attachments without `prompt.skills`
     additions. `full` delivers the body without the native skill-tool gate;
     `reference` depends on model-mediated loading and normal tool permissions,
     not a guaranteed tool call or a bypass of denials. `none` omits only the
     generic command, leaving skill availability and explicit/user/workflow
     commands unchanged. The modes do not change `disabled_skills` or
     permissions. Reload the plugin to change the global mode. A generated-name
     registry feeds the shared missing-command reply,
     which fires in the v1 `command.execute.before` hook for names owned by
     neither the merged config nor a generated skill command; on v2 that hook
     receives only the plugin's reserved names from `prepareCommands`, so a
     host-native v2 command typed as plain text can be reported as missing.
     The mirrored Skill.Info follows supported 2.0.15-2.0.19 hosts: `path` is
     the skill directory. Slim also registers bundled skills with the SKILL.md
     file path, so the bridge derives the base directory with `dirname` when
     the reported path ends in `.md`. Per-skill command metadata is resolved
     on skill/plugin inventory refreshes, accepting either a `SKILL.md` path
     or a directory. Unreadable/pathless skills use inline metadata when
     available, otherwise the global mode; they are not excluded solely for
     lacking a readable path. The host path contract was verified against
     live-version source tag 2.0.19
     (`1fd016ef32286de9489b7b24f1029f52c49a27b3`) and the installed 2.0.15
     development package. `skill-command-conformance.ts` checks the complete
     registration shape (ignoring only nominal string brands), inventory
     envelopes, and invocation contracts. Newer unreleased source `dbd9b18`
     changes this to a `location` file path; that contract is not supported by
     project skill registration here and requires a deliberate adapter update,
     not speculative fields sent to the supported host.
    - a single `ctx.session.hook("context")` handles the system/messages
      transforms (SystemPart[]/Message.content shape conversion),
      `chat.message` agent tracking, and interview + generic command marker
      dispatch — keeping earlier prompt content stable for provider cache
      prefix reuse. After the
      bridged transform, if plugin-tagged parts exist, the v2 bridge copies
      the last part of the last non-board-only message and gives it one
      `ContentPart.cache` `{type: "ephemeral"}` hint. The shared injection
      helper adds no hints; the v1 pipeline remains unchanged.
    - a native `ctx.session.hook("prompt")` registration (capability-
      guarded): the v2 prompt hook fires **once per admitted input** with
      the eventual inbox User `messageID`, giving the v1 `chat.message`
      consumers (task-session-manager / orchestrator-wake
      `observeChatMessage`, `toolLoopGuard.observeNewUserMessage`) true
      once-per-admission fidelity with prompt parts. The FIRST admitted
      prompt per session is deferred until the first agent-bearing
      context event arrives, then delivered once with parts + agent
      together — the v1 `chat.message` handler only registers the session
      agent when a delivery carries one, and its consumers gate on that
      registration, so an agent-less first forward would be dropped (lost
      input-wait latch clearing / wake-progress rearm). Bounded fallbacks
      (next admission, or a context event whose trailing user message has
      moved past the pending one) flush a still-pending prompt best-known
      when no agent is ever learned. When the prompt hook registers, the
      context hook's per-request `chat.message` emulation narrows to
      agent/model discovery; hosts that reject the hook name keep the
      full emulation as fallback. The session-frozen profile bridge is also
      awaited from this hook BEFORE the admission's first model request: it
      resolves the session's identity and model through `session.get`,
      then freezes the child's runtime profile. It applies `session.switchModel`
      only while the child still uses the agent's startup-registered model;
      a different explicit or routed model retains its variant without a switch.
      Hot refresh compares against that startup model, not the refreshed profile.
      Capture remains idempotent (the event-stream
      `session.created` consumer is only a prewarm/cleanup path — a first
      child request can never race the asynchronous event pump).
    - a native `ctx.session.hook("model.request")` registration
      (capability-guarded): the v2 equivalent of the v1 `chat.headers` hook.
      Fires once per provider request with a mutable `headers` record the
      host merges into the outgoing HTTP request. The bridge replays the v1
      Copilot initiator-header semantics: for `github-copilot` /
      `github-copilot-enterprise` primary requests whose trailing user
      message is an internal-initiator admission (orchestrator-wake queue
      prompts), it sets `x-initiator: agent`
      so Copilot's backend does not account plugin-driven turns as user
      activity. The internal marker is learned in-band — prompt `metadata`
      persisted onto the transcript user message (visible on the
      context-event envelope) plus an admission tracker for
      `session.synthetic` wakes (synthetic admissions skip the prompt hook
      and the host drops their metadata from the LLM envelope, so the shim
      records a client-chosen `msg_`-prefixed admission id the host
      honors). Auxiliary kinds (compaction/title/generate) are skipped —
      v2's built-in Copilot provider hook already marks those, and the
      native fetch layer only escalates a pre-set `x-initiator: agent`
      (never resets it to `user`), so the bridge composes with the
      built-in. Known deviation: v1 also treats compaction-continuation
      turns (`compaction_continue` part metadata) as internal; v2 core has
      no such key and the bridge checks only the plugin metadata key, so a
      primary continuation turn following compaction of an
      internal-initiated session goes unmarked (false-negative only — a
      narrow window that can only under-mark, never over-mark). Headers
      are transport-level; no payload content is read or mutated. Hosts
      that reject the hook name keep the pre-bridge behavior (header
      simply unset) with a one-time log.
    - `tool.execute.before/after` → `ctx.tool.hook` via
      `createToolExecuteBridges` (`src/v2/setup.ts`): the host `subagent`
      tool is normalized to v1 `task` semantics (name mapping, `agent`→
      `subagent_type`, `sessionID`→`task_id`, and back after the hook so
      v2 executes the repaired input). The execute bridge removes empty
      resume values (`undefined`, `null`, and new-session placeholders) before
      native validation, while a real string resume ID is preserved. Native
      Effect fields and constraints remain host-owned: inserting a field AST
      created by the plugin's separate Effect copy mixes incompatible parser
      sentinels and breaks omitted-key decoding. Metadata rewrites use the
      host schema's own methods instead. A throwing `execute.before`
      **rethrows** — v2 rejects the tool call, which is how the v1
      anti-duplicate / relaunch-lease guards enforce on v2. The after
      bridge honors v2's status discrimination: `error` events synthesize
      the v1 after-hook output from the error text (so json-error-recovery
      still appends its reminder to a failed call's output), and an
      errored call never presents its result content as a success.
   - `event` → `ctx.event.subscribe()` loop feeding `mapV2EventToV1`
      (`src/v2/event-adapter.ts`): additive synthesis only — the raw v2 event
      is always dispatched first (the interview bridge depends on it), then
      synthesized v1 shapes: flat child `session.created` → v1
      early-registration `{info: {id, parentID, agent?}}`, flat
      `session.deleted` → the v1 deletion-cleanup shape carrying **both**
      id spellings the v1 consumers read (`properties.info.id` for the
      cache monitor's session eviction, `properties.sessionID` for the
      task-session-manager's tombstone/board teardown; no `generation` is
      fabricated, so the event-router's unproven-relaunch deletion fence
      keeps its strength), usage telemetry
      (`session.usage.updated`/`session.step.ended`) → a deduplicated
      completed-assistant `message.updated` for the cache monitor, the Form
      flow (`form.created`/`form.replied`/`form.cancelled`) → v1
      `question.asked`/`question.replied`/`question.rejected`
      (`form.id` → the question request id; forms owned by the `"global"`
      sentinel are skipped), and `permission.asked` field mapping to the v1
       names (`permission` ← `action`, `patterns` ← `resources`;
       `permission.replied` keeps raw-first delivery and additionally
       normalizes the native `data` payload into `properties`
       `{sessionID, requestID, reply}` so the v1 consumers can clear the
       wait). V2 hosts publish durable `session.execution.started/
      succeeded/failed/interrupted` and emit no busy/idle `session.status`
      and no `session.idle` on the event stream — the observed payloads
      always ride under `data` (verified live, 80-event capture). The
      adapter synthesizes the v1 lifecycle shapes from those execution
      events (`started` → busy `session.status`; terminal subtypes → idle
      `session.status` + `session.idle`; `failed` → a v1 `session.error`
      with the host error payload before the idle pair), and no
      `session.status`-based fallback remains. The execution-event
      synthesis keeps orchestrator-wake suppression/arm scheduling.
      Automatic foreground fallback remains disabled on v2: the host has no
      atomic turn-conditional
      model switch, so a switch started for a failed turn could commit after a
      newer user turn takes over. The Form and permission bridges above feed
      the companion's waiting-input
      indicator and the task-session-manager input-wait gate. Form questions
      are observation-only for plugin code on the pinned v2 host: the promise
      plugin context exposes `permission.reply`, but not a supported
      `form.reply`/`question.reply` API, so `task_reply` can answer v2
      permissions and must honestly reject v2 form-question replies.
   - `dispose` → returned cleanup

Agent/tool/command domain-transform bridges are independently
try/catch-guarded so one failure cannot disable the rest, and a
zero-registration load logs a loud health-check warning. MCP setup is
different: it first snapshots the configured host namespace inventory from
`ctx.mcp.transform`, which is required for finalized-registry permission
policy. A missing transform or unavailable inventory fails setup and
unwinds registrations already acquired. The session hooks
(`prompt`, `context`, `model.request`, `compaction`) register
**unconditionally** on full v2 contexts: a registration failure fails
setup loudly instead of degrading — hook-name rejection is treated as a
host contract violation, not a degrade path. Separately, `session.update`
remains optional for PR7's child permission bridge: without it, only that
child bridge degrades with a one-time warning.

### Task-control prompt and idle-wait contracts

The v1-facing `session.prompt` shim preserves text and file attachments. A
`noReply: true` task message is a real, non-synthetic prompt with `queue` +
`resume: false`; `task_message` exposes no delivery/steer parameter.
Queue alone would not preserve the no-resume intent. Unsupported per-call
model/variant overrides and agent changes are rejected before writing, never
silently dropped or implemented by non-atomic `switchAgent`/`switchModel` calls.
A named owning agent is an identity assertion: the shim verifies it matches
`session.get().agent` before admitting the prompt. Missing, mismatched, or
unreadable identity fails closed without a write or selection switch. `task_message`
explicitly inherits persisted selection on v2; other noReply callers, including
interview notifications, retain the same no-resume semantics.

After the asynchronous identity read, `task_message` revalidates its existing
disposal, message lease, running generation, and owning-agent conditions at the
shim's synchronous pre-admission boundary. The local `beforeSend` guard is not
forwarded to the host and cannot switch selection; invalidation during the read
therefore rejects without queuing a message.

`experimental_v2.waitForSessionIdle(sessionID)` exists only when the host provides
`session.wait({sessionID})`. It delegates that method; it fabricates neither a
status map nor board state.
`session.status` remains absent. Historical `session.get` outcomes cannot authorize
revive. The official 2.0.5 prompt intent fields and wait signature are pinned in
`mirror-conformance.ts`, and tool→shim→host contracts have dedicated tests.
The 2.0.5 promise adapter does not forward AbortSignal to these methods, so the
bounded idle wait does not pretend to cancel the host operation: late settlement
is observed without authorizing a prompt. It waits for idle within its budget,
not for an atomic reservation; queued delivery can still follow an external resume.

The terminal gate alone attributes `session.get` outcomes, in both v1 and v2.
Only integrations explicitly declaring `hostOutcomeClock: 'shared-unix-ms'`
(the local in-process wiring) may use them. Other factories default to distrust.
Finite nonnegative timestamps must satisfy `max(generation start, attempt start,
latest live activity) < time.idle <= read completion`; equality is ambiguous.
Attempt boundaries survive handoff promotion and late ACKs. An unattributable
outcome cannot establish or preserve host-outcome quiescence; it leaves the run
uncertain, not stopped. Fresh `succeeded` still requires valid post-baseline result
evidence — except on hosts that expose no transcript source at all (no callable
`session.messages`), where a window-attributed `succeeded` publishes `completed`
from the host outcome alone (attribution `host-outcome`): capability absence is a
dead end, never a pending transcript, and a host whose transcript is present but
unfinalized keeps waiting exactly as on v1. Independent runtime maps, native
returns and cancellation keep their fences.

Known limitation (documented dead end): a host outcome that becomes
attributable only after the gate's evidence retry budget is exhausted (initial
read plus 3 retries at `stopConfirmationMs` cadence, with no further events
arriving) strands the board entry at `running` until the parent's next
activity rehydrate reconciles it. The parked probe test in
`src/terminal-gate.integration.test.ts` (`probe: late-attributable outcome
after exhaustion terminalizes the stranded board`, `test.skip`) records the
mechanism: neither a later idle pair nor a busy→idle contrast cycle re-arms
an outcome read. Note `stopConfirmationMs` doubles as the retry cadence —
raising it stretches the stranding window proportionally (~4× its value at
the default budget).

The first complete native agent snapshot finalizes the managed registry for
the current plugin generation. Subsequent v1 `config()` calls and v2 agent
transform replays reproject that same owned model and permission policy; they
do not absorb later changes to managed host entries or native rules. Foreign
host-owned entries remain outside the managed projection. To apply changed
managed configuration, restart or reload OpenCode from the host so a fresh
generation can capture a new snapshot. This is a generation boundary, not hot
configuration. Marketplace status reports desired-versus-live state, and an
explicit reload request returns this host action as an instruction; the plugin
does not expose a supported full-host reload API, create a generation, or
mutate an active registry. When no finalized registry is available (for example,
in standalone CLI use), status reports `reloadRequired: null` because the live
side cannot be observed.

## Feature matrix

| Capability | v1 (`opencode`) | v2 (`opencode2`) | Notes |
|---|---|---|---|
| `routingBlock` (drop `<Agents>` from the built orchestrator prompt) | ✅ removes the block | ✅ removes the block | The host's native delegation-tool roster keeps agent identity; the block's Delegate/Don't routing criteria have no roster equivalent — see [Upstream behaviors to know](#upstream-behaviors-to-know) |
| Orchestrator + specialist agents, prompts & permission mapping | ✅ | ✅ `ctx.agent.transform` | — |
| Delegation + background job board + `task_*` tools | ✅ native `task` tool | ✅ native host `subagent` (auto-bridged: name/args normalization in `src/v2/delegation.ts`, output parsing in execute bridges) | On v2 `sessionID` is the primary resume parameter; `task_id` is accepted only as a deprecated alias. `task_revive` and `wait_for_user` are v1-only; v2 continues retained sessions through `subagent(sessionID, prompt)` and uses native `question` for blocking input. Prompt text uses host vocabulary directly; display-name substitution separately rewrites internal mentions in final prompts. |
| Tools (ast-grep, webfetch, task status/list, queue and dependency controls, wait, message/reply/cancel, acp_run) | ✅ | ✅ `ctx.tool.transform` | v2 tools require `options: {codemode: false}` or they register only inside the `execute` tool runtime. `task_status` supports `result: true` and read-only diagnostics; `task_message` queues without waking or steering on v2. Queue tools use the shared admission runtime. ast-grep needs its CLI binary; webfetch needs `jsdom` resolvable. |
| Slash commands `/deepwork` `/reflect` `/loop` | ✅ | ✅ marker round-trip | — |
| Registered skill commands `/<skill-id>` | `skillCommandMode` applies to plugin-bundled templates; native non-bundled discovery and conversion remain host-owned | Event-driven inventory bridge; `full` inline delivery by default | Root `skillCommandMode` and per-skill `slim.command` support `none`, `full`, and model-mediated `reference`; inventory/prompt APIs are required, and a command-only reload can delay explicit-command precedence (see [Skills](skills.md#skill-slash-commands)) |
| `/interview` | ✅ | ✅ marker command + trailing-message context bridge | — |
| Message transforms (phase reminder, image routing, display-name rewrite) | ✅ | ✅ via the single context hook | Available-skill filtering remains host-owned; the plugin does not rewrite the skill listing |
| Event handling (session tracking, lifecycle, cache telemetry) | ✅ | ✅ event pump + additive v2→v1 synthesis | — |
| Tool execute hooks (apply-patch recovery, task-session, json-recovery) | ✅ | ✅ `createToolExecuteBridges` with subagent→task normalization | — |
| Built-in MCPs (context7, gh_grep) auto-registered | ✅ | ✅ `ctx.mcp.transform` | `ctx.mcp.transform` is present in all v2.0.x stable hosts; the runtime capability probe is belt-and-suspenders |
| Background-job state persistence | ✅ best-effort project-local board snapshots | ✅ same snapshots plus optional `ctx.storage` lifecycle metadata | Filesystem snapshots retain task/session mappings and aliases per root session. Optional V2 storage separately persists tombstones, deletion epochs, owned-child identity/delivery markers, and alias high-water marks; it does not store the board itself. |
| Foreground model fallback (rate-limit failover) | ✅ | ✅ retry-hook steering; abort-and-replay disabled | V2 retry hooks can switch the model for the current retry. The non-atomic abort-and-replay path stays disabled because `session.switchModel` plus transcript replay could affect a newer turn. |
| `/preset` (preset manager) | ✅ config writes; reload to apply | ✅ TUI manager with current-session and global-default scopes; `/preset <name>` fast path | Session scope requires V2 `ctx.storage`, `ctx.rpc.register`, and the TUI `client.rpc`. It changes inference for future subagents in that session, not the parent model or existing children. Config edits refresh inference defaults for future bindings; malformed config preserves last-known-good state. The TUI reports refresh requests rather than claiming the server watcher applied them. |
| Default primary agent | ✅ finalized visible orchestrator identity | ✅ `draft.default(<visible orchestrator identity>)`; canonical `orchestrator` may remain a hidden alias when `displayName` is set | v1 `default_agent` and v2 draft default target the same visible entry |
| TUI default agent | ✅ orchestrator | ✅ host follows the default primary agent and hoists it to the head of the agent list | — |
| Multiplexer (tmux/zellij/herdr/cmux-tui panes) | ✅ | ✅ TUI plugin entry wires the client-owned pane lifecycle through a v2 adapter | Defaults are host-specific; credentials are passed through spawn-time environment, not viewer command lines. See [Secret handling](multiplexer-integration.md#known-limitations). |
| `/queue` (live admission view) | ✅ reactive dialog | ✅ command-toggled sidebar section | Uses a bounded project-scoped mirror; v2 uses verified `keymap.layer` and `ui.slot` APIs. |
| Orchestrator-wake scheduler | ✅ todo-gated periodic and event-driven wakes | ❌ not created | V2 uses native background notifications for first terminal delivery and `task_status` as the pull channel; the full `backgroundJobs.orchestratorWake` section is ignored with a warning. |
| `chat.headers` (Copilot `x-initiator` routing) | ✅ | ✅ via `session.hook("model.request")` | transport-level only; auxiliary kinds are covered by v2's built-in Copilot provider hook |
| Companion app | ✅ | ⚠️ unverified | independent desktop app; test separately against v2 |

## Upstream behaviors to know

Behaviors of v2 itself that plugin authors should know about — none
currently break this plugin:

- **The `subagent` tool description grows a native roster.** On every
  context/compaction/generate build the host appends `Available subagents:`
  with one `- id: description` line per dispatchable agent (filtered by
  mode, `hidden`, and the current agent's permissions). The append happens
  after plugin `tool.definition` hooks, so a plugin cannot strip it; v1
  hosts have the same mechanism in the tool registry (`Available agent
  types and the tools they have access to:`). This plugin keeps its agent
  `description` values as non-duplicating one-liners (routing criteria stay
  in the orchestrator prompt's `<Agents>` block) and offers
  `routingBlock: false` to drop that block on v1 and v2; the roster keeps
  identity, the block's Delegate/Don't criteria are the documented cost.
  One flavor caveat: the `hidden` filter is v2-only — as of opencode
  1.18.35, v1's `agents.list()` and the task tool's `describeTask` filter
  by mode and permissions but not `hidden`, so hidden agents (omos
  councillors included) do surface in the v1 task roster, while the
  orchestrator's inline seat list remains the only always-present seat
  source on v2.

- **Event payloads ride under `data`, not `properties`.** The v2
  event stream (SSE and `ctx.event.subscribe()`) frames each event as
  `{id, created, type, location?, durable?, metadata?, data}` — the payload
  is the `data` record, unlike the v1 SDK's `properties` (verified live:
  every observed event keyed `["id","created","type","durable","data"]`,
  with the optional `metadata?` key observed on some events).
  The adapter reads `data` first with `properties` as a legacy fallback and
  always writes `properties` on the synthesized v1 shapes, because that is
  the key the v1 consumers read. The interview bridge's event handler
  (`handleEvent` in `src/v2/interview-bridge.ts`) resolves its payload
  data-first the same way — reading only `properties` had left its
  transcript projection and deletion cleanup dead on live v2 for every
  event (`handleContext` is unaffected; it consumes a different event
  type).
- **`session.deleted` is synthesized with a dual id spelling.** v2
  delivers deletion flat (`{sessionID}`), and the v1 deletion consumers
  read two different spellings: the cache monitor's session eviction
  reads `properties.info.id`, while the task-session-manager's
  deletion handler accepts `properties.sessionID`. The synthesized v1
  event therefore carries both. Without this synthesis the deletion
  cleanup (rehydrate tombstone, board teardown, idle-token/input-wait
  clears) never fired on v2, and deleted runs resurrected as
  forever-running ghost records on the next request.
- **Lifecycle keys on `session.execution.*`.** V2 hosts publish durable
  `session.execution.started/succeeded/failed/interrupted` events
  (`{sessionID}`, plus `error` on `.failed` and `reason` on
  `.interrupted`) and emit no busy/idle `session.status` and no
  `session.idle` on the event stream (`session.status` remains only in the
  schema). The adapter synthesizes the v1 lifecycle shapes from the
  execution events (`started` → busy `session.status`; terminal subtypes →
  idle `session.status` + `session.idle`; `failed` → a v1 `session.error`
  with the host error payload passed through best-effort, emitted before
  the idle pair so the error-then-idle flow the event-router expects is
  preserved). Without this synthesis the orchestrator-wake scheduler never
  arms on live v2 hosts.
- **Transcript user messages carry no identity.** Context-hook
  transcript user messages on live v2 hosts carry `{id, time, text,
  type}` only — no `agent`, no `sessionID`. The v1 injection gates
  (phase-reminder, background-job-board) key on
  user-message `info.agent`/`info.sessionID`, so every injection would
  skip. The v2 context bridge stamps the context event's `sessionID` and
  the session's known agent (from the event, falling back to the
  session-prompt bridge's learned state) onto transcript user messages
  before the bridged messages transform runs — strictly absence-gated
  envelope enrichment (host-provided identity wins). For `msg_omos_`
  synthetic wakes, the bridge also replaces the first text part with a
  copy restoring its internal flag and metadata. Both are idempotent;
  the provider-bound text bytes remain unchanged.
- **Runtime status reconciliation is capability-gated.** v2 has no
  equivalent of the v1 live session-status map (`client.session.status`
  is not a function on v2 hosts; `session.status` is not exposed to
  plugins), so the task-session-manager's
  runtime-status reconciliation poll is disabled entirely on hosts
  without the method — a single per-instance log line notes the
  disabled reconciliation instead of logging uncertainty every ~5s poll.
  v1 hosts expose the method and keep the exact historical polling
  behavior. Background job stop-confirmation was never obtainable from
  the v2 poll anyway (the lookup failed every time).
- **Plugin API surface and adoption status.** The v2 plugin API exposes
  session hooks `compaction`, `generate`, and `title` (the title and
  compaction hooks may set `result` to skip the model call entirely)
  and TUI `ui.tabs.move()` (`tabs.open` does not focus a tab;
  `tabs.focus` opens the tab if needed). The `SessionContext` request
  shape carries `generation` and `providerOptions` in a single
  `options` object — the plugin is unaffected: its context bridge
  mutates only system/messages; its single cache hint rides
  `ContentPart.cache`. Adoption status: the **compaction hook is
  adopted** — the plugin strips phase reminders from the compaction input,
  preserving job boards so the summary can report running jobs. On v1, the
  `experimental.session.compacting` hook instead marks the next message
  transform for that session; it strips only phase reminders after the
  transform, leaving the job board untouched. The v2 adapter does not forward
  this v1 hook; **child-session permission rules are applied** —
  plugin-managed child sessions receive exact-match task-policy rules
  once at creation via `ctx.session.update({sessionID, permissions})`
  (`createPermissionRulesBridge` in `src/v2/setup.ts`; exact-match
  strings only, no wildcards, while upstream matching semantics settle —
  PRs #48194/#46495/#46871; whole-tool declarations (the read-class
  `read`/`glob`/`grep` allows read-only agents declare) derive
  action-scoped rules with the declared tool key as the exact resource,
  so every agent with any declaration gets a non-empty replacing
  ruleset instead of keeping the parent's inherited session rules;
  triggered on plugin-managed child
  `session.created` and fail-soft with a one-time warning on reduced
  hosts without the method); the `generate` session hook, the `title`
  hook, and the `tabs` methods are not used. On the client SDK,
  `server.status` is named `server.info` (the plugin never calls it),
  and the `location.reload` / `fs.write` endpoints and the Form
  `hidden` field are likewise not adopted. The applied child-session
  allow rules always lose to a matching user-config `deny` (see the
  config permission policies bullet above).
  The `title` hook needs no adoption for child sessions: v2 hosts
  title subagent children deterministically at creation (the
  `subagent` tool sets `title` from its `description` argument, which
  the delegation pipeline always supplies) — the hook only matters if
  custom title formats are wanted. Upstream is still actively fixing
  compaction×hook plumbing and compaction×cache behavior, so
  compaction-hook semantics may evolve; the plugin's hook callback is
  written shape-tolerant (messages-only mutation) to ride those
  changes.
- **Duplicate idle delivery.** The adapter synthesizes both an idle
  `session.status` and a `session.idle` from each terminal execution event,
  so a consumer watching both sees idle twice per terminal transition.
  Current consumers are idempotent per session (idle-reconciliation's
  per-session timer guards); new idle consumers must tolerate duplicate
  delivery.
- **Duplicate `permission.asked` delivery.** The adapter appends a
  v1-field-mapped copy after the raw v2 `permission.asked` event (raw
  first is a load-bearing invariant for v2-native handlers). Consumers
  watching both see the ask twice with the same request id — safe because
  every ask consumer is idempotent per request id (the input-wait
  tracker's Set, the companion's status setters, wake suppression); new
  ask consumers must tolerate it, like idle.
- **Question flow is Form-based.** v2 replaced `question.*` with the Form
  flow; the adapter synthesizes `question.asked/replied/rejected` from
  `form.created/replied/cancelled` so v1 consumers keep working. Forms
  owned by the `"global"` sentinel session (MCP elicitation) are not
  synthesized — v1 question events are session-scoped.
- **MCP tool-name namespaces are host-generated.** This plugin never
  matches raw MCP tool names: MCP access is granted per server name
  (`"mcps": ["context7", "!gh_grep"]` in agent config), and registration
  uses its own server names via `draft.set(name, ...)`.
- **Host reload is not callable by plugins.** A host may provide an external
  `opencode reload` command or a `location.reload` endpoint, but neither is
  part of the plugin's supported API. Marketplace `requestReload` only reports
  that a host reload/restart is required and never claims one occurred. The
  When an operator invokes the CLI `opencode reload` command, the TUI reload
  command, or the `location.reload` HTTP endpoint, the host rebuilds its location
  service layer: plugin instances are destroyed and recreated, `setup`
  re-enters in the same process, and the host calls the cleanup
  returned by the previous generation before the new generation loads.
  Pending permissions and forms are cancelled, and running sessions
  swap to the new service layer at the next step boundary. There is no
  unload-style lifecycle hook. Module state of an npm-form plugin
  survives the reload (the module instance is reused); a
  local-directory plugin is forced onto a fresh module instance
  whenever its files change. The plugin handles the in-process re-entry
  explicitly: the v1 `dispose` hook cancels pending foreground-fallback
  initial-delay timers and fences off in-flight fallback chains at
  their suspension points (`foregroundFallback.dispose()` — no replay,
  abort, or transcript read continues through the destroyed client),
  clears the process-global wake-gate
  progress so the next generation does not inherit the previous
  generation's two-wake no-progress caps (`clearAllWakeSessions()`),
  and explicitly releases companion ownership
  (`companionManager.onExit()` — idempotent). The v2 `setup` entry
  calls `resetV2GenerationWarnings()`, rearming the one-time
  degradation latches (model.request ordering drift, permission-rules
  unavailable, session.list/remove unavailable) so every generation
  warns once. Background-job persistence resets unconditionally on
  every generation setup behind an epoch fence, so persisted write
  queues cannot leak across generations. The event adapter passes
  `location.shutdown` events through raw with no synthesis. The
  user-wait-gate (`wait_for_user` HITL latch) stays armed across a
  reload by design, and the admission runtime defers its final
  scheduler/tracker teardown by one macrotask so an immediate re-init
  can retain active and queued calls.
- **Config permission policies are kernel-enforced and deny-final.**
  `experimental.policies` supports `action: "permission"` entries
  (`effect: "allow"`/`"deny"`, resource wildcards) enforced by the host
  kernel. An explicit `deny` is final and never reaches the evaluate
  hooks: a user-config `deny` can suppress the plugin's allow rules or
  permission upgrades, and the plugin's exact-match allow rules on
  child sessions coexist with user config — on a match the user `deny`
  wins over the plugin's allow. No plugin code participates in that
  resolution.
- **Provider failure retries are aggressive.** The host retries a
  failing provider call up to 10 times within a total window of about
  84 s (4xx responses are never retried). Observation-style hooks
  therefore fire far more frequently in a failing session than in a
  healthy one.

### The v2 plugin API surface this adapter uses

- **`session.update({sessionID, title?, permissions?})`.** Sets the
  session title and/or REPLACES the session-scoped permission rule
  list. The client shim's v1-facing `session.update({body: {title}})`
  and the v2 interview bridge's session renames both call it, and the
  child-session permission bridge applies its rules through the
  `permissions` field (see the adoption-status bullet above).
- **`session.interrupt({sessionID, resume})`.** `resume: false` aborts
  the active run; the shim's abort path sends exactly that.
- **`experimental.ws.handshake` / `experimental.ws.send` /
  `experimental.ws.receive` session hooks.** Official experimental
  hooks on the pinned surface (the mirror-conformance guard's
  `OfficialSessionHookNames` set of 12); **not registered and not
  used** by this plugin — they appear only in the official-set pin.
- **Core `# Your Model` identity system part.** v2 core splices a
  `# Your Model` identity part at `system[1]` on every LLM request. The
  plugin's system transform keeps appending the orchestrator prompt to
  `system[0]` and collapses all parts into one — locked by a regression
  test in `src/index.test.ts`.
- **Subagent `model` param.** Where the host schema supports it, the built-in
  `subagent` tool takes an optional canonical `provider/model#variant` reference
  (omit `#variant` when no override is needed). Slim's delegation guidance
  honors explicit user choices and delegation instructions, resolves IDs before
  use, and preserves nested slashes and colons in model IDs. Its description
  transform does not add override fields to hosts that lack them or replace
  native validation. See [Delegation](skills.md#delegation).

## Installing on v2

Add the npm package, **pinned to an exact version** — v2 auto-refreshes
unpinned npm plugins on every startup, so `@latest` effectively means
"silently upgrade whenever a new version ships". The global config root is
`~/.config/opencode/opencode.json`, shared with v1 (`~/.config/opencode2/`
is not read for plugin config):

```json
{
  "plugin": ["oh-my-opencode-slim@2.2.25"]
}
```

### Local source development (no publishing)

For local development, point the config at the **checkout root**: the
repository ships root `server.js` / `tui.js` forwarders, and v2 resolves
directory entries by file convention (`<dir>/server.*` for the server role,
`<dir>/tui.*` for the TUI role), so both roles load the freshly built
`dist`:

```json
{
  "plugin": ["file:///path/to/oh-my-opencode-slim"]
}
```

Directory entries are watched and hot-reload from disk. The npm-package
form — including the single-slash npm protocol
`"file:/path/to/oh-my-opencode-slim"` — resolves through `package.json`
`exports` (`./server`, `./tui`) instead and is resolved once per session,
not watched.

Do **not** register `dist/` or `dist/server` directly: `dist/` has no
`tui` file for the v2 TUI role (its `tui.js` is the v1 bundle), and the
server-only `dist/server` directory has no TUI side. An external shim
directory whose root files re-export this repo's built bundles also works
when you prefer to keep the checkout out of the config:

Build first:

```bash
bun install
bun run build   # produces dist/index.js (v1), dist/server/index.js (v2
                # server bundle, also served via the ./server subpath),
                # dist/tui2.js (v2 TUI), dist/cli/
```

Create the shim OUTSIDE the repository (paths below are generic placeholders
such as `<home>/opencode-plugins-dev/oh-my-opencode-slim/`):

```ts
// index.ts — server entry (root `index` is what the loader resolves)
export { default } from 'file:///absolute/path/to/oh-my-opencode-slim/dist/server/index.js';
```

```ts
// tui.ts — TUI entry (root `tui`, loaded by the TUI runtime)
export { default } from 'file:///absolute/path/to/oh-my-opencode-slim/dist/tui2.js';
```

Register the shim directory in the OpenCode v2 config:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-plugins-dev/oh-my-opencode-slim"]
}
```

`bun run build` after each source change; the forwarders (or the shim)
re-export the fresh bundles and no publish step is involved.

Verify with `opencode2 run "list your specialist agents" --standalone` — the
orchestrator should name explorer, oracle, designer, fixer.

### Registration rules

- **Directory or package entries only.** File-path entries (e.g.
  `…/dist/server.js`) are rejected with the WARN
  `configured plugin path must be a directory`. A directory entry's server
  side resolves `<dir>/server.*` first and falls back to `<dir>/index.*`; its
  TUI side resolves `<dir>/tui.*`. The checkout root ships `server.js` /
  `tui.js` forwarders for exactly this, which is why the checkout-root form
  above serves both roles (a shim's root `index`/`tui` files work the same
  way).
- **Single-file plugins need a wrapper dir** whose `index.js` re-exports the
  original file, e.g. `~/.config/opencode/plugins-dev/<name>/index.js`
  containing `export { default } from "/abs/path/to/plugin.js";`. Do not
  use the auto-scanned dir names `plugin`/`plugins` for wrapper dirs — a
  scanned duplicate next to an explicit registration hard-dies on duplicate
  plugin ID.

## Configuring models on v2

Agent models are resolved the same way as v1 (per-agent `model` in
`oh-my-opencode-slim.json`, or inherited from the session/host default). On
v2, set a working provider+model in your config or the plugin's config file
so delegated subagents can run.

Abort-and-replay foreground fallback is disabled on v2, even when configured.
The current host API cannot atomically switch a session model only if the failed
turn is still current; an in-flight non-atomic `session.switchModel` could
otherwise commit after a newer user turn takes over. The v2 retry-hook steering
path remains available when fallback is enabled: it switches the model for the
current retry in place and does not abort or replay a transcript. This is
distinct from the disabled foreground replay path; v2 has no plugin wake
scheduler.

## Background job state: rehydrate probe and persistence

Several mechanisms keep the in-memory background job board honest against the
host across process and plugin restarts:

### Tracking recovery is not execution recovery

Restoring a board row does not resume interrupted execution. OpenCode owns
automatic restart continuation. In the inspected
[v2.0.32 host source](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/session/context.ts),
`SessionContext.select` flushes MCP tools, then selects the persisted agent
without an explicit plugin-activation barrier in that method. The runner
already waits for activation once when a drain begins, but does not repeat
that wait before every later context selection. Local server logs contain
`Session.AgentNotFoundError: Agent not found: "designer"` during restart drains;
the same failure also affects other plugin agents.
The related upstream [OpenCode issue #54172](https://github.com/anomalyco/opencode/issues/54172)
also reports existing agents disappearing during plugin/config reloads.
The proposed [host fix #51133](https://github.com/anomalyco/opencode/pull/51133)
adds per-selection waits; it remains unmerged at the time of investigation.
That fix does not establish whether activation readiness covers this plugin's
deferred agent projection and asynchronous rebuild during cold startup.

If native recovery reaches agent selection before registration completes,
board adoption cannot repair that failed execution. A prompt-admission hook
cannot protect selection that already failed. The host needs a readiness
boundary covering plugin activation and committed agent-registry rebuilds.
Do not interpret a restored task row as proof that execution resumed, and do
not blindly resend continuation prompts after uncertain admission. This plugin
does not add placeholder agents or automatically relaunch work to mask the race.

### Read-only task diagnostics

`task_status` accepts `diagnostic: true` for tracked failed, cancelled, or stopped
children. Startup recovery normally re-adopts restarted children onto the board
with their historical run start; v2 also re-delivers completions. An owned
untracked handle returns ordinary read-only observed status plus a notice that
diagnostics require a tracked record, with no excerpt or extra transcript read.
Foreign-parent handles remain rejected.
It never registers, prompts, or reconciles a child. Running children are
refused; completed children use `result: true`. Missing or ambiguous evidence
is explicit. Excerpts include assistant text and short assistant/failed-tool
errors, not tool inputs or successful outputs. The tool's rendered diagnostic
response fits 6,144 UTF-8 bytes, including headers, errors, and truncation
markers; plugin warnings may be appended separately. The fetch requests a
limit and our own scans are bounded. The paged messages route honours the limit.
Without that route, the context fallback fetches full raw context, checks it for
compaction, then selects only the newest requested entries before conversion.
Dropped entries or compaction mark the page incomplete; fetching raw context
itself is not bounded by the shim. No-limit and paged history-boundary reads are
unchanged. Missing attribution outside the scan window
is reported as uncertain or unavailable, never guessed.
Excerpts start after the latest real input in the scan window and exclude
assistant messages created before the tracked run start. Input may predate
registration; missing creation times or only pre-start evidence makes the
excerpt unavailable. Host compaction messages are excluded and labelled.
Terminal reasons use recorded host error/outcome reasons, then attributable
assistant error text, then the state name, not stored partial findings.

Diagnostics are read-only and not consumption or acknowledgement. Observed
state is evidence, execution completion ends a run, and parent acceptance is
separate; diagnostics do not replace the completion/acceptance flow.
The fixed next-step line advises awaiting or re-delegating, not marking the task
accepted; it does not depend on a host-specific revival tool.
`last_activity_source` reports `observed-activity` (tracker event, possibly
lagging), `host-busy` (coarse host activity beyond run start, not progress),
`launch-time` (no activity evidence beyond the run start time, not proof of
inactivity), or `unknown`. Session-keyed tracker entries may predate a revive;
the underlying activity timestamps are unchanged.

Project-local snapshots complement lifecycle recovery and keep the in-memory
background job board available across process and plugin restarts:

### Project board snapshots (v1 and v2)

Best-effort snapshots under `.local/.slim/background-jobs/` retain task/session
mappings and aliases independently of the optional v2 `ctx.storage` domain.
Valid snapshots restore before task-board operations. Previously running records
restore as stopped with uncertain status, not as live running jobs or proven
terminal results. Missing, invalid, or unwritten snapshots leave recovery partial;
host history and ownership-verified read-only fallbacks still cover untracked
sessions. See [Background Orchestration](background-orchestration.md).

For these restored uncertain stopped records, V2 native `subagent(sessionID, prompt)`
can queue a continuation only when the host supplies both native idle verification
and caller-chosen queued prompt identity. It verifies ownership and agent identity,
holds a generation-scoped relaunch lease, awaits bounded native idle evidence,
then revalidates identity and lifecycle fences before queueing the exact input.
It does not abort the original execution or fabricate its historical outcome.
This V2 recovery path inherits the persisted model selection and refuses
explicit model/variant overrides; v1 `task_revive` override behavior is unchanged. Managed-parent eligibility, queued-input identity capability, and
the same authoritative idle-wait function are rechecked after verification and
immediately before submission. The native wait must resolve to `undefined`
before its deadline; arbitrary result objects are not accepted as idle evidence.
Pending admissions, fallback work, invalid or timed-out verification, and
concurrent lifecycle changes refuse without sending a prompt. Hosts missing
either capability retain the uncertain record and fail closed.

The newly published admission row remains uncertain while its exact queued
input lacks attributable acknowledgement, including after caller timeout or
unknown transport outcome. Only an acknowledgement naming that input or its
attributable result can clear admission uncertainty; generic status reads cannot.
An explicit host refusal restores the retained uncertain row. Unresolved input
identity survives board restoration and excludes duplicate recovery, without a
lease TTL, retry, or automatic abort.

This exclusion is enforced by the store even without the old in-memory tracker
or lease: generic busy/terminal observations do not grant cancellation,
relaunch/native-resume, messaging, terminal-notification, or deadline authority.
Terminal evidence must match the persisted input identity; a generic cancelled
publication is not admission proof. Malformed persisted identity stays
quarantined instead of silently losing exclusion.

Refusal rollback uses the predecessor captured by the store immediately before
publication. It restores only unchanged, exactly owned state and retires that
lease atomically before observers or tracker callbacks run. Intervening
activity, metadata/context, cancellation, deadline, deletion, or ownership
changes retain conservative exclusion rather than being overwritten.

### Rehydrate existence probe (`session.get`)

Rehydration re-registers persisted *running* task tool parts so a plugin
restart does not orphan in-flight background lanes — but a session deleted
while the plugin was down would resurrect as a forever-running ghost.
Transcript rehydration only re-registers what the parent's persisted tool parts
still show; it does not by itself restore aliases or terminal results. Board
snapshot restoration is a separate path. Two
read-only paths cover the post-restart gap: a native background plaintext
launch result whose trailing `slim-child-ref:v1` marker is the output's
final non-empty line still pairs its alias with that session (an anchored
tail match only — a marker inside the body text is never trusted), and
`task_status` falls back to host-verified ownership plus transcript
evidence for an owned session the board no longer tracks (see
[Background Orchestration](background-orchestration.md)).
After rehydration registers a task, the task-session-manager transform
fires a fire-and-forget `client.session.get` probe per newly registered
taskID:

- **Capability-gated, not host-gated — but v2-effective.** The probe runs
  whenever the client exposes `session.get`; hosts without it skip
  silently. The typed NotFound classification only crosses the v2 plugin
  boundary (the host passes the raw core effect in-process): the v1 SDK
  wraps 4xx responses as plain `Error` with a `.cause` (or returns an
  `{error}` tuple when `throwOnError: false`), so on v1 hosts the probe
  runs but harmlessly never tombstones — the wrapped rejection falls into
  the transient fail-open path. The probe lives inside the existing
  task-session-manager transform — no new pipeline step.
- **NotFound classification is typed, never heuristic.** A rejection
  tombstones the task only when `err._tag === 'Session.NotFoundError'`
  (property check; never `instanceof` or message matching — the SDK error
  class identity is unstable across host builds). Cleanup is
  generation-freshness-guarded: the board record's generation is captured
  before the async `get`, and a NotFound that resolves after a legitimate
  same-ID relaunch (new generation, tombstone cleared) skips all cleanup
  instead of deleting the live relaunched record. On a fresh hit, the four
  probe cleanup actions run as one synchronous block — supervisor
  `onSessionDeleted` first (it needs the record to exist so
  deadline-exceeded runs finalize their wall-clock timeout; same ordering
  as the event-router/coordinator deletion paths), then the rehydrate
  tombstone, board drop, and concurrency `releaseTask` (all idempotent; a
  missing `releaseTask` would leak an admission slot forever). The
  canonical full deletion cleanup (input waits, idle tokens, pending-call
  tracker, `clearParent`, task-context tracker, snapshots) runs via the
  `session.deleted` event path.
- **Any other rejection fails open** — the job stays registered and the
  normal reconciliation paths keep their chance. The probe never rejects
  unhandled.
- **A resolved terminal outcome settles the job** through the same
  `updateStatus` semantics as the idle-reconciliation host-outcome path:
  `succeeded` requires usable final assistant text (otherwise the
  textless-completion diagnostics apply, per the #1115 precedent);
  `failed` settles as error with the host outcome recorded; `interrupted`
  is a host stop, not a failure, and settles as `stopped` (the stop
  family — no plugin-verified cancel lease), never a false error.

Related injection hardening: a remembered (possibly stale) processed
completion skips *cleanly* — the fence check runs before the
deletion-epoch fail-closed branch in `updateFromInjectedCompletion`, so
replaying an old completion after a delete + same-ID relaunch can no
longer poison the fresh generation with `markStatusUncertain`. Unobserved
completions for a deleted task still fail closed for every provenance
kind.

### Persistence via `ctx.storage` (v2)

When the v2 host exposes the optional `storage` domain, the plugin
persists background-job lifecycle state through
`src/utils/background-job-persistence.ts` (configured in `setup` before
the v1 factory runs):

- **Tombstones, deletion epochs, and alias high-water marks** are write-through. Clearing a tombstone on legitimate relaunch is persisted, so a deleted-then-relaunched task is not ghost-skipped and restored epochs stay monotonic.
- **Owned child identities** are write-through and include task/parent IDs, agent, description, objective, launch fence, and terminal-delivery marker. Startup recovery can use them when `session.list` is unavailable; accepted delivery or trusted current-run history is required before marking an outcome delivered. Failed or skipped v1 wakes remain pending; native v2 delivery and `task_status` remain the v2 channels.
- **Aliases:** project board snapshots retain the task/session alias mappings. The lifecycle metadata sink stores alias high-water marks, not the mappings themselves; a missing alias resolves only from readable parent history.
- **Backend-only seeding:** without `ctx.storage` the lifecycle metadata module is an in-memory no-op, while project board snapshots still operate independently.
- **Bounded and serialized:** tombstones and owned-child identities each cap at the 500 most recent entries; per-key writes are serialized, and failures degrade to process-local behavior.
  [Background Orchestration](background-orchestration.md)).
- **Seeding is backend-only.** Without `ctx.storage` (v1 hosts, hosts
  without the domain) the lifecycle metadata module is a pure in-memory no-op
  sink. Project board snapshots still apply independently; deletion ledgers
  remain process-local without this domain.
- **Bounded and serialized.** Persisted tombstones (and their epoch
  entries) and owned child identities each self-cap at the 500 most recent
  by recorded/launch time; writes for one key are serialized in-process
  (no concurrent read-modify-write); write failures log and degrade to
  process-local behavior.

### Diagnostics

Two log lines aid drift diagnosis (both hosts): the task tool's terminal
output that carries no parsable task id is logged with a ~140-char
preview (`task output without a task id` — the host-output-drift
detector), and an idle observation for a *tracked managed child* with no
running board record logs with a `[task-session-manager] WARN:` prefix
instead of the routine idle line.

**Secret redaction at the logger.** Every plugin log line — file sink,
stderr fallback, and the append-failure path — passes through
shape-based secret redaction at the logger's single compose point
(`src/utils/redact.ts`): known vendor token prefixes (`sk-`, `gh*`,
`glpat-`, `xox*`, `AKIA`/`ASIA`), URL credentials
(`scheme://user:password@` — password only), authorization schemes
(Bearer/Basic/token), and generic 32+-character opaque runs are masked
to 4 leading + 2 trailing characters. This is a best-effort barrier
against *accidental* leaks in short previews, not an adversarial
guarantee: unprefixed short secrets, secrets containing run-breaking
characters, and chunked or obfuscated content remain residual gaps,
while long opaque non-secrets (UUIDs, hashes, long paths) are masked as
accepted false positives. The parse-miss preview (`task output without
a task id`) is stricter still: it is **structure-only** — tag and field
names survive for drift diagnosis, but every value (XML attribute
values, `key:`/`key=` prose values) is fully replaced with `[masked]`
before slicing, because parse-miss content is untrusted-by-format and
values (description fields in particular) carry user-authored text.
All other log sites rely on the shape-based redaction at the logger
choke point.

## Limitations

### Interview

`/interview` is supported on v2 through a marker command and a
trailing-message context bridge. The bridge keeps an in-memory transcript
projection from v2 context and streamed text events, and uses the v2 session
methods for prompts, notifications, and renames. Interview notifications
admit the synthetic input with `resume: false` — the interview URL lands in
the session without waking an agent turn (the v1 `noReply` prompt
equivalent). The markdown document
remains the durable source of truth; completion responses without
`<interview_state>` rewrite the current spec while retaining frontmatter and
Q&A history.

### Multiplexer panes on v2

The v2 TUI entry (`setup()`) wires the client-owned pane lifecycle through a
v2 host adapter: shared background service and `--server` hosts are supported;
`--standalone` is fail-closed (no panes, one `multiplexer.host-unsupported`
diagnostic per process, `/subagent` fallback — the child opens in a tab
without moving focus; the displayed session stays the interaction surface).

On `--server` hosts the viewer's `OPENCODE_PASSWORD` secret is injected at
pane creation through the multiplexer's native spawn-time environment
(tmux/herdr/kitty) or a Linux + POSIX-shell `/proc` bridge (zellij/cmux-tui),
never through the viewer's command line; unsupported host/shell combinations
fail closed. The value is the same credential the TUI itself uses to
connect, so a password-protected server already implies it in the TUI's
environment; no extra setup is needed for panes. See
[Secret handling](multiplexer-integration.md#known-limitations).
See [Deployment Modes](multiplexer-integration.md#deployment-modes).

### Not exposed on v2.0.x: `session.list` / `session.remove`

This limitation applies to v2.0.x. OpenCode 2.1 exposes both methods to
plugins. Its `list` is paginated: the adapter follows `cursor.next` through
the empty terminal page, with a 1000-session and four-second total budget.
Exceeding either budget fails the read instead of returning a partial list.
This is source-contract and fixture coverage, not a live-host verification.

The v2.0.x plugin session domain (`packages/plugin/src/promise/session.ts`,
`SessionDomain`, mirrored by the runtime object the promise adapter
builds) exposes exactly `create`/`get`/`switchAgent`/`switchModel`/
`prompt`/`generate`/`command`/`synthetic`/`interrupt`/`update`/`move`/
`wait`/`context` — **`list` and `remove` are not handed to plugins**.
Both endpoints exist on the host's HTTP API, but the v2.0.x plugin context
never receives them. `session.status`, `session.todo`, and `session.children`
are likewise not exposed to plugins. The v2 plugin wake scheduler is not
created; consumers that need session enumeration use persisted identity,
event, or history evidence, and runtime liveness checks cannot use a host
status map. The client shim capability-probes both at runtime
(`typeof s.list === 'function'`, `s.remove`), so hosts exposing them use
real delegation; on all
v2.0.x stable hosts both probes fail and the shims degrade:

- **Session listing (v2.0.x).** When native `session.list` is unavailable, the
  shim returns the v1-parity empty page `{data: []}` and logs once. Startup
  recovery falls back to persisted child identities and event/history evidence;
  the interview dashboard cannot enumerate sessions through that unavailable
  listing. V2 has no plugin wake scheduler, so this is not a wake-scheduler
  fallback. On hosts that expose `session.list` (v2.1+), the shim forwards and
  paginates the real listing with a 1000-session and four-second budget.
- **Session delete (v2.0.x).** `client.session.delete` is a **no-op** when the
  host does not expose `session.remove`. V2 retention pruning is skipped when
  its live-idle precondition cannot be verified; v3.0.6 also removed the
  secondary-model smartfetch sessions that previously needed cleanup.

Both degradations announce themselves in the plugin log with a single
deterministic, **one-time-per-process** warning instead of degrading
silently (`list`) or logging on every call (`remove`):

```
[v2][shim] session.list unavailable on this host build; children enumeration falls back to event tracking
[v2][shim] session.remove unavailable on this host build; session delete is a no-op
```

The guards are module-level booleans with fixed text — no timestamps,
session ids, or per-call payloads — so repeated wake polls and cleanup
calls do not flood the log.

### No orchestrator-wake on v2

The wake scheduler is **not created on v2** (council 2026-10-23). The host's
native background notifier owns terminal delivery: a busy parent is reached
by steer at its next step boundary, an idle parent gets a successor turn,
restart recovery re-delivers from the durable KV job marker, and the durable
inbox dedupes by message ID. A rev>1 continuation relaunched through the
`subagent` tool re-arms the native notifier. Child permission/question asks
are a host-UI boundary the host does not route to the parent agent; the
parent discovers open asks via `task_status` pull. The whole
`backgroundJobs.orchestratorWake` config section is v1-only and warns as
ignored on v2.

### Terminal-publication wake

The native notifier handles the first terminal publication for runs launched
or resumed through the native `subagent` tool. Plugin-owned `task_revive`
continuations use their tracker-owned notification path instead. A terminal
publication that lands while the parent sits idle on a LATER
revision of the same generation (a child that self-continues via its own
background-shell notification and finishes again, or a completion after a
direct prompt to the child session) would otherwise wait for the periodic
idle evaluation (up to `orchestratorWake.intervalMs`, default 5 minutes).
The **terminal-publication wake** closes that gap on v1 (on v2 no plugin wake
exists — the native notifier and `task_status` pull are the only channels):

- **Trigger:** the terminal gate publishes a `completed` or `error` host
  outcome (state-disjoint from the stopped-job recovery listener, which
  keys on `stopped` + terminal-unreconciled) AND the parent is idle AND
  no input wait is open AND at least `publicationWakeMinIntervalMs` has
  passed since this parent's last *delivered* publication wake (the
  per-parent throttle is consumed only on delivery — and only after the
  evaluation actually queues the wake admission; a suppressed OR vetoed
  attempt, including an in-evaluation no-delivery exit such as the
  unchanged-fingerprint no-progress stop or an SDK error, burns
  nothing). The FIRST terminal publication of ANY generation
  (`terminalRevision` 1) is suppressed with `reason:
  "first-publication-native-owned"` — the native notifier armed by that
  generation's `subagent` tool call already delivers it to an idle
  parent; if that native delivery is ever lost host-side, the job stays
  pullable with `task_status` on the parent's next activity. Exception: a
  revived run whose tracker-owned `<task>` notification exhausts its
  whole retry budget releases ownership and re-emits the publication
  wake directly through the scheduler (a revived lineage has no native
  notifier, so the first-publication suppression must not apply to that
  degraded fallback) — the idle parent always ends up with exactly one
  delivery: the notification or the fallback wake.
- **Busy parent → skip entirely:** the native steer already delivered the
  first completion; a queued wake would double-notify.
- **Delivery:** the same `promptAsync` machinery as the periodic wake —
  `delivery: "queue"`, `modelSelection: "inherit"`, the session's current
  model variant — reusing the existing wake text (no new prompt surface).
- **Shared gate:** one-flight, the two-wake no-progress cap, and
  `expectingWakeBusy` are the periodic scheduler's, not a parallel gate.
  A publication wake enters evaluation past the cap's pre-check and lets
  the in-evaluation fingerprint comparison decide: a publication that
  changed the children fingerprint un-stops the session; an unchanged
  fingerprint keeps the cap tripped.

Config knobs (see the `backgroundJobs.orchestratorWake` rows in the
[configuration reference](configuration.md#background-job-management); v1
only): `wakeOnTerminalPublication` (boolean, default `true` — the feature
flag) and `publicationWakeMinIntervalMs` (integer ms, default `30_000` — the
per-parent throttle window; a burst of publications collapses into one
wake).

Related: when a job whose terminal report the parent already consumed
(reconciled) reopens to running, the plugin appends exactly one corrective
trailing notice ("previously reported terminal, now running again; the earlier
report is superseded") in the cache-safe tail zone, pointing at `task_status`.

On v1 hosts the same first-publication rule holds (the native task-tool
notifier delivers it), and a LATER publication of the same run — which has no
native notifier on either host — is delivered by the plugin itself on v1 only,
as one self-contained `<completed-job>` delta through the bounded delta queue
(it survives a busy parent, and inside the per-parent publication spacing it
stays queued until the window elapses). On v2 the plugin sends no wake: a
relaunch through the `subagent` tool re-arms the native notifier, and any
other later result is pulled through `task_status`.

### Host outcome quirks the terminal gate defends against

Two v2 host behaviors (verified against v2.0.26) shape how the terminal
gate handles host outcomes:

- **`idle_outcome` is never cleared.** The host writes Session.Info
  `outcome` once, at the run's terminal transition, and nothing resets
  it when the same session starts a new run — a later read returns the
  PREVIOUS run's outcome until the next terminal transition overwrites
  it. The gate therefore never trusts a session-level outcome alone:
  `attributableHostOutcome` accepts an outcome only when its `time.idle`
  falls inside the current run's read window (the
  `idle-not-after-window-lower` rejection reason is this defense logging
  itself), and the transcript classifier treats a session-level outcome
  as corroborating evidence, never as the primary criterion.
- **Committed-but-stale reads.** A host read can observe a state older
  than an already-committed write (pinned by the terminal-gate test
  suite). The gate reads evidence, never invariants such as
  "outcome present ⇒ terminal", and simply re-reads on the next attempt
  when a read lags a commit.

The publication path additionally runs a **log-only corroboration**:
when a window-attributed host outcome is in hand at commit time, the
published state is compared against the state that outcome would imply
(`succeeded` → completed, `failed` → error,
`interrupted`/`cancelled` → stopped; verified-cancel publications are
stop-family normalized so they never log), and disagreements land in
`[terminal-gate] outcome corroboration` log lines. The mirror never
gates behavior — promoting it to a decision signal requires a fresh
review — and a host without `session.get` produces no entries.

### Environment caveats

- **Reduced/TUI-side hosts.** Some host processes load the plugin's `setup`
  with a reduced, TUI-side context that lacks `agent.transform` (and other
  domains). The adapter capability-guards `setup` and skips registration
  gracefully for those hosts instead of crashing or retry-storming. The
  same applies to the embedded v2 pass inside every v1 host: it invokes
  `setup` with registration-only domains, so a v1 session's plugin log
  shows `[v2] tool.transform failed`-style lines and
  `health check passed {"bridges":4}` — expected noise from that parallel
  pass, not breakage. The classic `server()` path (a separate plugin-log
  instance a few seconds apart) carries the full v1 functionality.
- **TUI-side plugin logs are not captured.** The plugin logger initializes
  in the server process only, so TUI-side registration failures write no
  `[v2][tui]` lines anywhere. Verify TUI behavior through the host (command
  availability, on-disk effects), not via the plugin log.
- **Local-checkout loading.** When the plugin is registered from a local
  build, the externalized `jsdom` import must resolve from the plugin's
  `node_modules` (webfetch imports it lazily, so the plugin still loads
  without it — install as a package or ensure `jsdom` is resolvable to
  enable webfetch locally). AST-grep resolves its CLI independently and
  lazily downloads a binary when no package or system binary is available.
- **Companion app unverified on v2.** The companion is an independent
  desktop app; test it separately against v2 hosts.
- **Prompt-cache rules unchanged.** The v2 bridges reuse the v1 transform
  pipeline under the same cache-safety contract: only trailing messages are
  mutated, earlier content stays byte-identical, and the v1 enforcement
  suite (`src/hooks/cache-safety.property.test.ts` and friends) covers the
  shared transform code the v2 context hook invokes. The one v2-only
  addition is one manual `cache: {type: "ephemeral"}` breakpoint per
  transformed request with plugin-tagged content. The bridge copies the
  last part of the last non-board-only message after the transform;
  injected parts receive no cache hint from their shared v1 helpers.
  This leaves room in the host's four-breakpoint budget for tools and
  system prefixes, while v1 payloads (and snapshots) stay byte-identical.
