import { createTaskSessionManagerHook } from '../hooks/task-session-manager';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createBackgroundJobSnapshotStore } from '../utils/background-job-snapshot-store';
import { createTimerHarness } from '../utils/test-timers';
import {
  childID,
  parentID,
  retainedV2,
} from './task-revive-retained-v2.fixture';

export function timerSeams() {
  const manual = createTimerHarness();
  return {
    ...manual,
    setTimeout(callback: () => void, delay: number): Timer {
      const id = manual.setTimeout(callback, delay);
      const timer: Timer = {
        ref: () => timer,
        unref: () => timer,
        hasRef: () => false,
        refresh: () => {
          throw new Error('Unexpected timer refresh');
        },
        [Symbol.toPrimitive]: () => id,
      };
      return timer;
    },
    clearTimeout: (timer: Timer) => manual.clearTimeout(Number(timer)),
  };
}

export async function pendingRoundtrip(
  pendingIdentity: unknown = 'msg_persisted',
) {
  const h = retainedV2();
  const source = new BackgroundJobBoard();
  const backing = createBackgroundJobSnapshotStore(h.input.directory);
  const persisted = Promise.withResolvers<void>();
  const manager = createTaskSessionManagerHook(h.input, {
    backgroundJobBoard: source,
    backgroundJobSnapshotStore: {
      ...backing,
      async applyMutation(...args) {
        await backing.applyMutation(...args);
        persisted.resolve();
      },
    },
    maxSessionsPerAgent: 2,
    shouldManageSession: () => true,
    hostFlavor: 'v2',
  });
  let restoredManager:
    | ReturnType<typeof createTaskSessionManagerHook>
    | undefined;
  try {
    await manager['experimental.chat.messages.transform']({}, { messages: [] });
    const record = source.registerLaunch({
      taskID: childID,
      parentSessionID: parentID,
      agent: 'explorer',
      background: true,
      pendingPromptAdmissionID: 'msg_persisted',
      now: 100,
    });
    await persisted.promise;
    await manager.event({ event: { type: 'server.instance.disposed' } });
    if (pendingIdentity !== 'msg_persisted') {
      await backing.applyMutation(
        parentID,
        {
          upsert: [{ ...record, pendingPromptAdmissionID: pendingIdentity }],
          removeTaskIDs: [],
        },
        101,
      );
    }
    const saved = await backing.readRoot(parentID);
    const board = new BackgroundJobBoard();
    restoredManager = createTaskSessionManagerHook(h.input, {
      backgroundJobBoard: board,
      backgroundJobSnapshotStore: createBackgroundJobSnapshotStore(
        h.input.directory,
      ),
      maxSessionsPerAgent: 2,
      shouldManageSession: () => true,
      hostFlavor: 'v2',
    });
    await restoredManager['experimental.chat.messages.transform'](
      {},
      { messages: [] },
    );
    h.options.backgroundJobBoard = board;
    h.idle.resolve();
    const restored = restoredManager;
    return {
      h,
      board,
      saved,
      manager: restored,
      dispose: async () => {
        await restored.event({ event: { type: 'server.instance.disposed' } });
      },
    };
  } catch (error) {
    await restoredManager?.event({
      event: { type: 'server.instance.disposed' },
    });
    throw error;
  } finally {
    await manager.event({ event: { type: 'server.instance.disposed' } });
  }
}
