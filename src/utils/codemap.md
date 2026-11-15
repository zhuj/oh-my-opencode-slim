# src/utils/

**Last Updated:** 2026-11-15

## Responsibility

Centralized utilities and shared abstractions used across the oh-my-opencode-slim plugin. This folder provides:

- **Background Job Lifecycle Management**: Singleton registry, lifecycle management, persistence, and supervision for background tasks spawned by sub-agents
- **Session Management**: Session status tracking, metadata, selection, and timeout/abort utilities
- **Background Task Concurrency**: Process-local admission scheduler for native background task launches
- **Evidence & Transcript Handling**: Child session transcript evidence extraction, terminal evidence verification, and session info reads
- **Projection & State Management**: TUI projection for sidebar state from board records
- **Infrastructure Utilities**: Logging with rotation, environment parsing, configuration, type guards, validation, and global store patterns
- **Platform Compatibility**: Cross-platform spawn, zip extraction, and native runtime probes
- **Data Processing & Security**: Secret redaction, XML/HTML escaping, frontmatter parsing, and task output parsing

## Design

### Core Abstractions

- **BackgroundJobBoard** (`background-job-board.ts`): Singleton registry and lifecycle manager for background tasks with reusable session pool patterns, automatic cleanup, and reconciliation hooks. Also owns the terminal-outcome subscription fan-out, launch-identity projection, and the process-local lifecycle ledger (tombstones, deletion epochs, suppression write-through). The board is never rendered: records retain run/activity/publication fences and observed status, not render-age or generic update timestamps.
- **BackgroundJobSupervisor** (`background-job-supervisor.ts`): One-shot wall-clock watchdog with timer/generation/abort mechanics; on expiry it aborts the child through the same lease-guarded host primitive `task_cancel` uses and never publishes a terminal itself
- **BackgroundJobSnapshotStore** (`background-job-snapshot-store.ts`): Shared V1/V2 best-effort filesystem snapshots of retained board records, one versioned SHA-256-keyed file per top-level root session under `<project>/.local/.slim/background-jobs/`; nested tasks share that file and retain their immediate parent IDs. Per-root locks and temporary-file rename serialize updates; the task-session manager suppresses writes after a failed whole-store load.
- **Pending-input ownership** (directly in `background-job-board.ts`): An unresolved exact prompt ID marks retained admission as uncertain and prevents unowned launch/reset. Rollback restores the captured predecessor only under its exact lease and unchanged-record fence; the terminal gate requires evidence bound to the queued input.
- **BackgroundTaskConcurrency** (`background-task-concurrency.ts`): Directory-scoped process-local admission scheduler for native background launches; model/provider capacity, queued/postponed controls, parent pause, dependency readiness, and exact cancellation ownership. Settled operational entries release callbacks and native-call bindings.
- **Task graph/state** (`background-task-state.ts`, `background-task-state-types.ts`, `background-task-dependencies.ts`): Parent-scoped logical IDs and monotonic admission IDs, atomic dependency updates, reverse dependency indexes, failure propagation, and bounded unresolved-prerequisite diagnostics.
- **Task waiting/inspection** (`background-task-wait.ts`, `background-task-admission-wait.ts`, `background-task-dependency-tree.ts`): Notification-based waits with abort cleanup, retained admission ownership fences, and deterministic breadth-first graph output bounded by node/edge/depth/UTF-8 budgets.
- **Task retention** (`background-task-retention.ts`, `background-task-limits.ts`): Terminal scheduler history uses one-hour, 1,024-per-parent, and 4,096-per-runtime soft bounds; live work, active waiters, lifecycle owners, and their prerequisite chains stay pinned. Cleanup runs on publication/ownership changes without a timer.
- **Runtime Session Status** (`session-runtime-status.ts`): Reads and validates the in-process OpenCode session-status map with absent/unknown distinction; reduces the `session.get` outcome/idleAt projection to terminal/pending/unknown verdicts for v2 recovery triage (`hostRoundStateOf`), and classifies one live session for a probe (`classifyLiveSession`: `running`/`idle`/an attributable host terminal outcome read through a bounded, timer-injectable shared host read on hosts without the map).
- **Session Info Read** (`session-info-read.ts`): Single-flight raw `session.get` per client session domain and task id, shared by the probe, the ownership gate, and the gate's rehydration observer; a consumer deadline releases only its waiter, never the underlying read, and a differing identity is refused while the read is open (`raceEvidenceDeadline` bounds waits deterministically).
- **Session Metadata** (`session-metadata.ts`): Bounded session → agent/directory map with LRU eviction and active orchestrator protection
- **Session Selection** (`session-selection.ts`): Session selection resolution with provenance tracking (host-persisted, observed-external, unknown)
- **Child Transcript** (`child-transcript.ts`): Child session transcript evidence extraction and terminal evidence classification; the startup historical idle classifier complements on-demand host-outcome attribution. A marker-free migrated v1 history retains its v1 closure for startup and untracked reads; v2 lifecycle markers keep the idle boundary mandatory. Shared latest-input/text helpers reject malformed history rather than skipping it. Diagnostic tails enforce UTF-8 budgets in one pass.
- **Host Transcript Attribution** (`child-transcript.ts`, `attributeHostRoundToTranscript`): Validates parsed host terminal evidence against assistant creation/completion after the latest delivered input; newer activity stays pending and unreadable timestamps stay unknown. Recovery and untracked reads retain the shared host-round parser/composer.
- **BackgroundJobTerminalGate** (`background-job-terminal-gate.ts`): Terminal evidence verification with host outcome attribution, reading leases, and a bounded two-tier evidence re-arm (fast `graceMs` retries, then exponential slow re-arms) that is armed only on hosts where no polling reconciler owns recovery
- **BackgroundJobPersistence** (`background-job-persistence.ts`): Optional V2 `ctx.storage` lifecycle metadata: launch identities, delivery markers, tombstones, deletion epochs, suppression, and alias high-water marks; distinct from filesystem board snapshots
- **BackgroundJobFixture** (`background-job-fixture.ts`): Test-only board fixtures for adapter/state-machine tests (not for production)
- **TestTimers** (`test-timers.ts`): Test-only deterministic timer harness (manual clock, injected `setTimeout`/`clearTimeout` seams, zero-duration `tick` drain); wire into timer-seam components, see AGENTS.md "Test Time"
- **Test scratch policy**: Allocate test scratch roots through `src/test-utils.ts` (`withTmpDir`, `withTmpDirSync`, or `createTmpDir` with `removeTmpDir`), not repository-local or hardcoded paths; see AGENTS.md "Test Scratch Directories".
- **TUI Reusable Projection** (`tui-reusable-projection.ts`): Board → tui-state sidebar display projection, not task/session mapping storage
- **JSDOM Probe** (`jsdom.ts`): JSDOM runtime detection without making it a prerequisite
- **Redact** (`redact.ts`): Shape-based secret redaction for logging and task output structure masking

