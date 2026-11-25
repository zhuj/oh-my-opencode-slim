import {
  evaluateTaskDependencies,
  resolveTaskDependencies,
  TaskDependencyError,
  taskLogicalIDSchema,
  validateDependencyCycle,
} from './background-task-dependencies';
import {
  BackgroundTaskRetention,
  type BackgroundTaskRetentionLimits,
} from './background-task-retention';

import {
  type BackgroundTaskLifecycleState,
  BackgroundTaskNotFoundError,
  type BackgroundTaskRecord,
  type BackgroundTaskRecordInput,
  type BackgroundTaskTerminalState,
  BackgroundTaskTransitionError,
  TERMINAL_STATES,
  TRANSITIONS,
} from './background-task-state-types';

export type {
  BackgroundTaskLifecycleState,
  BackgroundTaskRecord,
  BackgroundTaskRecordInput,
  BackgroundTaskTerminalState,
} from './background-task-state-types';
export {
  BackgroundTaskNotFoundError,
  BackgroundTaskTransitionError,
} from './background-task-state-types';

type Clock = () => number;
// Process-wide monotonic identity survives scheduler disposal/reinitialization.
let nextAdmissionID = 0;

export class BackgroundTaskStateStore {
  private readonly records = new Map<string, BackgroundTaskRecord>();
  private readonly latestBySessionID = new Map<string, BackgroundTaskRecord>();
  // undefined means parentless, not the list() all-parents wildcard.
  private readonly aliases = new Map<string | undefined, Map<string, string>>();
  private readonly retention: BackgroundTaskRetention;

  constructor(
    private readonly now: Clock = Date.now,
    limits?: BackgroundTaskRetentionLimits,
  ) {
    this.retention = new BackgroundTaskRetention(limits);
  }

  retain(ids: readonly string[]): () => void {
    for (const id of ids) this.require(id);
    return this.retention.retain(ids);
  }

  compact(operationalIDs: Iterable<string> = []): void {
    const evicted = new Set(
      this.retention.candidates(this.records, this.now(), operationalIDs),
    );
    for (const id of evicted) {
      const record = this.require(id);
      const aliases = this.aliases.get(record.parentSessionID);
      aliases?.delete(record.logicalID);
      aliases?.delete(id);
      if (aliases?.size === 0) this.aliases.delete(record.parentSessionID);
      this.records.delete(id);
    }
    for (const [sessionID, record] of this.latestBySessionID) {
      if (evicted.has(record.id)) this.latestBySessionID.delete(sessionID);
    }
  }

