import { describe, expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { expandTaskDependencyTree } from './background-task-dependencies';

const config = {
  defaultConcurrency: 2,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('task dependencies', () => {
  test('queues a dependent without consuming capacity when its prerequisite runs', async () => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config);
    const first = scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
    await first.ready;
    first.bind('ses_first');
    // When
    const next = scheduler.acquire({
      id: 'next',
      dependsOn: ['first'],
      parentSessionID: 'parent',
    });
    const independent = scheduler.acquire({ parentSessionID: 'parent' });
    await independent.ready;
    // Then
    expect(next.snapshot().state).toBe('queued');
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    scheduler.releaseTask('ses_first', 'completed');
    await next.ready;
    expect(next.snapshot().logicalID).toBe('next');
    expect(next.snapshot().dependsOn).toEqual([first.id]);
    scheduler.dispose();
  });

  test.each([
    { id: '' },
    { id: 'bad id' },
    { dependsOn: ['unknown'] },
    { id: 'first' },
    { id: 'self', dependsOn: ['self'] },
    { dependsOn: ['first', 'first'] },
    { dependsOn: [''] },
  ])('rejects invalid submission %j before creating an admission', (input) => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config);
    scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
    // When / Then
    expect(() =>
      scheduler.acquire({ ...input, parentSessionID: 'parent' }),
    ).toThrow();
    expect(scheduler.list()).toHaveLength(1);
    scheduler.dispose();
  });

  test('rejects cross-parent dependencies while allowing scoped logical IDs', () => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config);
    scheduler.acquire({ id: 'first', parentSessionID: 'other' });
    // When / Then
    expect(() =>
      scheduler.acquire({ dependsOn: ['first'], parentSessionID: 'parent' }),
    ).toThrow(/parent|owned/);
    expect(
      scheduler.acquire({ id: 'first', parentSessionID: 'parent' }).snapshot()
        .logicalID,
    ).toBe('first');
    scheduler.dispose();
  });

  test.each(['error', 'cancelled'] as const)(
    'fails queued descendants when a prerequisite becomes %s',
    async (state) => {
      // Given
      const scheduler = new BackgroundTaskConcurrency(config);
      const first = scheduler.acquire({
        id: 'first',
        parentSessionID: 'parent',
      });
      first.bind('ses_first');
      const next = scheduler.acquire({
        id: 'next',
        dependsOn: ['first'],
        parentSessionID: 'parent',
      });
      const last = scheduler.acquire({
        dependsOn: ['next'],
        parentSessionID: 'parent',
      });
      const rejected = next.ready.catch((error: unknown) => error);
      const descendant = last.ready.catch((error: unknown) => error);
      // When
      scheduler.releaseTask('ses_first', state);
      // Then
      expect(await rejected).toBeInstanceOf(Error);
      expect(await descendant).toBeInstanceOf(Error);
      expect(next.snapshot().state).toBe('error');
      expect(last.snapshot().state).toBe('error');
      scheduler.dispose();
    },
  );

  test('foreground dependencies fail fast until completed even without capacity', async () => {
    // Given
    const scheduler = new BackgroundTaskConcurrency({
      ...config,
      defaultConcurrency: 1,
    });
    const first = scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
    first.bind('ses_first');
    const request = {
      dependsOn: ['first'],
      parentSessionID: 'parent',
      background: false,
    };
    // When / Then
    expect(() => scheduler.acquire(request)).toThrow(
      /foreground.*first.*running/i,
    );
    scheduler.releaseTask('ses_first', 'completed');
    scheduler.acquire({ parentSessionID: 'other' });
    const foreground = scheduler.acquire(request);
    await foreground.ready;
    expect(foreground.snapshot().state).toBe('starting');
    scheduler.dispose();
  });

  test('dependency tree expansion stops safely when records contain a cycle', () => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config);
    scheduler.pauseAdmissions('parent');
    const first = scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
    const second = scheduler.acquire({
      id: 'second',
      dependsOn: ['first'],
      parentSessionID: 'parent',
    });
    void first.ready.catch(() => undefined);
    void second.ready.catch(() => undefined);
    const records = scheduler.list('parent');
    const cyclicRecords = records.map((record) =>
      record.logicalID === 'first'
        ? { ...record, dependsOn: [second.id] }
        : record,
    );

    // When
    const root = cyclicRecords.find((record) => record.logicalID === 'first');
    if (!root) throw new Error('cycle fixture root was not created');
    const expansion = expandTaskDependencyTree(cyclicRecords, [root], 64);

    // Then
    expect(expansion.nodes).toHaveLength(2);
    expect(expansion.cycles).toHaveLength(1);
    scheduler.dispose();
  });
});
