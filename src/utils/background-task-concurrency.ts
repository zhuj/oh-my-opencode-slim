// Consolidated scheduler module — co-located v3.0.3 admission/schedule/policy + HEAD core/management/scheduler + pump/plan helpers.
// Direct imports preserved; split implementation files superseded (deleted after reference audit).

import {
  evaluateTaskDependencies,
  TaskDependencyError,
} from './background-task-dependencies';
import type { BackgroundTaskRetentionLimits } from './background-task-retention';
import type {
  BackgroundTaskRecord,
  BackgroundTaskTerminalState,
} from './background-task-state';
import {
  BackgroundTaskNotFoundError,
  BackgroundTaskStateStore,
  BackgroundTaskTransitionError,
} from './background-task-state';
import { BackgroundTaskWaiters } from './background-task-wait';

export type BackgroundTaskQueueAction = 'postpone' | 'resume' | 'cancel';

export type BackgroundTaskQueueSnapshot = {
  readonly record: BackgroundTaskRecord;
  readonly queuePosition?: number;
};

export type BackgroundTaskConcurrencyLimitUpdate =
  | { readonly tier: 'default'; readonly limit: number }
  | { readonly tier: 'provider'; readonly key: string; readonly limit: number }
  | { readonly tier: 'model'; readonly key: string; readonly limit: number };

export interface BackgroundTaskConcurrencyConfig {
  defaultConcurrency: number;
  providerConcurrency: Readonly<Record<string, number>>;
  modelConcurrency: Readonly<Record<string, number>>;
}

export interface BackgroundTaskConcurrencyRequest {
  /** Pending lifecycle owner releases its history pin via releaseIfUnbound. */
  readonly retainRecord?: boolean;
  readonly id?: string;
  readonly dependsOn?: readonly string[];
  readonly background?: boolean;
  readonly bypassCapacity?: boolean;
  model?: string;
  parentSessionID?: string;
  previousSessionID?: string;
}

export interface BackgroundTaskConcurrencyTicket {
  readonly id: string;
  readonly ready: Promise<void>;
  bind(taskID: string): void;
  postpone(): void;
  resume(): void;
  cancel(): void;
  snapshot(): BackgroundTaskRecord;
  release(): void;
  releaseIfUnbound(): void;
}

export interface BackgroundTaskConcurrencyOptions {
  readonly retention?: BackgroundTaskRetentionLimits;
  readonly now?: () => number;
  readonly onQueueChange?: () => void;
}

export interface BackgroundTaskConcurrencyController {
  setDependencies(
    admissionID: string,
    parentSessionID: string,
    ids: readonly string[],
  ): BackgroundTaskRecord;
  waitForTasks(
    parentSessionID: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundTaskRecord[]>;
  get(admissionID: string): BackgroundTaskRecord | undefined;
  list(parentSessionID?: string): BackgroundTaskRecord[];
  listQueue(parentSessionID?: string): BackgroundTaskQueueSnapshot[];
  postpone(admissionID: string): void;
  resume(admissionID: string): void;
  cancel(admissionID: string): void;
  manageAdmission(
    admissionID: string,
    parentSessionID: string,
    action: BackgroundTaskQueueAction,
  ): BackgroundTaskRecord;
  clearQueued(parentSessionID: string): string[];
  pauseAdmissions(parentSessionID: string): void;
  resumeAdmissions(parentSessionID: string): void;
  isAdmissionPaused(parentSessionID: string): boolean;
  configSnapshot(): BackgroundTaskConcurrencyConfig;
  updateLimit(
    update: BackgroundTaskConcurrencyLimitUpdate,
  ): BackgroundTaskConcurrencyConfig;
  releaseTask(taskID: string, state?: BackgroundTaskTerminalState): void;
}

export class BackgroundTaskOwnershipError extends Error {
  readonly name = 'BackgroundTaskOwnershipError';

