import { describe, expect, test } from 'bun:test';
import { InvalidSkillPolicyError } from '../utils/skill-policy-validation';
import { parseSkillFrontmatterName } from './skill-frontmatter';

describe('parseSkillFrontmatterName', () => {
  test('accepts quoted names and YAML comments', () => {
    expect(
      parseSkillFrontmatterName(`---
name: "quoted-skill" # name comment
description: Test skill. # description comment
---

# body
`),
    ).toBe('quoted-skill');
  });

  test('trims whitespace around quoted names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: " my-skill "
description: Test skill.
---
`),
    ).toBe('my-skill');
  });

  test('accepts block scalar names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: |-
  block-skill
description: Test skill.
---
`),
    ).toBe('block-skill');
  });

  test('trims whitespace around block scalar names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: |-
    block-skill${'  '}
description: Test skill.
---
`),
    ).toBe('block-skill');
  });

  test('accepts CRLF frontmatter', () => {
    expect(
      parseSkillFrontmatterName(
        '---\r\nname: crlf-skill\r\ndescription: Test skill.\r\n---\r\n',
      ),
    ).toBe('crlf-skill');
  });

  test('sanitizes malformed plain values containing colons', () => {
    expect(
      parseSkillFrontmatterName(`---
name: colon:skill
description: Text with a colon: accepted by fallback
---
`),
    ).toBe('colon:skill');
  });

  test('trims quoted names when fallback sanitization is used', () => {
    expect(
      parseSkillFrontmatterName(`---
name: " fallback-skill "
description: Text with a colon: accepted by fallback
---
`),
    ).toBe('fallback-skill');
  });

  test('rejects names that are empty after trimming', () => {
    expect(
      parseSkillFrontmatterName(`---
name: "   "
description: Test skill.
---
`),
    ).toBeUndefined();
  });

  test('rejects non-string names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: true
description: Test skill.
---
`),
    ).toBeUndefined();
  });

  test('R1: integer-index scalar names raise a typed policy error, not absence', () => {
    expect(() =>
      parseSkillFrontmatterName(
        '---\nname: 123\ndescription: Test skill.\n---\n',
      ),
    ).toThrow(InvalidSkillPolicyError);
  });

  test('rejects non-string descriptions', () => {
    expect(
      parseSkillFrontmatterName(`---
name: typed-skill
description: true
---
`),
    ).toBeUndefined();
  });
});
