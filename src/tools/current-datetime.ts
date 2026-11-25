import { type ToolDefinition, tool } from '@opencode-ai/plugin';

const DEFAULT_FORMAT = 'YYYYMMDD-HHmm';

export function formatCurrentDateTime(
  date: Date,
  format = DEFAULT_FORMAT,
  utc = false,
): string {
  const parts: Record<string, string> = {
    YYYY: String(utc ? date.getUTCFullYear() : date.getFullYear()).padStart(
      4,
      '0',
    ),
    MM: String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(
      2,
      '0',
    ),
    DD: String(utc ? date.getUTCDate() : date.getDate()).padStart(2, '0'),
    HH: String(utc ? date.getUTCHours() : date.getHours()).padStart(2, '0'),
    mm: String(utc ? date.getUTCMinutes() : date.getMinutes()).padStart(2, '0'),
    ss: String(utc ? date.getUTCSeconds() : date.getSeconds()).padStart(2, '0'),
  };

  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => parts[token]);
}

export function createCurrentDateTimeTool(): Record<
  'current_datetime',
  ToolDefinition
> {
  const current_datetime = tool({
    description:
      'Return the current date and time. Tokens: YYYY, MM, DD, HH, mm, ss.',
    args: {
      format: tool.schema
        .string()
        .optional()
        .describe(
          'Output format using YYYY (year), MM (month), DD (day), HH (24-hour), mm (minute), and ss (second). Defaults to YYYYMMDD-HHmm (for example, 20260927-0742). Other examples: YYYY-MM-DD, YYYYMMDD, YYYY-MM-DD-HHmm.',
        ),
      utc: tool.schema
        .boolean()
        .optional()
        .describe('Use UTC instead of local time. Defaults to false.'),
    },
    async execute(args) {
      return formatCurrentDateTime(new Date(), args.format, args.utc);
    },
  });

  return { current_datetime };
}