  constructor(
    readonly admissionID: string,
    readonly parentSessionID: string,
  ) {
    super(`Unknown or unowned background task admission: ${admissionID}`);
  }
}

export interface BackgroundTaskAdmissionDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createBackgroundTaskAdmissionDeferred(): BackgroundTaskAdmissionDeferred {
  let resolveDeferred: (() => void) | undefined;
  let rejectDeferred: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  // Callers may intentionally ignore readiness for fire-and-forget work. Keep
  // cancellation from surfacing as an unhandled rejection; consumers awaiting
  // the original promise still observe its rejection normally.
  void promise.catch(() => undefined);
  if (!resolveDeferred || !rejectDeferred) {
    throw new Error('Failed to initialize background task admission promise');
  }
  let settlement: 'pending' | 'resolved' | 'rejected' = 'pending';
  return {
    promise,
    resolve: () => {
      if (settlement !== 'pending') return;
      settlement = 'resolved';
      const resolve = resolveDeferred;
      resolveDeferred = undefined;
      rejectDeferred = undefined;
      resolve?.();
    },
    reject: (error) => {
      if (settlement !== 'pending') return;
      settlement = 'rejected';
      const reject = rejectDeferred;
      resolveDeferred = undefined;
      rejectDeferred = undefined;
      reject?.(error);
    },
  };
}

export class BackgroundTaskConcurrencyQueueCancelledError extends Error {
  constructor() {
    super('Background task concurrency queue was cancelled');
    this.name = 'BackgroundTaskConcurrencyQueueCancelledError';
  }
}

// ===== POLICY =====

export type ConcurrencyTier = 'model' | 'provider' | 'default';

export interface CapacityEntry {
  tier: ConcurrencyTier;
  key: string | undefined;
  limit: number;
}

export class BackgroundTaskCapacity {
  private readonly activeByKey = new Map<string, number>();
  private activeDefault = 0;

  constructor(private config: BackgroundTaskConcurrencyConfig) {}

  updateConfig(config: BackgroundTaskConcurrencyConfig): void {
    this.config = config;
  }

  resolve(model: string | undefined): CapacityEntry {
    const normalized = normalizeModel(model);
    if (normalized !== undefined) {
      const modelLimit = this.config.modelConcurrency[normalized];
      if (modelLimit !== undefined) {
        return {
          tier: 'model',
          key: normalized,
          limit: enabledLimit(modelLimit),
        };
      }
      const provider = providerFromModel(normalized);
      if (provider !== undefined) {
        const providerLimit = this.config.providerConcurrency[provider];
        if (providerLimit !== undefined) {
          return {
            tier: 'provider',
            key: provider,
            limit: enabledLimit(providerLimit),
          };
        }
      }
    }
    return {
      tier: 'default',
      key: undefined,
      limit: enabledLimit(this.config.defaultConcurrency),
    };
  }

  canStart(entry: CapacityEntry): boolean {
    if (entry.limit === Infinity) return true;
    if (entry.tier === 'default') return this.activeDefault < entry.limit;
    return (this.activeByKey.get(entry.key ?? '') ?? 0) < entry.limit;
  }

  track(entry: CapacityEntry): void {
    if (entry.limit === Infinity) return;
    if (entry.tier === 'default') {
      this.activeDefault += 1;
      return;
    }
    increment(this.activeByKey, entry.key);
  }

  untrack(entry: CapacityEntry): void {
    if (entry.limit === Infinity) return;
    if (entry.tier === 'default') {
      this.activeDefault -= 1;
      return;
    }
    decrement(this.activeByKey, entry.key);
  }
}

export function normalizeModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value || undefined;
}

export function providerFromModel(
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : undefined;
}

function enabledLimit(limit: number | undefined): number {
  return typeof limit === 'number' && limit > 0 ? limit : Infinity;
}

