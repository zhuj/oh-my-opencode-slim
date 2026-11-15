import { describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { projectQueueMirror, type QueueMirrorReadResult } from './queue-mirror';
import { createV2QueueController } from './tui-queue-v2';

function availableQueue(ids: readonly string[]): QueueMirrorReadResult {
  return {
    kind: 'available',
    snapshot: projectQueueMirror({
      publisherID: 'publisher-1',
      runtimeID: 'runtime-1',
      revision: ids.length,
      updatedAt: 1_000,
      parents: [
        {
          parentSessionID: 'parent-1',
          paused: false,
          queue: ids.map((id, index) => ({
            record: {
              id,
              state: 'queued',
              parentSessionID: 'parent-1',
              previousSessionIDs: [],
              createdAt: 1,
              queuedAt: 1,
              updatedAt: 1,
            },
            queuePosition: index + 1,
          })),
        },
      ],
    }),
  };
}

describe('v2 queue controller', () => {
  test('toggles and refreshes a selected-session sidebar view', async () => {
    // Given
    let result = availableQueue(['admission-1']);
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: async () => result,
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
    });
    const setup = await testRender(() => controller.render(), {
      width: 60,
      height: 12,
    });

    // When
    await controller.command.run();
    await setup.renderOnce();
    const firstFrame = setup.captureCharFrame();
    result = availableQueue(['admission-1', 'admission-2']);
    await controller.refresh();
    await setup.renderOnce();
    const refreshedFrame = setup.captureCharFrame();
    await controller.command.run();
    await setup.renderOnce();
    const hiddenFrame = setup.captureCharFrame();
    setup.renderer.destroy();

    // Then
    expect(controller.command.slash.name).toBe('queue');
    expect(firstFrame).toContain('admission-1');
    expect(refreshedFrame).toContain('admission-2');
    expect(hiddenFrame).not.toContain('admission-1');
    expect(renderCount).toBe(3);
  });

  test('hides the queue view when the selected route changes', async () => {
    // Given
    let sessionID = 'parent-1';
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: async () => availableQueue(['admission-1']),
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
    });
    await controller.command.run();

    // When
    sessionID = 'parent-2';
    await controller.refresh();
    controller.dispose();
    controller.dispose();

    // Then
    expect(renderCount).toBe(2);
  });

  test('ignores stale refresh response after disposal', async () => {
    // Given: deferred refresh read; controller opened with immediate read
    let resolveRefresh!: (r: QueueMirrorReadResult) => void;
    let pendingRead: Promise<QueueMirrorReadResult> = Promise.resolve(
      availableQueue([]),
    );
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: () => pendingRead,
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    await controller.command.run();
    expect(renderCount).toBe(1);

    // When: deferred refresh, dispose before resolve, resolve stale
    pendingRead = new Promise<QueueMirrorReadResult>((res) => {
      resolveRefresh = res;
    });
    const refreshPromise = controller.refresh();
    controller.dispose();
    resolveRefresh(availableQueue(['stale-admission']));
    await refreshPromise;

    // Then: stale read must not render or update after disposal
    expect(renderCount).toBe(1);
  });

  test('ignores stale refresh response after session changes', async () => {
    // Given: deferred refresh read; controller opened with session A
    let sessionID = 'parent-1';
    let resolveRefresh!: (r: QueueMirrorReadResult) => void;
    let pendingRead: Promise<QueueMirrorReadResult> = Promise.resolve(
      availableQueue([]),
    );
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: () => pendingRead,
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    await controller.command.run();
    expect(renderCount).toBe(1);

    // When: deferred refresh, change session, resolve stale
    pendingRead = new Promise<QueueMirrorReadResult>((res) => {
      resolveRefresh = res;
    });
    const refreshPromise = controller.refresh();
    sessionID = 'parent-2';
    resolveRefresh(availableQueue(['stale-admission']));
    await refreshPromise;

    // Then: session-change guard must hide (one render); stale result
    // must not add a second result-render
    expect(renderCount).toBe(2);
  });

  test('ignores stale run response after disposal', async () => {
    // Given: deferred open/run read; controller not yet visible
    let resolveRun!: (r: QueueMirrorReadResult) => void;
    const pendingRead: Promise<QueueMirrorReadResult> = new Promise((res) => {
      resolveRun = res;
    });
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: () => pendingRead,
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    const runPromise = controller.command.run();

    // When: dispose before deferred run resolves, resolve stale
    controller.dispose();
    resolveRun(availableQueue(['stale-admission']));
    await runPromise;

    // Then: run must not render or open after disposal
    expect(renderCount).toBe(0);
  });

  test('ignores stale run response after session changes', async () => {
    // Given: deferred open/run read with mutable session
    let sessionID = 'parent-1';
    let resolveRun!: (r: QueueMirrorReadResult) => void;
    const pendingRead: Promise<QueueMirrorReadResult> = new Promise((res) => {
      resolveRun = res;
    });
    let renderCount = 0;
    const controller = createV2QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: () => pendingRead,
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    const runPromise = controller.command.run();

    // When: change selected session before deferred run resolves
    sessionID = 'parent-2';
    resolveRun(availableQueue([]));
    await runPromise;

    // Then: run must not render or replace session state
    expect(renderCount).toBe(0);
  });
});
