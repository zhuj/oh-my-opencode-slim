import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withTmpDir } from '../test-utils';
import * as documentModule from './document';
import * as parserModule from './parser';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewService } from './service';
import type { InterviewMessage, InterviewRecord } from './types';

// Capture the real implementations BEFORE the counters wrap them so the
// wrappers below can never recurse into themselves.
const realDocument = { ...documentModule };
const realParser = { ...parserModule };

const counters = {
  lockTaken: 0,
  lockReleased: 0,
  documentReads: 0,
  documentWrites: 0,
  stateParses: 0,
  blockParses: 0,
};

mock.module('./document', () => ({
  ...realDocument,
  parseSpecBlocks: (document: string) => {
    counters.blockParses += 1;
    return realDocument.parseSpecBlocks(document);
  },
  withInterviewDocumentLock: async <T>(
    markdownPath: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    counters.lockTaken += 1;
    try {
      return await realDocument.withInterviewDocumentLock(
        markdownPath,
        operation,
      );
    } finally {
      counters.lockReleased += 1;
    }
  },
  readInterviewDocument: async (record: InterviewRecord): Promise<string> => {
    counters.documentReads += 1;
    return realDocument.readInterviewDocument(record);
  },
  rewriteInterviewDocument: async (
    ...args: Parameters<typeof realDocument.rewriteInterviewDocument>
  ): Promise<string> => {
    counters.documentWrites += 1;
    return realDocument.rewriteInterviewDocument(...args);
  },
  rewriteInterviewDocumentWithFinalSpec: async (
    ...args: Parameters<
      typeof realDocument.rewriteInterviewDocumentWithFinalSpec
    >
  ): Promise<string> => {
    counters.documentWrites += 1;
    return realDocument.rewriteInterviewDocumentWithFinalSpec(...args);
  },
}));

mock.module('./parser', () => ({
  ...realParser,
  findLatestAssistantState: (
    ...args: Parameters<typeof realParser.findLatestAssistantState>
  ) => {
    counters.stateParses += 1;
    return realParser.findLatestAssistantState(...args);
  },
}));

afterAll(() => {
  mock.module('./document', () => realDocument);
  mock.module('./parser', () => realParser);
});

beforeEach(() => {
  counters.lockTaken = 0;
  counters.lockReleased = 0;
  counters.documentReads = 0;
  counters.documentWrites = 0;
  counters.stateParses = 0;
  counters.blockParses = 0;
});

function assistantMessage(options: {
  id: string;
  text: string;
}): InterviewMessage {
  return {
    info: { role: 'assistant', id: options.id },
    parts: [{ type: 'text', text: options.text }],
  };
}

function interviewStateMessage(options: {
  id: string;
  summary: string;
  title: string;
  question: string;
  patch?: string;
}): InterviewMessage {
  return assistantMessage({
    id: options.id,
    text: `<interview_state>${JSON.stringify({
      summary: options.summary,
      title: options.title,
      patch: options.patch,
      questions: [
        { id: 'q-1', question: options.question, options: ['Web', 'Mobile'] },
      ],
    })}</interview_state>`,
  });
}

function createHarness(directory: string) {
  const messages: InterviewMessage[] = [];
  const readSessionIDs: string[] = [];
  let transcriptReads = 0;
  let onRead: ((count: number) => void) | undefined;
  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => {
      readSessionIDs.push(sessionID);
      transcriptReads += 1;
      onRead?.(transcriptReads);
      return messages;
    },
    notify: async () => {},
    continue: async () => {},
    rename: async () => {},
  };
  const service = createInterviewService({ directory } as never, undefined, {
    runtime,
    openBrowser: () => {},
  });
  service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

  return {
    service,
    messages,
    readSessionIDs,
    transcriptReads: () => transcriptReads,
    observeReads: (observer: (count: number) => void) => {
      onRead = observer;
    },
  };
}

async function startInterview(
  service: ReturnType<typeof createHarness>['service'],
  sessionID: string,
  idea: string,
): Promise<string> {
  await service.handleCommandExecuteBefore(
    { command: 'interview', sessionID, arguments: idea },
    { parts: [] },
  );
  const interviewId = service.getActiveInterviewId(sessionID);
  expect(interviewId).not.toBeNull();
  counters.lockTaken = 0;
  counters.lockReleased = 0;
  counters.documentReads = 0;
  counters.documentWrites = 0;
  return interviewId as string;
}

async function lockFileCount(directory: string): Promise<number> {
  const interviewDir = path.join(directory, '.local', 'interview');
  const entries = await fs.readdir(interviewDir);
  return entries.filter((entry) => entry.endsWith('.lock')).length;
}

