export const PROMPT_TEMPLATE_MARKER = '<!-- slim-prompt-template:v1 -->';

const SECTION_TOKEN_PATTERN = /\\?\{\{slim\.section\.([a-z0-9_-]+)\}\}/g;
const MALFORMED_TOKEN_PATTERN = /(?<!\\)\{\{slim\.section\b/;

export class PromptTemplateError extends Error {
  readonly source: string;
  readonly token: string;

  constructor(source: string, token: string) {
    super(`Unknown or malformed prompt section '${token}' in ${source}`);
    this.name = 'PromptTemplateError';
    this.source = source;
    this.token = token;
  }
}

export function renderPromptTemplate(
  prompt: string,
  sections: Readonly<Record<string, string>>,
  source = '<prompt>',
): string {
  if (!isMarkedTemplate(prompt)) return prompt;

  const body = prompt
    .slice(PROMPT_TEMPLATE_MARKER.length)
    .replace(/^\r?\n/, '');
  const malformedToken = body
    .replace(SECTION_TOKEN_PATTERN, '')
    .match(MALFORMED_TOKEN_PATTERN);
  if (malformedToken?.[0]) {
    throw new PromptTemplateError(source, malformedToken[0]);
  }

  const rendered = body.replace(
    SECTION_TOKEN_PATTERN,
    (token, sectionName: string) => {
      if (token.startsWith('\\')) return token.slice(1);

      if (!Object.hasOwn(sections, sectionName)) {
        throw new PromptTemplateError(source, token);
      }
      const section = sections[sectionName];
      return section;
    },
  );

  return rendered;
}

function isMarkedTemplate(prompt: string): boolean {
  return (
    prompt === PROMPT_TEMPLATE_MARKER ||
    prompt.startsWith(`${PROMPT_TEMPLATE_MARKER}\n`) ||
    prompt.startsWith(`${PROMPT_TEMPLATE_MARKER}\r\n`)
  );
}
