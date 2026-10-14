/**
 * Shared prompt template for skill slash commands. In full mode, both hosts
 * inline the same body bytes between `<skill-instruction>` tags (with a
 * base-directory hint when one is known) and the user's arguments
 * follow in an explicit `<user-request>` block.
 *
 * Full-mode shape pinned to the sibling implementation:
 * `packages/skills-loader-core/src/features/opencode-skill-loader/`
 * `loaded-skill-from-path.ts` (directory variant) and
 * `skill-definition-record.ts` (no-directory variant).
 */

/** Host-side placeholder v1 substitutes with the raw command arguments. */
export const SKILL_COMMAND_ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

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

/**
 * Command template for hosts that substitute `$ARGUMENTS` themselves (v1).
 * Pure data: no timestamps, ids, or per-request values reach the prompt.
 */
export function buildSkillCommandTemplate(
  body: string,
  baseDirectory?: string,
): string {
  return buildSkillCommandPrompt(
    body,
    SKILL_COMMAND_ARGUMENTS_PLACEHOLDER,
    baseDirectory,
  );
}

/** Reply for a slash command that matches no command and no skill. */
export function formatMissingCommandMessage(name: string): string {
  return `Command "/${name}" not found. Use the skill tool to list available skills and commands.`;
}
