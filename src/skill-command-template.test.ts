import { describe, expect, test } from 'bun:test';
import {
  buildSkillCommandPrompt,
  buildSkillCommandTemplate,
  buildSkillInstruction,
  buildUserRequest,
  formatMissingCommandMessage,
} from './skill-command-template';

describe('skill command template', () => {
  test('adds the base-directory hint for a known directory', () => {
    expect(buildSkillInstruction('# Body', '/pkg/skills/codemap')).toBe(
      [
        '<skill-instruction>',
        'Base directory for this skill: /pkg/skills/codemap/',
        'File references (@path) in this skill are relative to this directory.',
        '',
        '# Body',
        '</skill-instruction>',
      ].join('\n'),
    );
  });

  test.each([undefined, ''])('omits the hint for %j', (directory) => {
    expect(buildSkillInstruction('\n\n# Body\n\n', directory)).toBe(
      '<skill-instruction>\n# Body\n</skill-instruction>',
    );
  });

  test('trims the body and wraps arguments verbatim', () => {
    expect(buildUserRequest('  spaced  ')).toBe(
      '<user-request>\n  spaced  \n</user-request>',
    );
  });

  test('separates the instruction block and the argument block', () => {
    expect(buildSkillCommandPrompt('# Body', 'go', '/pkg/skills/a')).toBe(
      [
        '<skill-instruction>',
        'Base directory for this skill: /pkg/skills/a/',
        'File references (@path) in this skill are relative to this directory.',
        '',
        '# Body',
        '</skill-instruction>',
        '',
        '<user-request>',
        'go',
        '</user-request>',
      ].join('\n'),
    );
  });

  test('uses $ARGUMENTS as the host substitution placeholder', () => {
    expect(buildSkillCommandTemplate('# Body')).toBe(
      buildSkillCommandPrompt('# Body', '$ARGUMENTS'),
    );
  });

  test('quotes the missing command name exactly once', () => {
    expect(formatMissingCommandMessage('show-me')).toBe(
      'Command "/show-me" not found. Use the skill tool to list available skills and commands.',
    );
  });
});