### Reuse and Publication

Board lookup/boolean queries iterate directly without sorting; ordered list and
history semantics remain unchanged, including historical alias collisions.
`tui-reusable-projection.ts` reads one board snapshot and defers repeated
mutations within `withTuiSnapshotBatch` to one final projection. Ownership is
updated only after commit, and disposed publishes cannot reappear.
`package-root.ts` finds the running package by its ancestor chain (including
nested chunks), never sibling cache entries. `version.ts` shares numeric
comparison without merging callers' distinct parsing/update policies.

### Session & Task Utilities

- **Session** (`session.ts`): Timeout handling, session abort coordination, and model reference parsing
- **Prompt Agent** (`prompt-agent.ts`): Resolves explicit v1 prompt identity from safe hints, session records, or a bounded user-message tail; rejects internal system agents and suppresses unresolved targets. `withAgent` never constructs an agent-less body; the adjacent test scans v1 prompt call sites.
- **Task** (`task.ts`): XML-inspired task output parsing for extracting task IDs, states, and results; header-only parsing avoids reading result bodies when only identity and state are needed
- **Agent Variant** (`agent-variant.ts`): Agent name normalization (trim/@ prefix) and display name rewriting utilities

### Infrastructure & Security Utilities

- **Logger** (`logger.ts`): Process-wide file logging (one pid-suffixed file per process) with 7-day retention, directory creation, and write queuing
- **Environment** (`env.ts`): Environment variable parsing and plugin disable flag checking
- **Global Store** (`global-store.ts`): Process-local lazy singleton on globalThis with Symbol.for keyed registry
- **Event Directory Scope** (`event-directory-scope.ts`): Per-location event scope for multi-instance hosts — process-local live-directory registry plus a session→directory map, fail-open on unresolved events
- **Internal Initiator** (`internal-initiator.ts`): Marker and strict native-background-notification recognition for internally-initiated agent messages
- **System Collapse** (`system-collapse.ts`): System message collapsing by joining with double-newlines
- **Compat** (`compat.ts`): Cross-platform spawn with output collection and Windows command resolution
- **PID File Lock** (`pid-file-lock.ts`): Cross-process PID-guarded directory lock with owner-token-guarded release (compare-then-delete), atomic stale-owner takeover (rename), young-lock fallback, live-owner age cap, and sync (`Atomics.wait`, off-main-thread only) plus async (`setTimeout`) retry wrappers
- **Zip Extractor** (`zip-extractor.ts`): Cross-platform zip extraction with Windows-aware fallbacks
- **Escape HTML** (`escape-html.ts`): HTML escaping helper for interview UI
- **Frontmatter** (`frontmatter.ts`): Frontmatter parsing for interview documents
- **Guards** (`guards.ts`): Type checking utilities (isRecord) for runtime validation

