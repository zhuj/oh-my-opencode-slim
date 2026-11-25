# my-v2 v3.0.8 port

This branch carries the scenarios from `my-v2/v3.0.7-fixes` onto upstream Slim
v3.0.8 and targets OpenCode 2.4 or newer. Where upstream already owns a working
mechanism, the port uses that implementation and adds only the remaining
my-v2 policy or interface.

## Reproducible base

| Item | Reference |
|---|---|
| Upstream repository | [alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) |
| Latest upstream release when prepared | [v3.0.8](https://github.com/alvinunreal/oh-my-opencode-slim/releases/tag/v3.0.8), published 22 November 2026 |
| Release commit | `c8d937b34f529b66abe2df20c1c6edb67070eea8` |
| Source branch | `my-v2/v3.0.7-fixes` at `424747458b863e56faf58b86a82d34bc760bd4b2` |
| New branch | `my-v2/v3.0.8-fixes` |
| Minimum OpenCode version | `2.4.0` |
| Audited host and SDK versions | OpenCode `2.4.1`; `@opencode/plugin`, `@opencode/client` and `@opencode/util` pinned to `2.4.1` |

The branch starts at the release tag. At the final fetch, upstream `master`
was `45a937e598c3311eae2766cdfc02e95758010527`, three commits ahead of the
release (two documentation changes and a native TUI color fix). Those
post-release commits are not used as this branch's base.

## Scenario mapping

| Source change | Result in this port |
|---|---|
| `fb4d02c4`, `a47d864d`: isolated test scratch | Shared scratch leases, cleanup helpers and the repository-wide source guard are retained; newly added upstream tests use the same helpers. |
| `a213570c`: scoped prompts and canonical models | Scoped templates, custom primary agents, delegation scopes, dynamic selected-model inheritance, immutable projections and the model resolver are retained. Primaries and permission scopes project into native host agents and rules. |
| `f1001435`: project rules and isolated skill commands | Rules use fresh successful native file results. Supplemental project skills use canonical `SKILL.md` paths, native discovery precedence and exact skill permissions. Generated commands retain isolated `full`, `reference` and `none` modes. |
| `0c2ce997`: patch matching costs | Reduced allocations and repeated scans are retained inside upstream's existing conservative patch rescue. |
| `b23b8865`: interview caching and reconciliation | Parsed-document and dashboard/transcript caches are retained. Native synthetic continuation preserves the host's current agent and model. |
| `de4765cf`: marketplace integrity and skill validation | Shared integrity reads and validated skill identities are retained on the current upstream activation and permission path. |
| `9519355f`: dependency queues and retained jobs | Dependency admission, limits, queue editing, waiting and graph inspection remain. Native OpenCode sessions and Jobs supply execution, retained results, cancellation, continuation and restart recovery. |
| `ee442dd4`: scoped queue UI and sidebar caches | `/queue`, bounded queue rows, conversation scoping, active-agent projections and rendering caches remain. Native registry authority and terminal-history disclosure are preserved. |
| `3f396abf`: runtime integration | Public entry points remain upstream's native V2 entry points. Utility tools, model-catalog observation, rules and skills are connected to current native hooks. The user-requested compatibility floor is OpenCode 2.4. |
| `1c5b891b`: local project artifacts | Generated interview, codemap, Deepwork, worktree and dependency-clone artifacts use `.local` paths. Explicit legacy interview paths remain resumable; codemap migration preserves legacy state files. |
| `d4d5eb36`: documentation | Configuration, skills, instruction-loading, tools and orchestration references describe the current native integration. |
| `42474745`: startup diagnostics | Upstream's fail-loud setup and cleanup remain. Agent/tool diagnostics distinguish transform registration from draft application and report the identities actually projected. |

## Native execution and my-v2 admission

The queue wraps the original native `subagent` executor. It does not create a
second Job, prompt executor, terminal notifier, transcript-based supervisor or
persisted job ledger. Native output retains its original structured result and
session ID; logical and admission IDs are additional coordination metadata.

The input extension preserves the native host's declared fields and validators.
Its Standard Schema boundary avoids mixing parser internals from the host's
and plugin's separate Effect bundles. Native runtime permission, model,
parent-child ownership and nesting checks still execute in the original tool.

Native prompt identity is observed through the invocation's asynchronous
context. The adapter does not place correlation text in user prompts. Exact
inbox delivery and durable event sequence determine which busy period owns a
queued continuation. A predecessor's terminal event cannot complete a prompt
that has not been delivered. Native shutdown interruption retains occupancy
for host recovery.

Nested work shares its active ancestor's admission reservation, so a parent
waiting for a child cannot deadlock on its own capacity slot. Parent-local
pause and dependency policy still applies. The host controls permissible
nesting depth. Provider and model limits describe outer admission reservations;
they are not a second scheduler for every provider request inside a subtree.

Queue records and dependency graphs are process-local, as in the previous
my-v2 branch. A plugin reload can reuse the active in-process runtime. After a
process restart, native host records retain the jobs and child conversations;
positive admission limits rebuild running occupancy from bounded native
session records before new admission. This does not reconstruct old logical
dependency aliases or queued payloads, which the previous branch did not
persist either.

The startup occupancy check is bounded to 500 scoped native session records.
An incomplete or failed read refuses new queued admission until occupancy can
be verified; it does not silently treat unread running work as zero. An
unobservable moved continuation retains native execution and reports the
queue's uncertainty. It cannot become a successful dependency merely because
the child later becomes idle.

## Configuration and compatibility details

| Configuration | Admission layer | Execution owner |
|---|---|---|
| `backgroundJobs.mode` omitted | Enabled for my-v2 compatibility | OpenCode |
| `mode: "managed"` | Enabled; compatibility spelling | OpenCode |
| `mode: "native"` | Disabled unless `queue.enabled: true` or concurrency configuration is present | OpenCode |
| `queue.enabled: false` | Disabled | OpenCode |
| `mode: "off"` | Disabled; Slim task controls omitted | OpenCode |

`get_session_id`, `current_datetime` and `resolve_model` remain independently
available in all modes unless disabled by name. The queue panel also follows
the sidebar and `/queue` command gates.

Model IDs keep literal nested slashes and colons. Only `#variant` separates an
inline variant. Selected-model aliases clear stale configured pins so native
session selection remains effective. The resolver distinguishes a successfully
read empty catalog from an unavailable catalog.

OpenCode 2.4 always runs subagents in the background. Continue an existing child
with its actual native `sessionID`. The host normalizes an exact empty string
to an omitted `sessionID`, which starts a new child; whitespace and invalid IDs
still follow native validation. This replaces the older my-v2 rejection of an
exact empty resume string. There is no public pre-sanitization hook to preserve
that old distinction without replacing native execution.

Named new-session placeholders from the old branch (`ses:new`, `ses_new`,
`ses_<<new>>`, `ses_` and `ses` followed only by question marks), plus null or
undefined optional IDs, still normalize to omission before native validation.
Other supplied IDs are passed through unchanged for native ownership lookup.

## Verification

The repository uses deterministic unit tests, mocked host integration,
generated-schema comparison, TypeScript checks against the pinned SDK and
distribution builds. The admission tests also exercise an independently
bundled Effect runtime to cover the real host/plugin parser and asynchronous
context boundary.

Verified on 25 November 2026 with Bun 1.4.4:

| Check | Result |
|---|---|
| `bun test` | 6,443 passed, 9 skipped, 0 failed across 305 files; all 7 snapshots passed |
| `bun run check:ci` | Passed across 692 files |
| `bun run typecheck` | Passed against the pinned OpenCode 2.4.1 contracts |
| `bun run build` | Passed; server, TUI, CLI, marketplace contract, declarations and generated schema built |
| `bun run verify:release` | Passed: packed artifact installed into a clean project, public entry points imported and marketplace declarations checked |
| `bun run verify:optional-loading` | All 11 mock-host scenarios passed with zero network requests; disabled features stayed cold |
| `git diff --check` | Passed |

Eight skipped cases require a Unix socket listener, which this verification
workspace denies with `EPERM`; the fixture skips only after confirming an
explicit permission error and retains actual socket coverage on capable hosts.
The ninth skip is the Windows-only drive-relative path scenario on Linux.

The repository's runtime-test policy requires a direct user request before
starting a real OpenCode process. This port therefore does not claim a live
OpenCode end-to-end run. The release build, static host contract checks and
mocked native scenarios are the verification boundary.
