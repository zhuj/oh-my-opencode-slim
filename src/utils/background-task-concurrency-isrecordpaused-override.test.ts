import { describe, expect, test } from 'bun:test';
import type { BackgroundTaskConcurrencyConfig } from './background-task-concurrency';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import type { BackgroundTaskRecord } from './background-task-state';

class OverriddenScheduler extends BackgroundTaskConcurrency {
  protected isRecordPaused(_record: BackgroundTaskRecord): boolean {
    return true;
  }
  exposePump(): void {
    this.pump();
  }
}

const MIN_CONFIG: BackgroundTaskConcurrencyConfig = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('isRecordPaused subclass override through PumpContext', () => {
  test('overridden isRecordPaused keeps queued entry from starting', () => {
    const scheduler = new OverriddenScheduler(MIN_CONFIG);
    const ticket = scheduler.acquire({
      id: 'paused-entry',
      parentSessionID: 'parent',
    });
    scheduler.exposePump();
    expect(ticket.snapshot().state).toBe('queued');
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 1 });
    scheduler.dispose();
  });
});
