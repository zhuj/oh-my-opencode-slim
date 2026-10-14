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

type V2QueueControllerOptions = {
  readonly getDirectory: () => string;
  readonly getSessionID: () => string | undefined;
  readonly read?: (directory: string) => Promise<QueueMirrorReadResult>;
  readonly requestRender: () => void;
  readonly theme: () => QueueTheme;
};

export interface V2QueueCommand {
  readonly title: string;
  readonly slash: { readonly name: string };
  run(): Promise<void>;
}

export interface V2QueueController {
  readonly command: V2QueueCommand;
  render(): JSX.Element;
  refresh(): Promise<void>;
  dispose(): void;
}

type Child = JSX.Element | string | number | null | undefined | false;

export function createV2QueueController(
  options: V2QueueControllerOptions,
): V2QueueController {
  const read = options.read ?? readQueueMirrorSnapshot;
  const [result, setResult] = createSignal<QueueMirrorReadResult>({
    kind: 'unavailable',
    reason: 'missing',
  });
  const [visible, setVisible] = createSignal(false);
  let openSessionID: string | undefined;
  let disposed = false;

  const hide = (requestRender: boolean): void => {
    if (!visible()) return;
    openSessionID = undefined;
    setVisible(false);
    if (requestRender) options.requestRender();
  };

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (visible()) {
      hide(true);
      return;
    }
    const sessionID = options.getSessionID();
    if (sessionID === undefined) return;
    const nextResult = await read(options.getDirectory());
    if (disposed || options.getSessionID() !== sessionID) return;
    openSessionID = sessionID;
    setResult(nextResult);
    setVisible(true);
    options.requestRender();
  };

  const refresh = async (): Promise<void> => {
    const sessionID = openSessionID;
    if (disposed || !visible() || sessionID === undefined) return;
    if (options.getSessionID() !== sessionID) {
      hide(true);
      return;
    }
    const nextResult = await read(options.getDirectory());
    if (disposed || openSessionID !== sessionID) return;
    if (options.getSessionID() !== sessionID) {
      hide(true);
      return;
    }
    setResult(nextResult);
    options.requestRender();
  };

  return {
    command: {
      title: 'OMO: background queue',
      slash: { name: 'queue' },
      run,
    },
    render: () => {
      const root = box({ width: '100%', flexDirection: 'column' });
      insert(root, () =>
        visible() && openSessionID !== undefined
          ? renderQueueSidebar(result(), openSessionID, options.theme())
          : box({ width: '100%', height: 0 }),
      );
      return root;
    },
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      hide(false);
    },
  };
}

function renderQueueSidebar(
  result: QueueMirrorReadResult,
  parentSessionID: string,
  theme: QueueTheme,
): JSX.Element {
  const children: Child[] = [text({ fg: theme.text }, ['Background queue'])];
  switch (result.kind) {
    case 'unavailable':
      children.push(
        text({ fg: theme.textMuted }, [`Queue unavailable (${result.reason})`]),
      );
      break;
    case 'available': {
      const parent = result.snapshot.parents.find(
        (candidate) => candidate.parentSessionID === parentSessionID,
      );
      children.push(
        text({ fg: theme.textMuted }, [
          `Queued ${parent?.totalQueued ?? 0}  Postponed ${parent?.postponedCount ?? 0}${parent?.paused ? '  Paused' : ''}`,
        ]),
      );
      for (const admission of parent?.admissions ?? []) {
        const position =
          admission.state === 'queued' && admission.queuePosition !== undefined
            ? `#${admission.queuePosition}`
            : 'postponed';
        children.push(
          box({ width: '100%', flexDirection: 'row' }, [
            text({ fg: theme.accent, width: 12 }, [position]),
            text({ fg: theme.text }, [admission.id]),
          ]),
        );
      }
      if (!parent || parent.admissions.length === 0) {
        children.push(text({ fg: theme.textMuted }, ['Queue is empty']));
      }
      break;
    }
  }
  return box(
    {
      width: '100%',
      flexDirection: 'column',
      border: { type: 'single' },
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: 1,
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
