import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  parseSkillCommandMode,
  resolveSkillCommandMode,
} from './skill-command-mode';
import { withTmpDirSync } from './test-utils';

describe('skill command YAML metadata', () => {
  test('falls back to inline metadata when an existing source file cannot be read', () => {
    withTmpDirSync((root) => {
      const path = join(root, 'SKILL.md');
      fs.writeFileSync(path, '---\nslim:\n  command: none\n---\nbody');
      const read = spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
        throw new Error('EACCES');
      });
      try {
        expect(
          resolveSkillCommandMode(
            {
              path,
              content: '---\nslim:\n  command: reference\n---\nbody',
            },
            'full',
          ),
        ).toBe('reference');
      } finally {
        read.mockRestore();
      }
    });
  });

  test('uses the nested key rather than descriptions, dotted keys, or body text', () => {
    const source = [
      '---',
      'name: display-name',
      'description: |',
      '  slim:',
      '    command: none',
      'slim.command: none',
      'slim:',
      '  command: "reference" # an override',
      '  unrelated:',
      '    - full',
      '---',
      'slim:',
      '  command: none',
    ].join('\n');

    expect(parseSkillCommandMode(source)).toBe('reference');
  });

  test.each([
    'slim.command: none',
    'command: none',
    'slim: null',
    'slim: none',
    'slim: {}',
    'slim:\n  command: false',
    'slim:\n  command: 1',
    'slim:\n  command: null',
    'slim:\n  command: {}',
    'slim:\n  command: NONE',
    'slim:\n  command: " reference "',
    'slim:\n  command: full\n  command: none',
  ])(
    'inherits when slim.command is absent, malformed, or not an enum: %j',
    (yaml) => {
      expect(parseSkillCommandMode(`---\n${yaml}\n---\nbody`)).toBeUndefined();
    },
  );

  test.each(['javascript', 'json', 'yaml'])(
    'does not dispatch a tagged %s engine',
    (language) => {
      expect(
        parseSkillCommandMode(
          `---${language}\nslim:\n  command: none\n---\nbody`,
        ),
      ).toBeUndefined();
    },
  );
});