describe('interview poll cost', () => {
  test('returned questions and blocks cannot mutate the next poll', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const id = await startInterview(service, 'ses_copy', 'Copy');
      messages.push(
        interviewStateMessage({
          id: 'state',
          summary: 'Draft',
          title: 'Copy',
          question: 'Platform?',
        }),
      );
      const first = await service.getInterviewState(id);
      first.questions[0].question = 'Mutated';
      first.questions[0].options.push('Mutated');
      first.blocks.length = 0;
      const second = await service.getInterviewState(id);
      expect(second.questions[0].question).toBe('Platform?');
      expect(second.questions[0].options).toEqual(['Web', 'Mobile']);
      expect(second.blocks.length).toBeGreaterThan(0);
    });
  });

  test('observes equal-length edits to unconsumed earlier messages with an unchanged tail', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const id = await startInterview(service, 'ses_edit', 'Edit');
      const makeState = (summary: string) =>
        interviewStateMessage({
          id: 'state',
          summary,
          title: 'Edit',
          question: 'Platform?',
        });
      const malformed = makeState('First');
      malformed.parts = [
        {
          type: 'text',
          text: malformed.parts?.[0]?.text?.replace('"summary":', '"summary";'),
        },
      ];
      messages.push(malformed, assistantMessage({ id: 'tail', text: 'Done' }));
      await service.getInterviewState(id);
      messages[0] = makeState('Other');
      const state = await service.getInterviewState(id);
      expect(state.summary).toBe('Other');
      expect(state.document).toContain('Other');
    });
  });

  test('preserves external history and summary edits on a cached poll', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const id = await startInterview(service, 'ses_file', 'File');
      messages.push(
        interviewStateMessage({
          id: 'state',
          summary: 'Draft',
          title: 'File',
          question: 'Platform?',
        }),
      );
      const first = await service.getInterviewState(id);
      const file = path.join(directory, first.markdownPath);
      await fs.writeFile(
        file,
        first.document.replace('No answers yet.', 'External history'),
      );
      const history = await service.getInterviewState(id);
      expect(history.document).toContain('External history');
      expect(counters.documentWrites).toBe(1);
      await fs.writeFile(file, history.document.replace('Draft', 'Edited'));
      const edited = await service.getInterviewState(id);
      expect(edited.document).toContain('Edited');
      expect(edited.document).toContain('External history');
      expect(edited.document).not.toContain('\nDraft\n');
      expect(edited.summary).toBe('Edited');
      expect(counters.documentWrites).toBe(1);
    });
  });

  test('distinguishes unknown busy status from explicit idle without structured state', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      messages.push(assistantMessage({ id: 'plain', text: 'Plain response' }));
      const id = await startInterview(service, 'ses_busy', 'Busy');
      expect((await service.getInterviewState(id)).mode).toBe('awaiting-agent');
      await service.handleEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'ses_busy',
            status: { type: 'idle' },
          },
        },
      });
      expect((await service.getInterviewState(id)).mode).toBe('completed');
    });
  });

  test('a consumed unpatched state without message IDs cannot restore an externally edited spec', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const id = await startInterview(service, 'ses_consumed', 'Consumed');
      const message = interviewStateMessage({
        id: 'state',
        summary: 'Draft',
        title: 'Consumed',
        question: 'Platform?',
      });
      message.info = { role: 'assistant' };
      messages.push(message);
      const first = await service.getInterviewState(id);
      await fs.writeFile(
        path.join(directory, first.markdownPath),
        first.document.replace('\nDraft\n', '\nExternal spec\n'),
      );
      for (let poll = 0; poll < 2; poll++) {
        const current = await service.getInterviewState(id);
        expect(current.summary).toBe('External spec');
        expect(current.document).toContain('\nExternal spec\n');
        expect(current.document).not.toContain('\nDraft\n');
        expect(current.questions).toEqual(first.questions);
        expect(counters.documentWrites).toBe(1);
      }
      await fs.writeFile(
        path.join(directory, first.markdownPath),
        first.document.replace('\nDraft\n', '\n\n'),
      );
      const cleared = await service.getInterviewState(id);
      expect(cleared.summary).toBe('');
      expect(cleared.document).not.toContain('\nDraft\n');
      expect(counters.documentWrites).toBe(1);
    });
  });

  test('cached polls retain tool precedence and report newer malformed state ahead of busy status', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const id = await startInterview(service, 'ses_precedence', 'Precedence');
      await service.submitState(
        'ses_precedence',
        {
          summary: 'Tool spec',
          questions: [
            { id: 'tool-q', question: 'Tool question?', options: [] },
          ],
        },
        'tool-message',
      );
      messages.push(
        interviewStateMessage({
          id: 'tool-message',
          summary: 'Printed spec',
          title: 'Printed title',
          question: 'Printed question?',
        }),
      );
      for (let poll = 0; poll < 2; poll++) {
        const current = await service.getInterviewState(id);
        expect(current.summary).toBe('Tool spec');
        expect(current.questions.map((question) => question.id)).toEqual([
          'tool-q',
        ]);
        expect(current.document).not.toContain('Printed spec');
        expect(current.mode).toBe('awaiting-user');
      }
      messages.push(
        assistantMessage({
          id: 'newer-message',
          text: '<interview_state>{broken}</interview_state>',
        }),
      );
      await service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses_precedence', status: { type: 'busy' } },
        },
      });
      for (let poll = 0; poll < 2; poll++) {
        const current = await service.getInterviewState(id);
        expect(current.mode).toBe('error');
        expect(current.isBusy).toBe(true);
        expect(current.lastParseError).toBe('Failed to parse interview state');
        expect(current.document).toContain('Tool spec');
      }
      expect(counters.documentWrites).toBe(1);
    });
  });

  test('a repeated poll reads under lock without rewriting an unchanged document', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages, transcriptReads, readSessionIDs } =
        createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_cost',
        'Poll Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Draft summary',
          title: 'poll-cost',
          question: 'Which platform?',
        }),
      );

      const first = await service.getInterviewState(interviewId);
      expect(
        readSessionIDs.every((sessionID) => sessionID === 'ses_cost'),
      ).toBe(true);
      expect(counters.documentWrites).toBe(1);
      expect(counters.lockTaken).toBe(1);
      expect(counters.stateParses).toBe(1);
      expect(counters.blockParses).toBe(1);
      const readsAfterFirst = transcriptReads();
      const documentReadsAfterFirst = counters.documentReads;
      const stateParsesAfterFirst = counters.stateParses;
      const blockParsesAfterFirst = counters.blockParses;

      const second = await service.getInterviewState(interviewId);

      // External edits require a fresh document read under the existing lock.
      expect(transcriptReads() - readsAfterFirst).toBe(1);
      expect(counters.documentWrites).toBe(1);
      expect(counters.lockTaken).toBe(2);
      expect(counters.documentReads - documentReadsAfterFirst).toBe(1);
      expect(counters.stateParses).toBe(stateParsesAfterFirst);
      expect(counters.blockParses).toBe(blockParsesAfterFirst);

      // The returned state is still the state of that transcript.
      expect(second.summary).toBe(first.summary);
      expect(second.questions).toEqual(first.questions);
      expect(second.mode).toBe(first.mode);
      expect(second.lastParseError).toBe(first.lastParseError);
      expect(second.blocks).toEqual(first.blocks);
      expect(second.document).toBe(first.document);
      expect(second.url).toBe(first.url);
      expect(second.markdownPath).toBe(first.markdownPath);
    });
  });

  test('a new assistant message triggers a locked sync and a document write', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages, transcriptReads } = createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_change',
        'Change Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Draft summary',
          title: 'change-cost',
          question: 'Which platform?',
        }),
      );
      await service.getInterviewState(interviewId);

      // An unchanged poll in between must not hide the later change.
      await service.getInterviewState(interviewId);
      counters.documentWrites = 0;
      counters.lockTaken = 0;
      counters.lockReleased = 0;
      const readsBefore = transcriptReads();

      messages.push(
        interviewStateMessage({
          id: 'msg_2',
          summary: 'Updated summary',
          patch: '@@ -1,1 +1,1 @@\n-Draft summary\n+Updated summary',
          title: 'change-cost',
          question: 'Which scale?',
        }),
      );
      const state = await service.getInterviewState(interviewId);

      expect(transcriptReads() - readsBefore).toBe(1);
      expect(counters.lockTaken).toBe(1);
      expect(counters.lockReleased).toBe(1);
      expect(counters.documentWrites).toBe(1);
      expect(state.summary).toBe('Updated summary');
      expect(state.questions.map((question) => question.question)).toEqual([
        'Which scale?',
      ]);
      expect(state.document).toContain('Updated summary');
      expect(await lockFileCount(directory)).toBe(0);
    });
  });

  test('a title-only change still rewrites the markdown', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_title',
        'Title Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Same summary',
          title: 'first-title',
          question: 'Which platform?',
        }),
      );
      const first = await service.getInterviewState(interviewId);
      expect(first.document).toContain('# first-title');

      messages.push(
        interviewStateMessage({
          id: 'msg_2',
          summary: 'Same summary',
          title: 'second-title',
          question: 'Which platform?',
          patch: '',
        }),
      );
      counters.documentWrites = 0;
      const state = await service.getInterviewState(interviewId);

      expect(counters.documentWrites).toBe(1);
      expect(state.document).toContain('# second-title');
    });
  });

  test('takes and releases the document lock exactly once per locked sync', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_lock',
        'Lock Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Draft summary',
          title: 'lock-cost',
          question: 'Which platform?',
        }),
      );

      await service.getInterviewState(interviewId);
      await service.getInterviewState(interviewId);
      messages.push(
        interviewStateMessage({
          id: 'msg_2',
          summary: 'Another summary',
          patch: '@@ -1,1 +1,1 @@\n-Draft summary\n+Another summary',
          title: 'lock-cost',
          question: 'Which scale?',
        }),
      );
      await service.getInterviewState(interviewId);

      expect(counters.lockTaken).toBe(3);
      expect(counters.lockReleased).toBe(counters.lockTaken);
      expect(await lockFileCount(directory)).toBe(0);
    });
  });

  test('reads each unanswered poll once without rewriting unchanged state', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages, transcriptReads } = createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_wait',
        'Wait Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Draft summary',
          title: 'wait-cost',
          question: 'Which platform?',
        }),
      );
      messages.push({
        info: { role: 'user', id: 'msg_2' },
        parts: [{ type: 'text', text: 'Web' }],
      });

      // First poll after the submitted answer: the tail is unanswered, so this
      // pass still observes the last complete state.
      const waiting = await service.getInterviewState(interviewId);
      expect(waiting.summary).toBe('Draft summary');
      const readsAfterWait = transcriptReads();
      expect(readsAfterWait).toBeGreaterThan(1);

      const firstRetryPoll = await service.getInterviewState(interviewId);
      const firstRetryReads = transcriptReads() - readsAfterWait;
      const secondRetryPoll = await service.getInterviewState(interviewId);
      const secondRetryReads = transcriptReads() - readsAfterWait;

      // Every poll observes current state once; native events drive new replies.
      expect(firstRetryReads).toBe(1);
      expect(secondRetryReads).toBe(2);
      expect(firstRetryPoll.summary).toBe('Draft summary');
      expect(secondRetryPoll.questions).toEqual(waiting.questions);
      expect(counters.documentWrites).toBe(1);
    });
  }, 10_000);

  test('observes an assistant reply on the next poll without retry delays', async () => {
    await withTmpDir(async (directory) => {
      const harness = createHarness(directory);
      const id = await startInterview(harness.service, 'ses_retry', 'Retry');
      harness.messages.push({
        info: { role: 'user' },
        parts: [{ text: 'Answer' }],
      });
      const before = harness.transcriptReads();
      await harness.service.getInterviewState(id);
      expect(harness.transcriptReads() - before).toBe(1);
      harness.messages.push(
        interviewStateMessage({
          id: 'reply',
          summary: 'Reply arrived',
          title: 'Retry',
          question: 'Next?',
        }),
      );
      const state = await harness.service.getInterviewState(id);
      expect(harness.transcriptReads() - before).toBe(2);
      expect(state.summary).toBe('Reply arrived');
    });
  });

  test('preserves the completed spec when unstructured final text arrives on a cached poll', async () => {
    await withTmpDir(async (directory) => {
      const { service, messages } = createHarness(directory);
      const interviewId = await startInterview(
        service,
        'ses_finalize',
        'Finalize Cost',
      );
      messages.push(
        interviewStateMessage({
          id: 'msg_1',
          summary: 'Draft summary',
          title: 'finalize-cost',
          question: 'Which platform?',
        }),
      );
      await service.getInterviewState(interviewId);
      await service.getInterviewState(interviewId);

      await service.handleNudgeAction(interviewId, 'confirm-complete');
      messages.push(
        assistantMessage({
          id: 'msg_2',
          text: '# Final spec\n\nA polished final specification.',
        }),
      );
      await service.getInterviewState(interviewId);

      counters.documentWrites = 0;
      counters.lockTaken = 0;
      await service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses_finalize', status: { type: 'idle' } },
        },
      });
      const state = await service.getInterviewState(interviewId);

      // Completion is authoritative: later plain text is not a spec patch.
      expect(counters.lockTaken).toBe(1);
      expect(counters.documentWrites).toBe(0);
      expect(state.document).toContain('Draft summary');
      expect(state.document).not.toContain('A polished final specification.');
      expect(state.mode).toBe('completed');
      expect(state.document).toContain('status: complete');
    });
  });
});
