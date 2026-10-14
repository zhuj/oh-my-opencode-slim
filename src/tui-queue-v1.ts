import type { TuiCommand } from '@opencode-ai/plugin/tui';
import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';
import { createSignal } from 'solid-js';
import {
  type QueueMirrorReadResult,
  readQueueMirrorSnapshot,
} from './queue-mirror';

type QueueTheme = {
  readonly accent: unknown;
  readonly text: unknown;
  readonly textMuted: unknown;
};

type V1QueueControllerOptions = {
  readonly getDirectory: () => string;
  readonly getSessionID: () => string | undefined;
  readonly read?: (directory: string) => Promise<QueueMirrorReadResult>;
  readonly showDialog: (render: () => JSX.Element, onClose: () => void) => void;
  readonly closeDialog: () => void;
  readonly requestRender: () => void;
  readonly theme: () => QueueTheme;
};

export interface V1QueueController {
  readonly command: TuiCommand;
  open(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}

type Child = JSX.Element | string | number | null | undefined | false;

export function createV1QueueController(
  options: V1QueueControllerOptions,
): V1QueueController {
  const read = options.read ?? readQueueMirrorSnapshot;
  const [result, setResult] = createSignal<QueueMirrorReadResult>({
    kind: 'unavailable',
    reason: 'missing',
  });
  let openSessionID: string | undefined;
  let disposed = false;

  const closeOwnedDialog = (): void => {
    if (openSessionID === undefined) return;
    openSessionID = undefined;
    options.closeDialog();
  };

  const refresh = async (): Promise<void> => {
    const sessionID = openSessionID;
    if (disposed || sessionID === undefined) return;
    if (options.getSessionID() !== sessionID) {
      closeOwnedDialog();
      return;
    }

    const nextResult = await read(options.getDirectory());
    if (disposed || openSessionID !== sessionID) return;
    if (options.getSessionID() !== sessionID) {
      closeOwnedDialog();
      return;
    }
    setResult(nextResult);
    options.requestRender();
  };

  const open = async (): Promise<void> => {
    if (disposed) return;
    const sessionID = options.getSessionID();
    if (sessionID === undefined) return;
    if (openSessionID === sessionID) {
      await refresh();
      return;
    }
    closeOwnedDialog();

    const nextResult = await read(options.getDirectory());
    if (disposed || options.getSessionID() !== sessionID) return;
    setResult(nextResult);
    openSessionID = sessionID;
    options.showDialog(
      () => {
        const root = box({ width: '100%', flexDirection: 'column' });
        insert(root, () =>
          renderQueueContent(result(), sessionID, options.theme()),
        );
        return root;
      },
      () => {
        if (openSessionID === sessionID) openSessionID = undefined;
      },
    );
  };

  return {
    command: {
      title: 'Background queue',
      value: 'queue',
      description: 'View queued background admissions',
      slash: { name: 'queue' },
      onSelect: open,
    },
    open,
    refresh,
    dispose: () => {
      if (disposed) return;
      closeOwnedDialog();
      disposed = true;
    },
  };
}

function renderQueueContent(
  result: QueueMirrorReadResult,
  parentSessionID: string,
  theme: QueueTheme,
): JSX.Element {
  const children: Child[] = [
    text({ fg: theme.text }, ['Background queue']),
    text({ fg: theme.textMuted }, [parentSessionID]),
  ];

  switch (result.kind) {
    case 'unavailable':
      children.push(
        text({ fg: theme.textMuted, marginTop: 1 }, [
          `Queue unavailable (${result.reason})`,
        ]),
      );
      break;
    case 'available': {
      const parent = result.snapshot.parents.find(
        (candidate) => candidate.parentSessionID === parentSessionID,
      );
      children.push(
        text({ fg: theme.textMuted, marginTop: 1 }, [
          `Queued ${parent?.totalQueued ?? 0}  Postponed ${parent?.postponedCount ?? 0}${parent?.paused ? '  Admissions paused' : ''}`,
        ]),
      );
      if (!parent || parent.admissions.length === 0) {
        children.push(text({ fg: theme.textMuted }, ['Queue is empty']));
        break;
      }
      for (const admission of parent.admissions) {
        const position =
          admission.state === 'queued' && admission.queuePosition !== undefined
            ? `#${admission.queuePosition}`
            : 'postponed';
        children.push(
          box({ width: '100%', flexDirection: 'row' }, [
            text({ fg: theme.accent, width: 12 }, [position]),
            text({ fg: theme.text }, [admission.id]),
            admission.model
              ? text({ fg: theme.textMuted, marginLeft: 1 }, [admission.model])
              : null,
          ]),
        );
      }
      break;
    }
  }

  return box(
    {
      width: '100%',
      flexDirection: 'column',
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
    },
    children,
  );
}

function element(
  tag: string,
  props: Record<string, unknown>,
  children: readonly Child[] = [],
): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }
  return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: readonly Child[]) {
  return element('text', props, children);
}

function box(props: Record<string, unknown>, children: readonly Child[] = []) {
  return element('box', props, children);
}
