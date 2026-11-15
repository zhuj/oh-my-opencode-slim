import { describe, expect, test } from 'bun:test';
import type { QueueMirrorReadResult } from './queue-mirror';
import { createV1QueueController } from './tui-queue-v1';
import { createV2QueueController } from './tui-queue-v2';

const EMPTY: QueueMirrorReadResult = { kind: 'unavailable', reason: 'missing' };

for (const host of ['v1', 'v2'] as const) {
  describe(`${host} queue workspace fencing`, () => {
    function fixture() {
      let directory = 'project-a';
      let renders = 0;
      let opens = 0;
      let closes = 0;
      let read: () => Promise<QueueMirrorReadResult> = async () => EMPTY;
      const options = {
        getDirectory: () => directory,
        getSessionID: () => 'same-session',
        read: () => read(),
        requestRender: () => {
          renders++;
        },
        theme: () => ({ text: 'white', textMuted: 'gray', accent: 'green' }),
      };
      const controller =
        host === 'v1'
          ? createV1QueueController({
              ...options,
              showDialog: () => {
                opens++;
              },
              closeDialog: () => {
                closes++;
              },
            })
          : createV2QueueController(options);
      return {
        controller,
        open: () =>
          'open' in controller ? controller.open() : controller.command.run(),
        rendered: () => (host === 'v1' ? opens + renders : renders),
        closed: () => (host === 'v1' ? closes : renders - 1),
        changeDirectory: () => {
          directory = 'project-b';
        },
        deferRead: () => {
          let resolve!: (result: QueueMirrorReadResult) => void;
          const promise = new Promise<QueueMirrorReadResult>((done) => {
            resolve = done;
          });
          read = () => promise;
          return () => resolve(EMPTY);
        },
      };
    }

    test('does not open a stale workspace response with the same session ID', async () => {
      const f = fixture();
      const resolve = f.deferRead();
      const opening = f.open();
      f.changeDirectory();
      resolve();
      await opening;
      expect(f.rendered()).toBe(0);
      f.controller.dispose();
    });

    test('closes a stale refresh when the workspace changes', async () => {
      const f = fixture();
      await f.open();
      const resolve = f.deferRead();
      const refreshing = f.controller.refresh();
      f.changeDirectory();
      resolve();
      await refreshing;
      expect(f.closed()).toBe(1);
      f.controller.dispose();
    });

    test('only the newest overlapping open response may mount', async () => {
      const f = fixture();
      const resolveFirst = f.deferRead();
      const first = f.open();
      const resolveSecond = f.deferRead();
      const second = f.open();
      resolveSecond();
      await second;
      resolveFirst();
      await first;
      expect(f.rendered()).toBe(1);
      f.controller.dispose();
    });
  });
}