function increment(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string | undefined): void {
  if (!key) return;
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

// ===== PUMP =====

export interface PumpContext {
  isDisposed(): boolean;
  getScanEpoch(): number;
  readonly waiting: QueueEntry[];
  readonly active: Set<QueueEntry>;
  readonly entriesByID: Map<string, QueueEntry>;
  readonly pausedParentSessionIDs: Set<string>;
  readonly tasks: BackgroundTaskStateStore;
  readonly capacity: BackgroundTaskCapacity;
  readonly isRecordPaused: (record: BackgroundTaskRecord) => boolean;
  readonly publish: () => void;
  readonly requireSnapshot: (admissionID: string) => BackgroundTaskRecord;
}

export function runPump(ctx: PumpContext): void {
  if (ctx.isDisposed()) return;
  const classify = () =>
    classifyWaiting({
      scanEpoch: ctx.getScanEpoch(),
      waiting: ctx.waiting,
      requireSnapshot: (id: string) => ctx.requireSnapshot(id),
      dependenciesOf: (record: BackgroundTaskRecord) =>
        record.dependsOn.map((dep: string) => ctx.requireSnapshot(dep)),
      isRecordPaused: (record: BackgroundTaskRecord) =>
        ctx.isRecordPaused(record),
      capacityCanStart: (entry: QueueEntry) => ctx.capacity.canStart(entry),
    });
  let plan = classify();
  // Cursor is only stable within this epoch; entries lost before it are
  // inadmissible, and tracked capacity only grows, so nothing earlier
  // can become admissible without a rebuild.
  let cursor = 0;
  while (!ctx.isDisposed()) {
    if (plan.epoch !== ctx.getScanEpoch()) {
      plan = classify();
      cursor = 0;
    }
    const blocked = plan.blocked;
    if (blocked) {
      failBlockedEntry(blocked, {
        waiting: ctx.waiting,
        entriesByID: ctx.entriesByID,
        tasks: ctx.tasks,
        publish: () => ctx.publish(),
      });
      // The failure moves a record to a terminal state its dependents
      // classify against, and that publication is the pump's own, so the
      // rebuild is explicit rather than epoch-driven.
      plan = classify();
      cursor = 0;
      continue;
    }
    let entry: QueueEntry | undefined;
    while (cursor < ctx.waiting.length) {
      const candidate = ctx.waiting[cursor];
      if (
        candidate &&
        plan.admissible.has(candidate) &&
        !candidate.released &&
        (candidate.bypassCapacity || ctx.capacity.canStart(candidate))
      ) {
        entry = candidate;
        break;
      }
      cursor += 1;
    }
    if (!entry) return;
    // Splice shifts the next entry into cursor, so it is re-examined
    // without rewinding entries already proven inadmissible.
    ctx.waiting.splice(cursor, 1);
    ctx.tasks.transition(entry.id, 'starting');
    ctx.active.add(entry);
    if (!entry.bypassCapacity) ctx.capacity.track(entry);
    ctx.publish();
    if (!ctx.isDisposed() && !entry.released && ctx.active.has(entry)) {
      entry.resolve?.();
      entry.resolve = undefined;
      entry.reject = undefined;
    }
  }
}

// ===== PLAN =====

export interface BlockedWaitingEntry {
  readonly entry: QueueEntry;
  readonly dependencies: readonly BackgroundTaskRecord[];
}

export interface WaitingPlan {
  readonly epoch: number;
  readonly blocked: BlockedWaitingEntry | undefined;
  readonly admissible: ReadonlySet<QueueEntry>;
}

export interface WaitingPlanClassifierContext {
  readonly scanEpoch: number;
  readonly waiting: readonly QueueEntry[];
  requireSnapshot(id: string): BackgroundTaskRecord;
  dependenciesOf(record: BackgroundTaskRecord): BackgroundTaskRecord[];
  isRecordPaused(record: BackgroundTaskRecord): boolean;
  capacityCanStart(entry: QueueEntry): boolean;
}

export function classifyWaiting(
  ctx: WaitingPlanClassifierContext,
): WaitingPlan {
  const epoch = ctx.scanEpoch;
  const admissible = new Set<QueueEntry>();
  for (const entry of ctx.waiting) {
    const record = ctx.requireSnapshot(entry.id);
    const evaluation = evaluateTaskDependencies(ctx.dependenciesOf(record));
    if (evaluation.state === 'blocked') {
      return {
        epoch,
        blocked: { entry, dependencies: evaluation.dependencies },
        admissible,
      };
    }
    if (
      record.state === 'queued' &&
      (entry.bypassCapacity || !ctx.isRecordPaused(record)) &&
      evaluation.state === 'ready' &&
      (entry.bypassCapacity || ctx.capacityCanStart(entry))
    ) {
      admissible.add(entry);
    }
  }
  return { epoch, blocked: undefined, admissible };
}

export interface FailBlockedContext {
  readonly waiting: QueueEntry[];
  readonly entriesByID: Map<string, QueueEntry>;
  readonly tasks: BackgroundTaskStateStore;
  readonly publish: () => void;
}

export function failBlockedEntry(
  blocked: BlockedWaitingEntry,
  ctx: FailBlockedContext,
): void {
  const failed = blocked.entry;
  const error = new TaskDependencyError(
    'Task prerequisite failed',
    blocked.dependencies,
  );
  ctx.tasks.failDependency(failed.id, error);
  const index = ctx.waiting.indexOf(failed);
  if (index >= 0) ctx.waiting.splice(index, 1);
  failed.released = true;
  failed.reject?.(error);
  failed.resolve = undefined;
  failed.reject = undefined;
  ctx.entriesByID.delete(failed.id);
  ctx.publish();
}

// ===== CORE =====

export interface QueueEntry extends CapacityEntry {
  readonly id: string;
  readonly bypassCapacity?: boolean;
  released: boolean;
  taskID: string | undefined;
  resolve: (() => void) | undefined;
  reject: ((error: Error) => void) | undefined;
}

export class BackgroundTaskConcurrencyCore {
  protected readonly waiting: QueueEntry[] = [];
  private readonly waiters = new BackgroundTaskWaiters(() => this.cleanup());
  protected readonly active = new Set<QueueEntry>();
  protected readonly entriesByID = new Map<string, QueueEntry>();
  protected readonly activeByTaskID = new Map<string, QueueEntry>();
  protected readonly pausedParentSessionIDs = new Set<string>();
  protected readonly tasks: BackgroundTaskStateStore;
  protected readonly capacity: BackgroundTaskCapacity;
  private readonly onQueueChange: (() => void) | undefined;
  protected config: BackgroundTaskConcurrencyConfig;
  protected disposed = false;
  /**
   * Bumped by every queue notification except the pump's own publication.
   *
   * Waiting order, waiting record states, paused parents, capacity limits and
   * dependency edges all funnel through `notifyQueueChange`, so a bump is
   * exactly the signal that a classification pass must be rebuilt. Holding the
   * epoch across the pump's own publication is what keeps a burst of dequeues
   * from rescanning the queue, while any observer that reenters and mutates
   * still bumps it from inside that publication.
   *
   * Integration risk: a future mutation of waiting order or content, a waiting
   * record's state, `pausedParentSessionIDs`, capacity limits or dependency
   * edges that bypasses `notifyQueueChange` leaves a plan stale, exactly as it
   * would leave the management queue view stale.
   */
  private scanEpoch = 0;
  /**
   * Set only around the notification the pump raises for its own dequeue or
   * dependency failure. `notifyQueueChange` consumes it, so an observer that
   * notifies reentrantly still bumps the scan epoch.
   */
  private ownPublication = false;

  constructor(
    config: BackgroundTaskConcurrencyConfig,
    options: BackgroundTaskConcurrencyOptions = {},
  ) {
    this.config = snapshotConfig(config);
    this.tasks = new BackgroundTaskStateStore(options.now, options.retention);
    this.capacity = new BackgroundTaskCapacity(this.config);
    this.onQueueChange = options.onQueueChange;
  }

  updateConfig(config: BackgroundTaskConcurrencyConfig): void {
    this.config = snapshotConfig(config);
    this.capacity.updateConfig(this.config);
    for (const entry of this.active) {
      if (!entry.bypassCapacity) this.capacity.untrack(entry);
      this.updateEntryCapacity(entry);
      if (!entry.bypassCapacity) this.capacity.track(entry);
    }
    for (const entry of this.waiting) this.updateEntryCapacity(entry);
    this.pump();
    this.notifyQueueChange();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  get(admissionID: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(admissionID);
  }

  waitForTasks(
    parentSessionID: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackgroundTaskRecord[]> {
    return this.waiters.waitForTasks(this.tasks, {
      parentSessionID,
      ids,
      signal,
    });
  }

  list(parentSessionID?: string): BackgroundTaskRecord[] {
    return this.tasks.list(parentSessionID);
  }

  releaseTask(
    taskID: string,
    state: BackgroundTaskTerminalState = 'cancelled',
  ): void {
    const entry = this.activeByTaskID.get(taskID);
    if (entry) this.release(entry, state);
  }

  dispose(): void {
    if (this.disposed) {
      this.cleanup();
      return;
    }
    this.disposed = true;
    for (const entry of [...this.waiting, ...this.active]) {
      this.release(entry);
    }
    this.pausedParentSessionIDs.clear();
    this.cleanup();
  }

  cleanup(): void {
    this.tasks.compact(this.entriesByID.keys());
  }

  snapshot(): { active: number; queued: number } {
    return {
      active: [...this.active].filter((entry) => !entry.bypassCapacity).length,
      queued: this.waiting.filter(
        (entry) => this.tasks.get(entry.id)?.state === 'queued',
      ).length,
    };
  }

  protected bind(entry: QueueEntry, taskID: string): void {
    if (!this.active.has(entry) || entry.released || !taskID) return;
    if (entry.taskID === taskID) return;
    const existing = this.activeByTaskID.get(taskID);
    if (existing && existing !== entry) this.release(existing);
    if (entry.taskID !== undefined) {
      this.activeByTaskID.delete(entry.taskID);
    }
    entry.taskID = taskID;
    this.tasks.bind(entry.id, taskID);
    this.activeByTaskID.set(taskID, entry);
  }

  protected pump(): void {
    const ctx: PumpContext = {
      isDisposed: () => this.disposed,
      getScanEpoch: () => this.scanEpoch,
      waiting: this.waiting,
      active: this.active,
      entriesByID: this.entriesByID,
      pausedParentSessionIDs: this.pausedParentSessionIDs,
      tasks: this.tasks,
      capacity: this.capacity,
      publish: () => this.publish(),
      isRecordPaused: (record: BackgroundTaskRecord) =>
        this.isRecordPaused(record),
      requireSnapshot: (id: string) => this.requireSnapshot(id),
    };
    runPump(ctx);
  }

  /** Raises the notification the pump owns, keeping the scan epoch in place. */
  private publish(): void {
    this.ownPublication = true;
    try {
      this.notifyQueueChange();
    } finally {
      this.ownPublication = false;
    }
  }

  protected release(
    entry: QueueEntry,
    state: BackgroundTaskTerminalState = 'cancelled',
  ): void {
    if (entry.released) return;
    entry.released = true;
    this.tasks.terminal(entry.id, state);
    // Readiness can still be pending after admission leaves the waiting queue.
    entry.reject?.(new BackgroundTaskConcurrencyQueueCancelledError());
    entry.resolve = undefined;
    entry.reject = undefined;
    this.entriesByID.delete(entry.id);
    const waitingIndex = this.waiting.indexOf(entry);
    if (waitingIndex >= 0) {
      this.waiting.splice(waitingIndex, 1);
      this.notifyQueueChange();
      this.pump();
      return;
    }
    if (this.active.delete(entry) && !entry.bypassCapacity)
      this.capacity.untrack(entry);
    if (entry.taskID !== undefined) {
      this.activeByTaskID.delete(entry.taskID);
      entry.taskID = undefined;
    }
    this.notifyQueueChange();
    this.pump();
  }

  protected notifyQueueChange(): void {
    // Consumed here rather than cleared on the way out, so an observer that
    // notifies from inside the pump's own publication still invalidates.
    if (this.ownPublication) this.ownPublication = false;
    else this.scanEpoch += 1;
    this.waiters.notify();
    this.cleanup();
    try {
      this.onQueueChange?.();
    } catch (error) {
      if (error instanceof Error) return;
    }
  }

  private updateEntryCapacity(entry: QueueEntry): void {
    this.assignCapacity(
      entry,
      this.capacity.resolve(this.tasks.get(entry.id)?.model),
    );
  }

  protected assignCapacity(entry: QueueEntry, capacity: CapacityEntry): void {
    entry.tier = capacity.tier;
    entry.key = capacity.key;
    entry.limit = capacity.limit;
  }

  protected requireEntry(admissionID: string): QueueEntry {
    const entry = this.entriesByID.get(admissionID);
    if (!entry) throw new BackgroundTaskNotFoundError(admissionID);
    return entry;
  }

  protected requireSnapshot(admissionID: string): BackgroundTaskRecord {
    const record = this.tasks.get(admissionID);
    if (!record) throw new BackgroundTaskNotFoundError(admissionID);
    return record;
  }

  protected isRecordPaused(record: BackgroundTaskRecord): boolean {
    return (
      record.parentSessionID !== undefined &&
      this.pausedParentSessionIDs.has(record.parentSessionID)
    );
  }
}

export function snapshotConfig(
  config: BackgroundTaskConcurrencyConfig,
): BackgroundTaskConcurrencyConfig {
  return {
    defaultConcurrency: config.defaultConcurrency,
    providerConcurrency: { ...config.providerConcurrency },
    modelConcurrency: { ...config.modelConcurrency },
  };
}

// ===== MANAGEMENT =====

/**
 * Identity and ordering only. Record bodies are always re-read live so
 * content-only mutations need no invalidation.
 */
type QueueView = {
  /** Admission id to its one-based runnable queue position. */
  readonly positions: ReadonlyMap<string, number>;
  /** Record ids in store order: non-postponed first, then postponed. */
  readonly recordIDs: readonly string[];
  /** Parent session id to its record ids in the same relative order. */
  readonly recordIDsByParent: ReadonlyMap<string, readonly string[]>;
};

/** Parent-scoped controls over the same scheduler records and queue. */
export class BackgroundTaskConcurrencyManagement extends BackgroundTaskConcurrencyCore {
  private cachedQueueView: QueueView | undefined;

  setDependencies(
    admissionID: string,
    parentSessionID: string,
    ids: readonly string[],
  ): BackgroundTaskRecord {
    this.requireOwnedSnapshot(admissionID, parentSessionID);
    const release = this.tasks.retain([admissionID]);
    try {
      this.tasks.setDependencies(admissionID, ids);
      this.pump();
      this.notifyQueueChange();
      return this.requireSnapshot(admissionID);
    } finally {
      release();
      this.cleanup();
    }
  }

  listQueue(parentSessionID?: string): BackgroundTaskQueueSnapshot[] {
    const view = this.queueView();
    const ids =
      parentSessionID === undefined
        ? view.recordIDs
        : (view.recordIDsByParent.get(parentSessionID) ?? []);
    const snapshots: BackgroundTaskQueueSnapshot[] = [];
    for (const id of ids) {
      const record = this.tasks.get(id);
      if (!record) continue;
      const queuePosition = view.positions.get(id);
      snapshots.push({
        record,
        ...(queuePosition === undefined ? {} : { queuePosition }),
      });
    }
    return snapshots;
  }

  listParentSessionIDs(): string[] {
    const parents = new Set(this.pausedParentSessionIDs);
    for (const parentSessionID of this.queueView().recordIDsByParent.keys())
      parents.add(parentSessionID);
    return [...parents];
  }

  postpone(admissionID: string): void {
    this.tasks.transition(admissionID, 'postponed');
    this.requireEntry(admissionID);
    this.notifyQueueChange();
    this.pump();
  }

  resume(admissionID: string): void {
    this.tasks.transition(admissionID, 'queued');
    const entry = this.requireEntry(admissionID);
    this.waiting.splice(this.waiting.indexOf(entry), 1);
    this.waiting.push(entry);
    this.notifyQueueChange();
    this.pump();
  }

  cancel(admissionID: string): void {
    this.tasks.transition(admissionID, 'cancelled');
    const entry = this.requireEntry(admissionID);
    this.release(entry, 'cancelled');
  }

  manageAdmission(
    admissionID: string,
    parentSessionID: string,
    action: BackgroundTaskQueueAction,
  ): BackgroundTaskRecord {
    const record = this.requireOwnedSnapshot(admissionID, parentSessionID);
    const release = this.tasks.retain([admissionID]);
    try {
      switch (action) {
        case 'postpone':
          this.postpone(admissionID);
          break;
        case 'resume':
          this.resume(admissionID);
          break;
        case 'cancel':
          if (record.state !== 'queued' && record.state !== 'postponed') {
            throw new BackgroundTaskTransitionError(
              admissionID,
              record.state,
              'cancelled',
            );
          }
          this.cancel(admissionID);
          break;
        default: {
          const exhaustiveAction: never = action;
          return exhaustiveAction;
        }
      }
      return this.requireSnapshot(admissionID);
    } finally {
      release();
      this.cleanup();
    }
  }

  clearQueued(parentSessionID: string): string[] {
    const ids = this.tasks
      .list(parentSessionID)
      .filter(
        (record) => record.state === 'queued' || record.state === 'postponed',
      )
      .map((record) => record.id);
    const release = this.tasks.retain(ids);
    try {
      for (const id of ids) {
        const state = this.requireSnapshot(id).state;
        if (state === 'queued' || state === 'postponed')
          this.manageAdmission(id, parentSessionID, 'cancel');
      }
      return ids;
    } finally {
      release();
      this.cleanup();
    }
  }

  pauseAdmissions(parentSessionID: string): void {
    if (this.pausedParentSessionIDs.has(parentSessionID)) return;
    this.pausedParentSessionIDs.add(parentSessionID);
    this.notifyQueueChange();
  }

  resumeAdmissions(parentSessionID: string): void {
    if (!this.pausedParentSessionIDs.delete(parentSessionID)) return;
    this.notifyQueueChange();
    this.pump();
  }

  isAdmissionPaused(parentSessionID: string): boolean {
    return this.pausedParentSessionIDs.has(parentSessionID);
  }

  configSnapshot(): BackgroundTaskConcurrencyConfig {
    return snapshotConfig(this.config);
  }

  updateLimit(
    update: BackgroundTaskConcurrencyLimitUpdate,
  ): BackgroundTaskConcurrencyConfig {
    if (!Number.isInteger(update.limit) || update.limit < 0)
      throw new RangeError(
        'Background task concurrency limit must be an integer at least 0',
      );
    switch (update.tier) {
      case 'default':
        this.updateConfig({ ...this.config, defaultConcurrency: update.limit });
        break;
      case 'provider':
        this.updateConfig({
          ...this.config,
          providerConcurrency: {
            ...this.config.providerConcurrency,
            [requireLimitKey(update.key)]: update.limit,
          },
        });
        break;
      case 'model':
        this.updateConfig({
          ...this.config,
          modelConcurrency: {
            ...this.config.modelConcurrency,
            [requireLimitKey(update.key)]: update.limit,
          },
        });
        break;
      default: {
        const exhaustiveUpdate: never = update;
        return exhaustiveUpdate;
      }
    }
    return this.configSnapshot();
  }

  private requireOwnedSnapshot(
    admissionID: string,
    parentSessionID: string,
  ): BackgroundTaskRecord {
    const record = this.tasks.get(admissionID);
    if (!record || record.parentSessionID !== parentSessionID)
      throw new BackgroundTaskOwnershipError(admissionID, parentSessionID);
    return record;
  }

  /**
   * Invalidates the cached queue view. Retained records are compacted here, so
   * record existence can change without any queue notification.
   */
  override cleanup(): void {
    this.cachedQueueView = undefined;
    super.cleanup();
  }

  /**
   * Invalidates the cached queue view. Waiting order, waiting record states,
   * paused parents, and record creation all funnel through here.
   *
   * Both hooks stand on their own: neither calls the other, so correctness does
   * not depend on the core chaining one inside the other.
   */
  protected override notifyQueueChange(): void {
    this.cachedQueueView = undefined;
    super.notifyQueueChange();
  }

  /**
   * Builds the cache on demand. The mirror publisher reads once per parent, so
   * rebuilding here costs one global record scan per publication instead of one
   * per parent; body reads across all parents stay linear in records.
   *
   * Integration risk: any future mutation of waiting order or content, a waiting
   * record's queued state, `pausedParentSessionIDs`, or record existence that
   * bypasses both `cleanup()` and `notifyQueueChange()` makes reads go stale
   * silently.
   */
  private queueView(): QueueView {
    const cached = this.cachedQueueView;
    if (cached) return cached;
    const positions = new Map<string, number>();
    let queuePosition = 0;
    for (const entry of this.waiting) {
      const record = this.tasks.get(entry.id);
      if (record?.state !== 'queued' || this.isRecordPaused(record)) continue;
      positions.set(entry.id, ++queuePosition);
    }
    const recordIDs: string[] = [];
    const recordIDsByParent = new Map<string, string[]>();
    for (const record of this.tasks.list()) {
      recordIDs.push(record.id);
      const parentSessionID = record.parentSessionID;
      if (parentSessionID === undefined) continue;
      const bucket = recordIDsByParent.get(parentSessionID);
      if (bucket) bucket.push(record.id);
      else recordIDsByParent.set(parentSessionID, [record.id]);
    }
    const view: QueueView = { positions, recordIDs, recordIDsByParent };
    this.cachedQueueView = view;
    return view;
  }
}

function requireLimitKey(key: string): string {
  const normalized = key.trim();
  if (!normalized)
    throw new RangeError('Concurrency limit key cannot be empty');
  return normalized;
}

// ===== SCHEDULER =====

/** Admission API. Lifecycle reconciliation remains owned by the job board. */
export class BackgroundTaskConcurrency
  extends BackgroundTaskConcurrencyManagement
  implements BackgroundTaskConcurrencyController
{
  restoreTask(taskID: string, model?: string, parentSessionID?: string): void {
    if (this.disposed || !taskID || this.activeByTaskID.has(taskID)) return;
    const normalized = normalizeModel(model);
    const provider = providerFromModel(normalized);
    const task = this.tasks.create({
      ...(normalized ? { model: normalized } : {}),
      ...(provider ? { provider } : {}),
      ...(parentSessionID ? { parentSessionID } : {}),
      previousSessionID: taskID,
    });
    this.tasks.transition(task.id, 'starting');
    this.tasks.bind(task.id, taskID);
    const entry: QueueEntry = {
      id: task.id,
      ...this.capacity.resolve(normalized),
      released: false,
      taskID,
      resolve: undefined,
      reject: undefined,
    };
    this.entriesByID.set(entry.id, entry);
    this.active.add(entry);
    this.activeByTaskID.set(taskID, entry);
    this.capacity.track(entry);
    this.notifyQueueChange();
  }

  migrateTask(taskID: string, model: string | undefined): void {
    const entry = this.activeByTaskID.get(taskID);
    if (!entry || entry.released) return;
    const nextModel = normalizeModel(model);
    if (this.tasks.get(entry.id)?.model === nextModel) return;
    if (!entry.bypassCapacity) this.capacity.untrack(entry);
    this.tasks.updateModel(entry.id, nextModel, providerFromModel(nextModel));
    this.assignCapacity(entry, this.capacity.resolve(nextModel));
    if (!entry.bypassCapacity) this.capacity.track(entry);
    this.notifyQueueChange();
    this.pump();
  }

  acquire(
    request: BackgroundTaskConcurrencyRequest,
  ): BackgroundTaskConcurrencyTicket {
    const deferred = createBackgroundTaskAdmissionDeferred();
    const model = normalizeModel(request.model);
    const provider = providerFromModel(model);
    const task = this.tasks.create(
      {
        logicalID: request.id,
        dependsOn: request.dependsOn,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(request.parentSessionID
          ? { parentSessionID: request.parentSessionID }
          : {}),
        ...(request.previousSessionID
          ? { previousSessionID: request.previousSessionID }
          : {}),
      },
      request.background,
    );
    const entry: QueueEntry = {
      id: task.id,
      bypassCapacity: request.background === false || request.bypassCapacity,
      ...this.capacity.resolve(model),
      released: false,
      taskID: undefined,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
    const releaseRecord = request.retainRecord
      ? this.tasks.retain([task.id])
      : undefined;
    this.entriesByID.set(entry.id, entry);
    if (this.disposed) {
      this.release(entry);
    } else {
      this.waiting.push(entry);
      this.notifyQueueChange();
      this.pump();
    }
    return {
      id: entry.id,
      ready: deferred.promise,
      bind: (taskID) => this.bind(entry, taskID),
      postpone: () => this.postpone(entry.id),
      resume: () => this.resume(entry.id),
      cancel: () => this.cancel(entry.id),
      snapshot: () => this.requireSnapshot(entry.id),
      release: () => this.release(entry),
      releaseIfUnbound: () => {
        if (entry.taskID === undefined) this.release(entry);
        releaseRecord?.();
        this.cleanup();
      },
    };
  }
}

// ===== EXTERNAL STATE RE-EXPORTS (legacy facade compatibility) =====

export {
  getBackgroundTaskConcurrency,
  resetBackgroundTaskConcurrencyForTests,
} from '../admission-runtime';
export {
  type BackgroundTaskLifecycleState,
  BackgroundTaskNotFoundError,
  type BackgroundTaskRecord,
  type BackgroundTaskTerminalState,
  BackgroundTaskTransitionError,
} from './background-task-state';
