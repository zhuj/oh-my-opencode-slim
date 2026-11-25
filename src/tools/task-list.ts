import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { isRecord } from '../utils/guards';
import { SESSION_ID_PATTERN, withTimeout } from '../utils/session';
import {
  hostRoundStateOf,
  hostRunningSince,
  isHostTimestamp,
} from '../utils/session-runtime-status';
import type { V2Session } from '../v2/types';

const MAX_HOST_PAGES = 10;
const MAX_HOST_PAGE_SIZE = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const READ_TIMEOUT_MS = 5_000;
const z = tool.schema;
const statuses = [
  'running',
  'completed',
  'error',
  'cancelled',
  'unknown',
] as const;
type TaskStatus = (typeof statuses)[number];
const terminalStatus = {
  succeeded: 'completed',
  failed: 'error',
  interrupted: 'cancelled',
} as const;
const cursorKey = randomBytes(32);

const argsSchema = z.object({
  statuses: z
    .array(z.enum(statuses))
    .optional()
    .describe(
      'Retained states to include; omitted means all, empty means none',
    ),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_HOST_PAGE_SIZE).optional(),
  cursor: z
    .string()
    .min(1)
    .max(8_192)
    .optional()
    .describe('Continuation cursor returned by this tool'),
});

function isoTime(time: unknown): string | null {
  return isHostTimestamp(time) && Number.isFinite(new Date(time).getTime())
    ? new Date(time).toISOString()
    : null;
}

function cursorSignature(parentID: string, cursor: string): string {
  return createHmac('sha256', cursorKey)
    .update(JSON.stringify([parentID, cursor]))
    .digest('base64url');
}

function openCursor(parentID: string, cursor: string): string {
  // OpenCode uses the supplied cursor's filters in preference to parentID.
  // Only send cursors minted by this tool for the same requesting parent.
  const [nativeCursor, signature, extra] = cursor.split('.');
  if (
    !nativeCursor ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    !timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(cursorSignature(parentID, nativeCursor)),
    )
  ) {
    throw new Error('Invalid task_list cursor for this session');
  }
  return nativeCursor;
}

function projectTask(item: Record<string, unknown>) {
  const round = hostRoundStateOf(item);
  const time = isRecord(item.time) ? item.time : undefined;
  const description = typeof item.title === 'string' ? item.title : '';
  let state: TaskStatus = 'unknown';
  if (hostRunningSince(item) !== undefined) state = 'running';
  else if (round.kind === 'terminal') {
    state = terminalStatus[round.outcome];
  }
  return {
    task_id: item.id,
    agent: typeof item.agent === 'string' ? item.agent : null,
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    description_truncated: description.length > MAX_DESCRIPTION_LENGTH,
    state,
    status_uncertain: state === 'unknown',
    timestamps: {
      launched_at: isoTime(time?.created),
      updated_at: isoTime(time?.updated),
      completed_at:
        round.kind === 'terminal' && state !== 'running'
          ? isoTime(round.idleAt)
          : null,
    },
  };
}

export function createTaskListTool(options: {
  session: Pick<V2Session, 'list'>;
}): Record<'task_list', ToolDefinition> {
  return {
    task_list: tool({
      description:
        'List retained native child sessions by stored outcome. Returns bounded pages with native session IDs and ISO timestamps.',
      args: argsSchema.shape,
      async execute(rawArgs, context) {
        const parentID = context?.sessionID;
        if (!parentID) throw new Error('task_list requires sessionID');
        if (!options.session.list)
          throw new Error('OpenCode session.list is unavailable');
        const args = argsSchema.parse(rawArgs);
        const filter = args.statuses ? new Set(args.statuses) : undefined;
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        let skipped = 0;
        let cursor = args.cursor
          ? openCursor(parentID, args.cursor)
          : undefined;
        const tasks: ReturnType<typeof projectTask>[] = [];
        const seenCursors = new Set<string>();
        let exhausted = filter?.size === 0;
        for (
          let page = 0;
          !exhausted && tasks.length < limit && page < MAX_HOST_PAGES;
          page += 1
        ) {
          context.abort?.throwIfAborted();
          const pageSize = Math.min(
            MAX_HOST_PAGE_SIZE,
            offset - skipped + limit - tasks.length,
          );
          // The host cursor retains the parent filter. Keep checking ownership
          // locally as well, including when passed a cursor from another call.
          const response = await withTimeout(
            options.session.list({
              parentID,
              order: 'asc',
              limit: pageSize,
              ...(cursor ? { cursor } : {}),
            }),
            READ_TIMEOUT_MS,
            'task_list host listing timed out',
          );
          if (
            !isRecord(response) ||
            !Array.isArray(response.data) ||
            response.data.length > pageSize ||
            !isRecord(response.cursor)
          ) {
            throw new Error('OpenCode returned an invalid child session page');
          }
          for (const item of response.data) {
            if (
              !isRecord(item) ||
              item.parentID !== parentID ||
              typeof item.id !== 'string' ||
              !SESSION_ID_PATTERN.test(item.id)
            )
              continue;
            const task = projectTask(item);
            if (filter && !filter.has(task.state)) continue;
            if (skipped < offset) skipped += 1;
            else tasks.push(task);
          }
          const nextCursor = response.cursor.next;
          if (
            nextCursor !== undefined &&
            (typeof nextCursor !== 'string' ||
              nextCursor === cursor ||
              seenCursors.has(nextCursor) ||
              !/^[A-Za-z0-9_-]+$/.test(nextCursor) ||
              nextCursor.length > 8_148)
          ) {
            throw new Error(
              'OpenCode returned an invalid child session cursor',
            );
          }
          cursor = nextCursor;
          if (cursor) seenCursors.add(cursor);
          exhausted = !cursor || response.data.length < pageSize;
        }
        return JSON.stringify({
          effect_scope: 'parent',
          parent_session_id: parentID,
          pagination: {
            offset,
            limit,
            total: exhausted && !args.cursor ? skipped + tasks.length : null,
            returned: tasks.length,
            truncated: !exhausted,
            next_cursor:
              !exhausted && cursor
                ? `${cursor}.${cursorSignature(parentID, cursor)}`
                : null,
            next_offset: !exhausted ? offset - skipped : null,
          },
          tasks,
        });
      },
    }),
  };
}