### Design Patterns

- **Singleton**: BackgroundJobBoard is a singleton registry with global state
- **Strategy**: Task parsing adapts to multiple output formats (XML tags, plain text headers)
- **Observer**: Logger uses write queuing to avoid blocking
- **Projection**: Board changes trigger TUI state projections
- **Utility**: Each utility module provides focused, composable functions

## Flow

### Background Job Lifecycle

1. Agent launches a background task via BackgroundJobBoard.registerLaunch() (watchdog arms wall-clock deadline)
2. Task runs and updates status via BackgroundJobBoard.updateStatus()
3. On completion/error/cancellation, task is marked terminal and added to reusable pool; watchdog timers cleared
4. Subsequent tasks reuse completed sessions via aliases
5. Unused reusable sessions are automatically trimmed based on maxReusablePerAgent
6. Deadline exceeded during execution → watchdog aborts the child via the host; the host's real terminal evidence publishes the run

### Task/Session Snapshot Recovery

1. The task-session manager loads valid root snapshots into the board before exposing task-board operations; load failure leaves the in-memory board usable but suppresses snapshot writes to avoid replacing prior data.
2. Previously running records restore as non-running (`stopped`, status uncertain). A positive `session.get` proves existence, not activity; absent APIs, malformed/empty status, and ambiguous V1 errors preserve the mapping. Only a typed V2 `Session.NotFoundError` for the same generation proves deletion.
3. Board mutations are coalesced per root and written through the shared filesystem store on a best-effort basis; disposal detaches the listener and drains accepted writes. Board retention and session deletion remove records; the root file disappears only when no records remain. Neither optional V2 lifecycle metadata nor TUI projections replace these board snapshots or prove cross-host liveness.

### Session Selection Flow
1. resolveCurrentSelection() reads session.get() with bounded timeout
2. Falls back to metadata store if host read hangs or fails
3. Resolves model selection with provenance tracking

### Child Transcript Flow
1. fetchChildTranscript() retrieves child session messages via SDK
2. classifyAssistantTurnEvidence() evaluates each turn for completion
3. verdictFromEvidence() produces terminal evidence verdict

### Logging Flow
1. The first plugin instance in a process calls initLogger() — the sink is
   process-global, and re-initializing in the same log directory is a no-op
2. Logs appended to ~/.local/share/opencode/log/oh-my-opencode-slim.<stamp>-<pid>.log
   (client processes use the `tui-` tag)
3. Old logs (>7 days) cleaned up once per process initialization
4. Write queuing prevents blocking; fallback to stderr on failure

### Redaction Flow
1. redactSecretsForLog() applies token masking and structure-preserving value hiding
2. Pattern-based token redaction keeps 4 leading + 2 trailing characters
3. XML/HTML/structured format masking fully hides values behind [masked] placeholder

## Integration

### Consumers

- **Council Agents** (`src/agents/council.ts`, `src/agents/council-agents.ts`):
  - Uses BackgroundJobBoard for background task management
  - Uses logger for debug and audit logging

- **Multiplexer** (`src/multiplexer/`):
  - Uses session utilities for session operations
  - Uses logger for session lifecycle events

- **Agents** (`src/agents/`):
  - BackgroundJobBoard for launching and tracking background tasks
  - Logger for agent-specific logging

- **Main Plugin** (`src/index.ts`):
  - Exports all utilities via `src/utils/index.ts`
  - Uses logger for plugin lifecycle events

### Dependencies

- **Node.js built-ins**: `fs`, `fs/promises`, `os`, `path` for logging and file operations
- **@opencode-ai/sdk**: PluginInput type for session utilities

