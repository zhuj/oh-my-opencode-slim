import type { BackgroundTaskRecord } from './background-task-state-types';

export type BackgroundTaskRetentionLimits = {
  readonly maxAgeMs: number;
  readonly maxPerParent: number;
  readonly maxTotal: number;
};

const DEFAULT_LIMITS: BackgroundTaskRetentionLimits = {
  maxAgeMs: 60 * 60 * 1000,
  maxPerParent: 1024,
  maxTotal: 4096,
};

/** Reference-safe soft limits; the state store owns atomic index removal. */
export class BackgroundTaskRetention {
  private readonly pins = new Map<string, number>();
  // Reused by the pre-check so an idle publication allocates nothing.
  private readonly precheckCounts = new Map<string | undefined, number>();

  constructor(private readonly limits = DEFAULT_LIMITS) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError(
          'Task retention limits must be nonnegative integers',
        );
    }
  }

  retain(ids: readonly string[]): () => void {
    for (const id of ids) this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = this.pins.get(id) ?? 0;
        if (count <= 1) this.pins.delete(id);
        else this.pins.set(id, count - 1);
      }
    };
  }

  /**
   * One-sided pre-check: `false` proves `candidates` would evict nothing,
   * `true` only promises the full walk is worth its edge traversal and sort.
   *
   * The soft limits are compared against unpruned terminal counts, which are
   * the maxima the eviction walk ever observes (it only decrements them while
   * evicting), so "every terminal is within limits and younger than
   * maxAgeMs" leaves no record to evict. Pinned records can only shrink the
   * eviction set, so ignoring the dependency graph here can never turn a real
   * eviction into a skip; it can only pay for a walk that finds nothing.
   *
   * The age term must stay the exact complement of the walk's KEEP
   * comparison `now - completedAt < maxAgeMs`, never the equivalent-looking
   * `now - completedAt >= maxAgeMs`. They agree only for finite operands: with
   * a non-finite clock (unvalidated, see `BackgroundTaskStateStore`) the KEEP
   * form is false and the record is evicted, while `>=` is false too and would
   * skip an eviction the walk performs. Negating instead makes "not provably
   * young" fall through to the walk.
   */
  private hasEvictable(
    records: ReadonlyMap<string, BackgroundTaskRecord>,
    now: number,
  ): boolean {
    const counts = this.precheckCounts;
    counts.clear();
    let terminal = 0;
    for (const record of records.values()) {
      const completedAt = record.completedAt;
      if (completedAt === undefined) continue;
      if (!(now - completedAt < this.limits.maxAgeMs)) return true;
      terminal += 1;
      if (terminal > this.limits.maxTotal) return true;
      const parent = record.parentSessionID;
      const count = (counts.get(parent) ?? 0) + 1;
      if (count > this.limits.maxPerParent) return true;
      counts.set(parent, count);
    }
    return false;
  }

  candidates(
    records: ReadonlyMap<string, BackgroundTaskRecord>,
    now: number,
    operationalIDs: Iterable<string>,
  ): string[] {
    // Nothing over a limit or past maxAgeMs: skip the edge walk and the sort.
    if (!this.hasEvictable(records, now)) return [];
    // Traverse authoritative edges, including through terminal intermediates.
    // No duplicate reverse index can drift after dependency edits or eviction.
    const pending = [...this.pins.keys(), ...operationalIDs];
    const terminal: BackgroundTaskRecord[] = [];
    const counts = new Map<string | undefined, number>();
    for (const record of records.values()) {
      if (record.completedAt === undefined) pending.push(record.id);
      else {
        terminal.push(record);
        counts.set(
          record.parentSessionID,
          (counts.get(record.parentSessionID) ?? 0) + 1,
        );
      }
    }
    const pinned = new Set<string>();
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || pinned.has(id)) continue;
      pinned.add(id);
      for (const dependency of records.get(id)?.dependsOn ?? [])
        pending.push(dependency);
    }
    terminal.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    let total = terminal.length;
    const evicted: string[] = [];
    for (const record of terminal) {
      if (pinned.has(record.id)) continue;
      const count = counts.get(record.parentSessionID) ?? 0;
      if (
        now - (record.completedAt ?? now) < this.limits.maxAgeMs &&
        count <= this.limits.maxPerParent &&
        total <= this.limits.maxTotal
      )
        continue;
      evicted.push(record.id);
      counts.set(record.parentSessionID, count - 1);
      total--;
    }
    return evicted;
  }
}
