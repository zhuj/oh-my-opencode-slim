# Background Orchestration

Slim is a specialist operating model over **native OpenCode 2.4+ subagents**.
OpenCode owns child execution, continuation, steering, durable Jobs, completion
admission and restart recovery. Slim supplies routing/coordination policy and
optional on-demand controls, not another job ledger.

## Lifecycle modes

`backgroundJobs.mode` selects Slim's tool surface. Native subagents are
available in every mode.

| Mode | Slim controls | Session-preset routing default |
|---|---|---|
| Omitted or legacy `managed` | Admission queue, retained listing, and native task controls | Enabled |
| `native` | `task_status`, `task_cancel`, `task_reply`, child `task_report` | Enabled |
| `off` | None | Disabled |

`backgroundJobs.queue.enabled` overrides queue enablement in the first two
rows. An explicit `native` mode also enables admission when
`backgroundJobs.concurrency` is present. `off` always disables the queue.

`sessionPresetRouting` independently selects session-only inference snapshots.
With routing off, native delegation uses the registered agent configuration.
The startup `preset` selects that configuration. Council
seat assembly and Observer do not depend on task controls or session routing.
See [Configuration](configuration.md#minimal-setup) for a minimal setup.

See [Upgrading](installation.md#upgrading) for the retired board, aliases,
reusable-session pool, watchdog and periodic wake settings.

## Coordination policy

The Orchestrator plans, delegates, reconciles and verifies. It can do small,
clear work directly when it already has the context. Context-heavy documentation
and summaries stay with the owner holding that context instead of forcing a new
specialist to rediscover it.

For delegated work:

1. Identify dependencies and the final evidence needed. Use only enough planning
   to avoid wasted work and conflicting edits.
2. Dispatch independent lanes in parallel. Each writer owns a disjoint scope;
   review the state a reviewer is actually being asked to assess.
3. Make each brief self-contained: goal, constraints, paths/lines, allowed edits,
   validation owner and expected evidence. Preserve a user-directed specialist
   request verbatim, separate from the caller's interpretation.
4. Keep each returned session ID and continue only independent work. Submission
   is not completion; use native completion delivery rather than polling.
5. Inspect results/artifacts against the request. Missing scope and out-of-scope
   changes are defects. Continue the same child for repairs rather than create a
   fresh lane to reload its context.
6. Reconcile every writer before final checks. Lanes run focused checks; final
   verification runs once at the settled state, proportionate to risk. Require
   commands, exit statuses, evidence and explicit skips; revalidate after edits.

Oracle and Council reviews are for material risk, unresolved uncertainty or
high-cost judgment, not an automatic extra lane on every task. Role-specific
routing lives in the agent prompts; [Council](council.md) describes independent
seat synthesis.

## Native completion and continuation

Native execution returns with a `sessionID` after admission. OpenCode reports
each settled child period through a `<background-result kind="subagent">`
message. The `sessionID` continues the same child, whether running or settled.
The host also reports later direct child prompts, not only calls through the
subagent tool. A busy parent receives a steer at its next step boundary; an idle
parent can receive a successor turn.

A returned ID or accepted report is not proof that work finished or that the
parent consumed the output. Treat specialist summaries as claims and verify the
produced artifacts. Slim adds no duplicate completion message.

[Tools](tools.md#background-task-control) owns the argument and result contracts
for optional controls. Their ownership is narrower than native APIs:

- Status is an exact owned-child read after a missing result, not a poll loop;
  missing or ambiguous evidence stays `unknown`.
- Cancellation asks native interruption while retaining the session. Acceptance
  is not confirmed cleanup, rollback or deletion; an idle interrupt is a no-op.
- Parent replies answer **permissions**, not V2 question forms. Questions use
  the host UI; child question tools are denied by default unless configured.
- A child report is a bounded material milestone/blocker admitted to its owning
  parent's native inbox. It requests a wake unless that parent was interrupted;
  acceptance does not confirm processing.

## Admission and dependencies

With the queue enabled, use optional `id` and `depends_on` fields on native
`subagent`. Submit the prerequisite first.

```json
{"agent":"explorer","description":"Inspect API contract","prompt":"Inspect the API contract","id":"inspect-api"}
```

```json
{"agent":"fixer","description":"Implement API change","prompt":"Implement the approved API change","id":"implement-api","depends_on":["inspect-api"]}
```

The native call begins when every required admission succeeds and capacity is
available. Dependency-blocked admissions use no capacity. Errors and
cancellations fail queued or postponed descendants. A plain `sessionID`
follow-up to an active child steers that native run. Supplying `id` or
`depends_on` gives the follow-up its own admission and ties its result to the
exact prompt that the host promoted.

Logical IDs and generated `admission-N` IDs are scoped to the calling parent.
Logical IDs start with an ASCII letter or digit and contain up to 128 letters,
digits, periods, underscores, colons or hyphens. The `admission-N` namespace is
reserved. Missing `id` uses the generated ID. Validation rejects duplicate IDs
or edges, forward or cross-parent references, self-references, cycles and
dependency arrays over 256 before starting native work. Native output retains
its `sessionID`. Slim adds `id` and `admission_id` to tool text and metadata.

| Tool | Use |
|---|---|
| `task_queue_list` | Inspect parent-owned admissions, queue positions, prerequisites, outcomes and native child IDs |
| `task_queue_manage` | Postpone, resume, cancel or clear queued work, pause parent admission, edit prerequisites or set a shared limit |
| `task_wait` | Wait for 1–128 parent-owned logical or admission IDs to all succeed. Aborting the wait leaves the tasks available |
| `task_dependency_tree` | Inspect up to 32 roots and depth 0–64. The result reports truncation when its 128-node, 512-edge or 65,536-byte budget is reached |
| `task_list` | Read retained native child sessions and their stored outcomes in bounded parent-filtered pages |

Dependency edits apply only to queued or postponed records. Queue cancellation
applies to that same state. Use the native session ID with `task_cancel` to
interrupt running work. `task_wait` wakes on admission changes and fails when a
requested record is unknown, errored or cancelled. `task_queue_manage`
requires `confirm_global: true` to change directory-wide limits. A lower cap
affects subsequent admissions.

The most specific configured cap wins in the order model, provider, default.
A value of 0 leaves that tier unlimited. Native nested calls share the
initiating task's reservation and keep their parent-local prerequisite and
pause checks. OpenCode applies its own nesting and permission rules. With a
positive cap, the first queued call reads up to 500 retained session rows to
reserve capacity for open native child executions. An invalid or incomplete
read rejects that submission and allows a later read to retry. Recovered
capacity has no logical dependency ID.

Slim retains terminal admissions for up to one hour under soft limits of 1,024
per parent and 4,096 per directory. Live dependency chains, open waiters and
pending call results pin their records. A retired logical ID can be reused
after eviction. Generated IDs increase for the life of the process. Admission
records and their dependency edges are process-local. Native Jobs and child
sessions retain the host's recovery behavior.

`task_list` projects native session IDs, agents, session titles, stored states
and ISO timestamps. Pages follow the host's oldest-updated-first ordering.
Include the returned `next_cursor` and `next_offset` to continue a bounded
search. The cursor belongs to the requesting parent and current server process.
Native state filters are `running`, `completed`, `error`, `cancelled` and
`unknown`. Historical board aliases and `stopped` / `reconciled` states have
no native listing fields.

`/queue` toggles a sidebar section for the current parent when the TUI, sidebar
and admission queue are enabled. It shows at most five queued or postponed
admissions, totals and pause state. It reads a project-scoped display snapshot
with admission IDs and scheduling metadata. `disabled_commands: ["queue"]`
disables the toggle independently.

The `observation_error` field indicates that Slim accepted a native child
without observing the exact prompt, such as after a move to a location where
Slim's queue is disabled. The native session remains available for status and
continuation. When a terminal event and native idle read confirm that capacity
is free, the admission ends with an error so dependent work stays blocked by
the missing proof.

## Task-fit rejections

A specialist receiving work outside its role returns a brief reason instead of
attempting partial implementation. The Orchestrator reroutes or clarifies the
request; it does not resend the same unchanged work to that specialist.

Coordination needs only the facts supporting the request: child ID, specialist,
objective, write scope, dependencies and result. These belong to the task brief
and conversation, not a second plugin-side state machine.

## Cancellation, restart and uncertainty

OpenCode owns cleanup and terminal publication. Cancellation does not undo
partial edits. If a transport read or interruption request times out, it may
still land; retain that uncertainty instead of manufacturing a terminal state.

The native recovery sweep can resume running Jobs and deliver pending outbox
reports. It is **at-least-once**, not exactly-once for external effects. A saved
Job is not proof that recovery ran, and an embedding that does not run the sweep
gets no substitute from Slim. Do not blindly repeat an uncertain continuation.

Slim does not import old board records into Jobs or write a V2 tombstone/delivery
ledger. Native reload cancels pending permissions/forms; continued work may need
to ask again. When a result cannot be established, report the missing evidence.

## Verification

The end-to-end result is accepted only after relevant lanes are settled,
reconciled and supported by final-state evidence. Tool submission, a status read
and a host completion event each prove different things; none proves output
quality by itself.

`scripts/verify-v2-native-lifecycle.ts` exercises the packed plugin against its
specified real host with a mock provider, including off-mode Council/Observer.
That validates routing and request construction, not external model quality or
all restart race windows. Cache properties and optional-loading checks cover the
separate invariants described in [Runtime Efficiency](runtime-efficiency.md)
and [Cache Verification](cache-verification.md).
