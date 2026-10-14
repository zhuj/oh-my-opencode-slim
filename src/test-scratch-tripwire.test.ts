/** Enforce shared, OS-temp-root scratch allocation in test code. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { maskNonCode } from './test-scratch-lexical';
import { isScratchViolation } from './test-scratch-scanner';

const SRC_ROOT = import.meta.dir;
const SCANNED_SUPPORT = [
  join(SRC_ROOT, 'v2/test-fixtures.ts'),
  join(SRC_ROOT, 'hooks/apply-patch/test-helpers.ts'),
  join(SRC_ROOT, '../test-isolation.ts'),
  join(SRC_ROOT, '../test-support/r01-terminal-assembly.ts'),
  join(SRC_ROOT, 'test-scratch-scanner.ts'),
  join(SRC_ROOT, 'test-scratch-lexical.ts'),
];

const ALLOWLIST = new Map<string, string>([
  ['src/test-utils.ts', 'The shared scratch allocation implementation.'],
  [
    'src/test-scratch-tripwire.test.ts',
    'The scanner source contains primitive names as inert match patterns.',
  ],
]);

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listTestFiles(join(dir, entry.name)));
    else if (entry.name.endsWith('.test.ts')) out.push(join(dir, entry.name));
  }
  return out;
}

describe('test scratch directory tripwire', () => {
  const files = [...listTestFiles(SRC_ROOT), ...SCANNED_SUPPORT];

  test('scans a non-empty set of test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('matches scratch creation but not inert path-like text', () => {
    expect(isScratchViolation("mkdtemp(join(process.cwd(), 'scratch-'))")).toBe(
      true,
    );
    expect(isScratchViolation("mkdirSync('/tmp/fixed')")).toBe(true);
    expect(isScratchViolation("mkdirSync(\n  '/tmp/fixed',\n)")).toBe(true);
    expect(isScratchViolation("mkdtempSync(\n  'prefix-',\n)")).toBe(true);
    expect(isScratchViolation("expect(mkdtemp('prefix-')).toBeDefined()")).toBe(
      true,
    );
    expect(
      isScratchViolation("const options = { directory: mkdtemp('prefix-') }"),
    ).toBe(true);
    expect(isScratchViolation("const directory = '/tmp/example'")).toBe(false);
    expect(isScratchViolation("expect(value).toBe('/tmp/example')")).toBe(
      false,
    );
    expect(
      isScratchViolation(
        "// mkdir('/tmp/comment')\nconst text = 'mkdtemp(\"x\")'",
      ),
    ).toBe(false);
    expect(maskNonCode('😀').length).toBe(2);
    expect(isScratchViolation("😀 mkdtempSync('prefix-')")).toBe(true);
    const templateExpression = [
      'const dir = `',
      String.fromCharCode(36),
      "{mkdtempSync('prefix-')}`",
    ].join('');
    expect(isScratchViolation(templateExpression)).toBe(true);
    expect(
      isScratchViolation("const pattern = /'/; mkdtempSync('prefix-')"),
    ).toBe(true);
    expect(
      isScratchViolation(
        "mkdirSync(join(root, 'child') /* allocated under tmpdir() */)",
      ),
    ).toBe(false);
    expect(
      isScratchViolation("mkdirSync(join(root, 'homedir() tmpdir()'))"),
    ).toBe(false);
    expect(isScratchViolation("mkdirSync(join(process.cwd(), 'child'))")).toBe(
      true,
    );
    expect(isScratchViolation("mkdirSync('/var/tmp/fixed')")).toBe(true);
    expect(isScratchViolation('mkdirSync(`/tmp/fixed-scratch`)')).toBe(true);
    expect(isScratchViolation('mkdirSync(root) /* /tmp/fixed-scratch */')).toBe(
      false,
    );
    expect(
      isScratchViolation(
        "mkdirSync(join(root, 'child') /* example: '/tmp/fixed-scratch' */)",
      ),
    ).toBe(false);
    expect(
      isScratchViolation(
        "const pattern = /* explanation */ /'/; mkdtempSync('prefix-')",
      ),
    ).toBe(true);
    expect(
      isScratchViolation(
        "/* explanation */ const ratio = 1 / mkdtempSync('prefix-').length;",
      ),
    ).toBe(true);
    expect(
      isScratchViolation(
        "const pattern = // explanation\n /'/; mkdtempSync('prefix-');",
      ),
    ).toBe(true);
    expect(
      isScratchViolation(
        "const ratio = // explanation\n  1 / mkdtempSync('prefix-').length;",
      ),
    ).toBe(true);
    expect(
      isScratchViolation(
        "mkdirSync(join(root,\n // fixture child\n 'child') /* example: '/tmp/fixed-scratch' */);",
      ),
    ).toBe(false);
    expect(isScratchViolation('mkdirSync(`C:/scratch`)')).toBe(true);
    expect(isScratchViolation("mkdirSync('C:/mock/path')")).toBe(true);
    expect(isScratchViolation('mkdirSync(tmpdir())')).toBe(true);
    expect(isScratchViolation('mkdirSync(homedir())')).toBe(true);
    const inertTemplateExpression = [
      'const text = `',
      String.fromCharCode(36),
      '{\'mkdtempSync("prefix-")\'}`',
    ].join('');
    expect(isScratchViolation(inertTemplateExpression)).toBe(false);
    expect(
      isScratchViolation("function f() { return /'/; mkdtempSync('prefix-') }"),
    ).toBe(true);
    expect(
      isScratchViolation(
        "function f() { return /[/']/; mkdtempSync('prefix-') }",
      ),
    ).toBe(true);
  });

  for (const file of files) {
    const rel = relative(resolve(SRC_ROOT, '..'), file);
    if (ALLOWLIST.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    const violations = isScratchViolation(source)
      ? [`${relative(resolve(SRC_ROOT, '..'), file)}: scratch creation`]
      : [];
    if (violations.length > 0) {
      test(`${rel} creates scratch outside src/test-utils.ts`, () => {
        expect(violations.join('\n')).toBe(
          'no scratch creation outside the shared helper',
        );
      });
    }
  }
});
