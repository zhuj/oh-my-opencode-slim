import { type ToolDefinition, tool } from '@opencode-ai/plugin';

export function createGetSessionIdTool(): Record<
  'get_session_id',
  ToolDefinition
> {
  const get_session_id = tool({
    description: 'Return the current invocation session ID.',
    args: {},
    async execute(_args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('get_session_id requires sessionID');
      return sessionID;
    },
  });

  return { get_session_id };
}
