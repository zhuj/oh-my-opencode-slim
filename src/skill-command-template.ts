/**
 * `<skill-instruction>` block. `baseDirectory` is the directory CONTAINING
 * SKILL.md; when it is unknown the two hint lines are omitted so the body is
 * never anchored to a wrong path.
 */
export function buildSkillInstruction(
  body: string,
  baseDirectory?: string,
): string {
  const hint =
    baseDirectory === undefined || baseDirectory === ''
      ? ''
      : `Base directory for this skill: ${baseDirectory}/\nFile references (@path) in this skill are relative to this directory.\n\n`;
  return `<skill-instruction>\n${hint}${body.trim()}\n</skill-instruction>`;
}

/** `<user-request>` block wrapping the invocation arguments verbatim. */
export function buildUserRequest(args: string): string {
  return `<user-request>\n${args}\n</user-request>`;
}

/** Prompt for a resolved invocation: instruction block, blank line, arguments. */
export function buildSkillCommandPrompt(
  body: string,
  args: string,
  baseDirectory?: string,
): string {
  return `${buildSkillInstruction(body, baseDirectory)}\n\n${buildUserRequest(args)}`;
}

/** Load by ID through the native skill tool; arguments remain a separate block. */
export function buildSkillReferencePrompt(id: string, args: string): string {
  return buildSkillCommandPrompt(
    `Use the skill tool to load and follow the exact skill ID ${JSON.stringify(id)}.`,
    args,
  );
}
