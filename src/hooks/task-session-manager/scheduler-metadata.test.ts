/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  BackgroundJobBoard,
  BackgroundJobCoordinator,
  BackgroundTaskConcurrency,
  parseTaskIdFromTaskOutput,
  parseTaskResultFromOutput,
  parseTaskStateFromOutput,
} from '../../utils';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { createPendingCallTracker } from './pending-call-tracker';
import {
  appendChildRefSuffix,
  appendSchedulerMetadata,
  readAuthoritativeChildRef,
} from './session-recovery';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

const ref = {
  parentSessionID: 'parent-metadata',
  agent: 'explorer',
  alias: 'explorer-task',
  sessionID: 'child-metadata',
};
const metadata = {
  logicalID: 'logical-metadata',
  admissionID: 'admission-metadata',
};

const outputs = [
  {
    name: 'enveloped task result',
    output:
      '<task id="child-metadata" state="running" description="a <task_error> > b">\n<task_result>\noriginal body\n</task_result>\n</task>',
    body: 'original body',
    opener: '<task_result>',
  },
  {
    name: 'standalone textual task result',
    output:
      'task_id: child-metadata\nstate: running\n<task_result>\noriginal body\n</task_result>',
    body: 'original body',
    opener: '<task_result>',
  },
  {
    name: 'standalone textual task error',
    output:
      'task_id: child-metadata\nstate: running\n<task_error>\noriginal body\n</task_error>',
    body: 'original body',
    opener: '<task_error>',
  },
  {
    name: 'direct-body subagent',
    output:
      '<subagent sessionID="child-metadata" state="running" description="a <task_result> > b">original body\n<task_result>\nstate: completed</subagent>',
    body: 'original body\n<task_result>\nstate: completed',
    opener: '<subagent',
  },
  {
    name: 'native background plaintext',
    output:
      'The subagent is working in the background (sessionID: child-metadata)',
    opener: '',
  },
] as const;