  create(
    input: BackgroundTaskRecordInput,
    background = true,
  ): BackgroundTaskRecord {
    const now = this.now();
    const id = `admission-${nextAdmissionID + 1}`;
    const logicalID = input.logicalID ?? id;
    const dependencies = this.resolveDependencies({
      parentSessionID: input.parentSessionID,
      ids: input.dependsOn ?? [],
      self: input.logicalID,
    });
    if (!background) {
      const evaluation = evaluateTaskDependencies(dependencies);
      if (evaluation.state !== 'ready')
        throw new TaskDependencyError(
          evaluation.state === 'blocked'
            ? 'Foreground dependency failed'
            : 'Foreground dependencies are not completed',
          dependencies,
        );
    }
    if (input.logicalID !== undefined) taskLogicalIDSchema.parse(logicalID);
    if (this.aliases.get(input.parentSessionID)?.has(logicalID)) {
      throw new TaskDependencyError(`Duplicate logical task id: ${logicalID}`);
    }
    const dependsOn = dependencies.map((task) => task.id);
    nextAdmissionID += 1;
    const record: BackgroundTaskRecord = {
      id,
      logicalID,
      dependsOn,
      state: 'queued',
      ...(input.occupancyOnly ? { occupancyOnly: true } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.parentSessionID
        ? { parentSessionID: input.parentSessionID }
        : {}),
      previousSessionIDs: input.previousSessionID
        ? [input.previousSessionID]
        : [],
      createdAt: now,
      queuedAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    if (!input.occupancyOnly) {
      const aliases =
        this.aliases.get(record.parentSessionID) ?? new Map<string, string>();
      aliases.set(logicalID, id);
      aliases.set(id, id);
      this.aliases.set(record.parentSessionID, aliases);
    }
    return snapshot(record);
  }

  resolveDependencies(
    request: Parameters<typeof resolveTaskDependencies>[1],
  ): BackgroundTaskRecord[] {
    const aliases = this.aliases.get(request.parentSessionID);
    return resolveTaskDependencies((id) => {
      const canonical = aliases?.get(id);
      return canonical === undefined ? undefined : this.records.get(canonical);
    }, request).map(snapshot);
  }

  get(taskID: string): BackgroundTaskRecord | undefined {
    const record = this.records.get(taskID);
    return record ? snapshot(record) : undefined;
  }

  noteObservationError(taskID: string, observationError: string): void {
    const record = this.require(taskID);
    this.records.set(taskID, {
      ...record,
      observationError,
      updatedAt: this.now(),
    });
  }

  setDependencies(taskID: string, ids: readonly string[]): void {
    const record = this.require(taskID);
    if (record.state !== 'queued' && record.state !== 'postponed') {
      throw new TaskDependencyError(
        'Dependencies can only change for queued/postponed tasks',
        [record],
      );
    }
    const dependsOn = this.resolveDependencies({
      parentSessionID: record.parentSessionID,
      ids,
      self: taskID,
    }).map((task) => task.id);
    validateDependencyCycle(this.records, taskID, dependsOn);
    this.records.set(taskID, { ...record, dependsOn, updatedAt: this.now() });
  }

  failDependency(taskID: string, error: TaskDependencyError): void {
    this.terminal(taskID, 'error');
    this.records.set(taskID, {
      ...this.require(taskID),
      dependencyError: error.message,
      dependencyFailure: error.diagnostics,
    });
  }

  list(parentSessionID?: string): BackgroundTaskRecord[] {
    const records = [...this.records.values()].filter(
      (record) =>
        !record.occupancyOnly &&
        (parentSessionID === undefined ||
          record.parentSessionID === parentSessionID),
    );
    return [
      ...records.filter((record) => record.state !== 'postponed'),
      ...records.filter((record) => record.state === 'postponed'),
    ].map(snapshot);
  }

  transition(
    taskID: string,
    state: BackgroundTaskLifecycleState,
  ): BackgroundTaskRecord {
    const record = this.require(taskID);
    if (!TRANSITIONS[record.state].includes(state)) {
      throw new BackgroundTaskTransitionError(taskID, record.state, state);
    }
    const now = this.now();
    const updated: BackgroundTaskRecord = {
      ...record,
      state,
      updatedAt: now,
      ...(state === 'queued' ? { queuedAt: now } : {}),
      ...(state === 'postponed' ? { postponedAt: now } : {}),
      ...(state === 'starting' ? { startedAt: now } : {}),
      ...(TERMINAL_STATES.has(state) ? { completedAt: now } : {}),
    };
    this.records.set(taskID, updated);
    return snapshot(updated);
  }

  bind(taskID: string, sessionID: string): BackgroundTaskRecord {
    const record = this.require(taskID);
    if (record.state !== 'starting' && record.state !== 'running') {
      throw new BackgroundTaskTransitionError(taskID, record.state, 'running');
    }
    if (record.state === 'running' && record.assignedSessionID === sessionID) {
      return snapshot(record);
    }

    const previousRecord = this.latestBySessionID.get(sessionID);
    const previousSessionIDs = [
      ...new Set([
        ...record.previousSessionIDs,
        ...(previousRecord?.previousSessionIDs ?? []),
        ...(previousRecord?.assignedSessionID
          ? [previousRecord.assignedSessionID]
          : []),
        ...(record.assignedSessionID ? [record.assignedSessionID] : []),
      ]),
    ];
    const now = this.now();
    const updated: BackgroundTaskRecord = {
      ...record,
      state: 'running',
      assignedSessionID: sessionID,
      previousSessionIDs,
      assignedAt: now,
      updatedAt: now,
    };
    this.records.set(taskID, updated);
    this.latestBySessionID.set(sessionID, updated);
    return snapshot(updated);
  }

  terminal(taskID: string, state: BackgroundTaskTerminalState): void {
    const record = this.require(taskID);
    if (TERMINAL_STATES.has(record.state)) return;
    this.transition(taskID, state);
  }

  updateModel(taskID: string, model?: string, provider?: string): void {
    const record = this.require(taskID);
    const updated: BackgroundTaskRecord = {
      ...record,
      model,
      provider,
      updatedAt: this.now(),
    };
    this.records.set(taskID, updated);
    if (updated.assignedSessionID) {
      this.latestBySessionID.set(updated.assignedSessionID, updated);
    }
  }

  private require(taskID: string): BackgroundTaskRecord {
    const record = this.records.get(taskID);
    if (!record) throw new BackgroundTaskNotFoundError(taskID);
    return record;
  }
}

function snapshot(record: BackgroundTaskRecord): BackgroundTaskRecord {
  return {
    ...record,
    dependsOn: [...record.dependsOn],
    previousSessionIDs: [...record.previousSessionIDs],
  };
}
