import { describe, expect, test } from 'bun:test';
import type { JSX } from '@opentui/solid';
import { testRender } from '@opentui/solid';
import { projectQueueMirror, type QueueMirrorReadResult } from './queue-mirror';
import { createV1QueueController } from './tui-queue-v1';

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

describe('v1 queue controller', () => {
  test('opens a local queue command and updates one mounted dialog', async () => {
    // Given
    let result = availableQueue(['admission-1']);
    let renderDialog: (() => JSX.Element) | undefined;
    let mountCount = 0;
    let renderCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: async () => result,
      showDialog: (render) => {
        renderDialog = render;
        mountCount += 1;
      },
      closeDialog: () => {},
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
    });

    // When
    await controller.command.onSelect?.();
    const setup = await testRender(() => renderDialog?.(), {
      width: 60,
      height: 12,
    });
    await setup.renderOnce();
    const firstFrame = setup.captureCharFrame();
    result = availableQueue(['admission-1', 'admission-2']);
    await controller.refresh();
    await setup.renderOnce();
    const refreshedFrame = setup.captureCharFrame();
    setup.renderer.destroy();

    // Then
    expect(controller.command.slash?.name).toBe('queue');
    expect(firstFrame).toContain('admission-1');
    expect(firstFrame).not.toContain('admission-2');
    expect(refreshedFrame).toContain('admission-2');
    expect(mountCount).toBe(1);
    expect(renderCount).toBe(1);
  });

  test('closes the owned dialog when the selected session changes', async () => {
    // Given
    let sessionID = 'parent-1';
    let closeCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: async () => availableQueue([]),
      showDialog: () => {},
      closeDialog: () => {
        closeCount += 1;
      },
      requestRender: () => {},
      theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
    });
    await controller.open();

    // When
    sessionID = 'parent-2';
    await controller.refresh();
    controller.dispose();

    // Then
    expect(closeCount).toBe(1);
  });

  test('closes an open dialog once on disposal', async () => {
    // Given
    let closeCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: async () => ({ kind: 'unavailable', reason: 'missing' }),
      showDialog: () => {},
      closeDialog: () => {
        closeCount += 1;
      },
      requestRender: () => {},
      theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
    });
    await controller.open();

    // When
    controller.dispose();
    controller.dispose();

    // Then
    expect(closeCount).toBe(1);
  });

  test('ignores stale refresh response after disposal', async () => {
    // Given: deferred refresh read; controller open with immediate read
    let resolveRefresh!: (r: QueueMirrorReadResult) => void;
    let pendingRead: Promise<QueueMirrorReadResult> = Promise.resolve(
      availableQueue([]),
    );
    let renderCount = 0;
    let closeCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: () => pendingRead,
      showDialog: () => {},
      closeDialog: () => {
        closeCount += 1;
      },
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    await controller.open();
    // open does not call requestRender; only refresh does
    expect(renderCount).toBe(0);

    // When: start deferred refresh, dispose before resolve, then resolve stale
    pendingRead = new Promise<QueueMirrorReadResult>((res) => {
      resolveRefresh = res;
    });
    const refreshPromise = controller.refresh();
    controller.dispose();
    resolveRefresh(availableQueue(['stale-admission']));
    await refreshPromise;

    // Then: stale result must not update or render after disposal
    expect(renderCount).toBe(0);
    expect(closeCount).toBe(1);
  });

  test('ignores stale refresh response after session changes', async () => {
    // Given: deferred refresh read; controller open with session A
    let sessionID = 'parent-1';
    let resolveRefresh!: (r: QueueMirrorReadResult) => void;
    let pendingRead: Promise<QueueMirrorReadResult> = Promise.resolve(
      availableQueue([]),
    );
    let renderCount = 0;
    let closeCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: () => pendingRead,
      showDialog: () => {},
      closeDialog: () => {
        closeCount += 1;
      },
      requestRender: () => {
        renderCount += 1;
      },
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    await controller.open();
    expect(renderCount).toBe(0);

    // When: start deferred refresh, change selected session, then resolve stale
    pendingRead = new Promise<QueueMirrorReadResult>((res) => {
      resolveRefresh = res;
    });
    const refreshPromise = controller.refresh();
    sessionID = 'parent-2';
    resolveRefresh(availableQueue(['stale-admission']));
    await refreshPromise;

    // Then: session-change guard must close owned dialog; stale result
    // must not call setResult/requestRender
    expect(closeCount).toBe(1);
    expect(renderCount).toBe(0);
  });

  test('ignores stale open response after disposal', async () => {
    // Given: deferred open read; controller not yet open
    let resolveOpen!: (r: QueueMirrorReadResult) => void;
    const pendingRead: Promise<QueueMirrorReadResult> = new Promise((res) => {
      resolveOpen = res;
    });
    let showCount = 0;
    let closeCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => 'parent-1',
      read: () => pendingRead,
      showDialog: () => {
        showCount += 1;
      },
      closeDialog: () => {
        closeCount += 1;
      },
      requestRender: () => {},
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    const openPromise = controller.open();

    // When: dispose before deferred open resolves, then resolve stale
    controller.dispose();
    resolveOpen(availableQueue(['stale-admission']));
    await openPromise;

    // Then: dialog must stay unopened; disposal's close must be only one
    expect(showCount).toBe(0);
    expect(closeCount).toBe(0);
  });

  test('ignores stale open response after session changes', async () => {
    // Given: deferred open read with mutable session
    let sessionID = 'parent-1';
    let resolveOpen!: (r: QueueMirrorReadResult) => void;
    const pendingRead: Promise<QueueMirrorReadResult> = new Promise((res) => {
      resolveOpen = res;
    });
    let showCount = 0;
    const controller = createV1QueueController({
      getDirectory: () => 'project',
      getSessionID: () => sessionID,
      read: () => pendingRead,
      showDialog: () => {
        showCount += 1;
      },
      closeDialog: () => {},
      requestRender: () => {},
      theme: () => ({
        text: 'white',
        textMuted: 'gray',
        accent: 'green',
      }),
    });
    const openPromise = controller.open();

    // When: change selected session before deferred open resolves
    sessionID = 'parent-2';
    resolveOpen(availableQueue([]));
    await openPromise;

    // Then: open must not render for the replaced session
    expect(showCount).toBe(0);
  });
});