### Export Chain

`src/utils/index.ts` re-exports all utilities, providing a single entry point:

```typescript
export * from './agent-variant';
export * from './background-job-board';
export * from './background-job-persistence';
export * from './background-job-supervisor';
export * from './background-task-concurrency';
export * from './internal-initiator';
export { initLogger, log } from './logger';
export * from './polling';
export * from './redact';
export * from './session';
export * from './session-runtime-status';
export * from './task';
export { extractZip } from './zip-extractor';
```

This allows consumers to import from `src/utils` rather than individual files.
The snapshot store is imported directly by the task-session manager. Session
metadata, the opencode client accessor, and the type-only call-shape contract
are also imported directly from their modules (not re-exported).

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API re-exporting most utilities |
| `agent-variant.ts` | Agent name normalization and regex escaping |
| `background-job-board.ts` | Background task registry, lifecycle manager, terminal-outcome subscriptions, launch-identity projection, and lifecycle ledger |
| `background-job-supervisor.ts` | Wall-clock watchdog: one timer per run, host abort on expiry |
| `background-task-concurrency.ts` | Directory scheduler, capacity, queue controls, and lifecycle ownership |
| `background-task-state.ts`, `background-task-state-types.ts` | Admission records, logical aliases, and state transitions |
| `background-task-dependencies.ts` | Atomic graph validation, readiness indexes, and failure propagation |
| `background-task-dependency-tree.ts` | Bounded deterministic dependency inspection |
| `background-task-wait.ts`, `background-task-admission-wait.ts` | Notification-based terminal/admission waits with abort cleanup |
| `background-task-retention.ts`, `background-task-limits.ts` | Soft terminal-history bounds, dependency pins, and shared resource limits |
| `background-job-persistence.ts` | Persistence for lifecycle state (tombstones, deletion) |
| `background-job-terminal-gate.ts` | Terminal evidence verification and attribution; bounded two-tier evidence re-arm for late-attributable host outcomes (shim hosts only — `runtime-status-reconciliation.ts` owns recovery where `session.status` exists) |
| `background-job-snapshot-store.ts` | Shared V1/V2 per-root filesystem snapshots of retained task/session board records |
| `background-job-fixture.ts` | Test-only board fixtures for adapter/state-machine tests |
| `test-timers.ts` | Test-only deterministic timer harness for seam-wired timer code |
| `tui-reusable-projection.ts` | Board → tui-state projection for sidebar reusable dots |
| `session.ts` | Session timeout, abort, and model-reference utilities |
| `session-metadata.ts` | Bounded session → agent/directory store |
| `session-runtime-status.ts` | Bounded live session-status map reads; on-demand host round-state verdicts from the session info projection, with transcript text bound to the host idle |
| `session-selection.ts` | Session selection resolution with provenance |
| `child-transcript.ts` | Child session transcript evidence extraction; v1/startup idle classification, on-demand v2 binding of latest input and assistant text to the host idle (malformed entries fail closed) |
| `jsdom.ts` | JSDOM runtime detection without prerequisite |
| `redact.ts` | Shape-based secret redaction for logging |
| `logger.ts` | Process-wide file logging (pid-suffixed) |
| `event-directory-scope.ts` | Per-location event scope for multi-instance hosts |
| `env.ts` | Environment variable parsing and plugin disable checking |
| `global-store.ts` | Process-local lazy singleton store on globalThis |
| `internal-initiator.ts` | Internal agent message marker system |
| `system-collapse.ts` | System message collapsing utility |
| `compat.ts` | Cross-platform spawn and Windows command resolution |
| `pid-file-lock.ts` | Cross-process PID-guarded directory lock with owner-token-guarded release, stale-owner recovery and age cap |
| `zip-extractor.ts` | Cross-platform zip extraction |
| `escape-html.ts` | HTML escaping helper |
| `frontmatter.ts` | Frontmatter parsing for interview documents |
| `guards.ts` | Type checking utilities |
| `task.ts` | Task output parsing utilities |
| `polling.ts` | Delay helper |
| `councillor-models.ts` | Pure zod-free helpers normalizing councillor model fallback chains (single model or ordered `id`/`variant` entries) |
| `opencode-client.ts` | In-process opencode client accessor (imported directly, not re-exported) |
| `session-calls.contract.ts` | Type-only client call-shape contract (imported directly, not re-exported) |