describe('scheduler metadata placement', () => {
  test.each(outputs)(
    'preserves $name payload and child reference',
    (fixture) => {
      const withRef = appendChildRefSuffix(fixture.output, ref);
      const finalOutput = appendSchedulerMetadata(withRef, metadata);
      const metadataAt = finalOutput.indexOf('logical-metadata');
      const markerAt = finalOutput.indexOf('<!-- slim-child-ref:v1 ');

      if (fixture.name !== 'direct-body subagent') {
        expect(finalOutput.match(/^id: logical-metadata$/gm)).toHaveLength(1);
        expect(
          finalOutput.match(/^admission_id: admission-metadata$/gm),
        ).toHaveLength(1);
      }
      expect(metadataAt).toBeGreaterThanOrEqual(0);
      expect(metadataAt).toBeLessThan(markerAt);
      expect(finalOutput.trimEnd().slice(markerAt)).toMatch(
        /^<!-- slim-child-ref:v1 \{.*\} -->$/,
      );
      expect(readAuthoritativeChildRef(finalOutput)).toEqual(ref);

      if (fixture.body !== undefined) {
        expect(parseTaskResultFromOutput(finalOutput)).toBe(fixture.body);
        if (fixture.name === 'enveloped task result') {
          expect(parseTaskIdFromTaskOutput(finalOutput)).toBe(ref.sessionID);
          expect(parseTaskStateFromOutput(finalOutput)).toBe('running');
        }
        if (fixture.name === 'direct-body subagent') {
          expect(parseTaskIdFromTaskOutput(finalOutput)).toBe(ref.sessionID);
          expect(parseTaskStateFromOutput(finalOutput)).toBe('running');
          const openingTag =
            /^<subagent(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(finalOutput)?.[0] ??
            '';
          expect(openingTag.match(/\bid="logical-metadata"/g)).toHaveLength(1);
          expect(
            openingTag.match(/\badmission_id="admission-metadata"/g),
          ).toHaveLength(1);
          expect(openingTag).toContain('sessionID="child-metadata"');
          expect(openingTag).toContain('state="running"');
          expect(openingTag).toContain('description="a <task_result> > b"');
        } else {
          expect(metadataAt).toBeLessThan(finalOutput.indexOf(fixture.opener));
        }
      } else {
        expect(finalOutput.indexOf('id: logical-metadata')).toBeLessThan(
          markerAt,
        );
      }
    },
  );

  test('escapes scheduler values inserted into subagent attributes', () => {
    const output = appendChildRefSuffix(outputs[3].output, ref);
    const finalOutput = appendSchedulerMetadata(output, {
      logicalID: 'logical"<&>',
      admissionID: 'admission"<&>',
    });
    const openingTag =
      /^<subagent(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(finalOutput)?.[0] ?? '';

    expect(openingTag).toContain('id="logical&quot;&lt;&amp;&gt;"');
    expect(openingTag).toContain('admission_id="admission&quot;&lt;&amp;&gt;"');
  });

  test('appends scheduler metadata unchanged without an authoritative marker', () => {
    expect(appendSchedulerMetadata('plain output', metadata)).toBe(
      'plain output\nid: logical-metadata\nadmission_id: admission-metadata',
    );
  });

  test('does not search a native child-ref marker for payload delimiters', () => {
    const markerRef = { ...ref, agent: '<task_result>' };
    const output = appendChildRefSuffix(
      'The subagent is working in the background (sessionID: child-metadata)',
      markerRef,
    );
    const finalOutput = appendSchedulerMetadata(output, metadata);

    expect(finalOutput.trimEnd().split('\n').at(-1)).toBe(
      output.trimEnd().split('\n').at(-1),
    );
    expect(readAuthoritativeChildRef(finalOutput)).toEqual(markerRef);
    expect(finalOutput.indexOf('id: logical-metadata')).toBeLessThan(
      finalOutput.lastIndexOf('<!-- slim-child-ref:v1 '),
    );
  });

  test('composes hook output with recoverable ref and unchanged result', async () => {
    const board = new BackgroundJobCoordinator(new BackgroundJobBoard());
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const pendingCallTracker = createPendingCallTracker();
    const taskContextTracker = {
      pendingManagedTaskIds: new Set<string>(),
      addContext: () => {},
      contextFilesForPrompt: () => [],
      prune: () => {},
    };
    const terminalGate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      readRuntime: async (_run, readStartedAt) => ({
        kind: 'quiescent',
        origin: 'test',
        readStartedAt,
      }),
      readTerminalEvidence: async () => ({ data: [] }),
      graceMs: 0,
    });
    const output = {
      output:
        '<task id="child-hook-metadata" state="running"><task_result>unchanged result</task_result></task>',
    };

    try {
      await handleToolExecuteBefore(
        {
          tool: 'task',
          sessionID: ref.parentSessionID,
          callID: 'hook-metadata-call',
        },
        { args: { background: true, subagent_type: 'explorer' } },
        {
          shouldManageSession: () => true,
          backgroundJobBoard: board,
          backgroundTaskConcurrency: scheduler,
          pendingCallTracker,
          taskContextTracker,
        },
      );
      await handleToolExecuteAfter(
        {
          tool: 'task',
          sessionID: ref.parentSessionID,
          callID: 'hook-metadata-call',
        },
        output,
        {
          directory: '/workspace',
          backgroundJobBoard: board,
          pendingCallTracker,
          taskContextTracker,
          terminalGate,
        },
      );
    } finally {
      terminalGate.dispose();
      scheduler.dispose();
    }

    const finalOutput = output.output;
    const markerAt = finalOutput.indexOf('<!-- slim-child-ref:v1 ');
    const logicalLine = /^id: (.+)$/gm;
    const admissionLine = /^admission_id: (.+)$/gm;
    const logicalMatches = [...finalOutput.matchAll(logicalLine)];
    const admissionMatches = [...finalOutput.matchAll(admissionLine)];
    expect(logicalMatches).toHaveLength(1);
    expect(admissionMatches).toHaveLength(1);
    expect(logicalMatches[0]?.index).toBeLessThan(markerAt);
    expect(admissionMatches[0]?.index).toBeLessThan(markerAt);
    expect(readAuthoritativeChildRef(finalOutput)).toMatchObject({
      parentSessionID: ref.parentSessionID,
      sessionID: 'child-hook-metadata',
      agent: 'explorer',
    });
    expect(parseTaskResultFromOutput(finalOutput)).toBe('unchanged result');
  });
});
