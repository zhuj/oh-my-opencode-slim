import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils';
import {
  getV2NativeProjectSkillRoots,
  loadV2ProjectSkillSources,
  scanV2NativeProjectSkillNames,
} from './project-skill-loader';

const fixtures: string[] = [];
function fixture(): string {
  const root = createTmpDir();
  fixtures.push(root);
  return root;
}

/** Chunk size used by the header reader. */
const CHUNK_BYTES = 4096;

function writeSkill(project: string, folder: string, content: string): void {
  const directory = join(project, '.opencode', 'skills', folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), content);
}

/**
 * The whole-buffer reference the chunked reader must reproduce exactly.
 */
function referenceHeader(content: string): string | undefined {
  return content.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
}

/**
 * Totals the characters the implementation hands to the regex engine, so a
 * re-scan of the whole accumulated header fails loudly without timing.
 */
function measureRegexInput(): {
  readonly largest: () => number;
  readonly total: () => number;
  restore: () => void;
} {
  const originalMatch = String.prototype.match;
  const originalExec = RegExp.prototype.exec;
  let largest = 0;
  let total = 0;
  const record = (subject: string): void => {
    largest = Math.max(largest, subject.length);
    total += subject.length;
  };
  String.prototype.match = function (
    this: string,
    pattern: string | RegExp,
  ): RegExpMatchArray | null {
    record(this);
    return originalMatch.call(this, pattern);
  };
  RegExp.prototype.exec = function (
    this: RegExp,
    input: string,
  ): RegExpExecArray | null {
    record(input);
    return originalExec.call(this, input);
  };
  return {
    largest: () => largest,
    total: () => total,
    restore: () => {
      String.prototype.match = originalMatch;
      RegExp.prototype.exec = originalExec;
    },
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) removeTmpDir(root);
});

describe('scanV2NativeProjectSkillNames', () => {
  test('collects frontmatter identities only, deduplicated and sorted', async () => {
    const project = fixture();
    for (const [folder, name] of [
      ['a', 'zed'],
      ['b', 'alpha'],
      ['c', 'zed'],
    ]) {
      const directory = join(project, '.opencode', 'skills', folder);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\n---\nsecret body`,
      );
    }
    const result = await scanV2NativeProjectSkillNames({
      boundaryDirectory: project,
    });
    expect(result).toEqual({ names: ['alpha', 'zed'], complete: true });
    expect(JSON.stringify(result)).not.toContain('secret body');
  });

  test('uses only the bounded frontmatter header for identity and completeness', async () => {
    const project = fixture();
    const directory = join(project, '.opencode', 'skills', 'header-name');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: header-name\n---\n\0${'x'.repeat(100_000)}`,
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['header-name'], complete: true });
  });

  test('treats absent optional roots as empty', async () => {
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: fixture() }),
    ).resolves.toEqual({ names: [], complete: true });
  });

  test('marks escaping roots and unidentified skill files incomplete', async () => {
    const project = fixture();
    const outside = fixture();
    mkdirSync(join(outside, 'skills'));
    mkdirSync(join(project, '.claude'));
    symlinkSync(
      join(outside, 'skills'),
      join(project, '.claude', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const invalid = join(project, '.opencode', 'skills', 'invalid');
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, 'SKILL.md'), 'not frontmatter');
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: [], complete: false });
  });

  test('derives IDs like the host and uses optional frontmatter safely', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'top.md'), '---\ndescription: optional\n---\n');
    writeFileSync(
      join(root, 'nested', 'SKILL.md'),
      '---\nname: named-skill\nautoinvoke: true\n---\n',
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['named-skill', 'top'], complete: true });
  });

  test('marks malformed frontmatter inventory incomplete', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'broken.md'), '---\nname: broken\n');
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toMatchObject({ complete: false });
  });

  test('marks malformed markdown inventory incomplete', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'broken.md'), 'valid markdown\u0000invalid');
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toMatchObject({ complete: false });
  });

  test('keeps valid omitted-name documents eligible by derived ID', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'fallback.md'), '---\ndescription: ok\n---\n');
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['fallback'], complete: true });
  });

  test('ignores nested symlinks to outside files and directories', async () => {
    const project = fixture();
    const outside = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(outside, 'nested'));
    writeFileSync(join(outside, 'escape.md'), '---\nname: escaped\n---\n');
    writeFileSync(
      join(outside, 'nested', 'SKILL.md'),
      '---\nname: escaped-dir\n---\n',
    );
    symlinkSync(join(outside, 'escape.md'), join(root, 'escape.md'));
    symlinkSync(
      join(outside, 'nested'),
      join(root, 'nested'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: [], complete: false });
  });

  test('marks an unreadable optional root incomplete but absent roots complete', async () => {
    const project = fixture();
    mkdirSync(join(project, '.claude'));
    writeFileSync(join(project, '.claude', 'skills'), 'not a directory');
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: [], complete: false });
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: fixture() }),
    ).resolves.toEqual({ names: [], complete: true });
  });
});

describe('loadV2ProjectSkillSources', () => {
  test('lists pinned native roots in host order', () => {
    const project = fixture();
    expect(getV2NativeProjectSkillRoots(project)).toEqual([
      join(project, '.opencode', 'skills'),
      join(project, '.opencode', 'skill'),
      join(project, '.claude', 'skills'),
      join(project, '.agents', 'skills'),
    ]);
  });

  test('loads confined candidates with only validated metadata', async () => {
    const project = fixture();
    const directory = join(project, 'skills', 'team');
    mkdirSync(directory, { recursive: true });
    const skillFilePath = join(directory, 'SKILL.md');
    const content =
      '---\nname: team\ndescription: Team skill\nautoinvoke: false\n---\nBody.\n';
    writeFileSync(skillFilePath, content);
    await expect(
      loadV2ProjectSkillSources({
        projectBoundary: project,
        candidates: [{ name: 'team', directory, skillFilePath }],
      }),
    ).resolves.toEqual([
      {
        name: 'team',
        directory,
        skillFilePath,
        description: 'Team skill',
        autoinvoke: false,
        content,
      },
    ]);
  });

  test('rejects name drift, symlink files, and paths outside the canonical boundary', async () => {
    const project = fixture();
    const outside = fixture();
    const dir = join(project, 'local');
    mkdirSync(dir);
    const real = join(dir, 'real.md');
    const linked = join(dir, 'SKILL.md');
    writeFileSync(real, '---\nname: actual\n---\nBody');
    symlinkSync(
      real,
      linked,
      process.platform === 'win32' ? 'file' : undefined,
    );
    const other = join(outside, 'SKILL.md');
    writeFileSync(other, '---\nname: external\n---\nBody');
    await expect(
      loadV2ProjectSkillSources({
        projectBoundary: project,
        candidates: [
          { name: 'wrong', directory: dir, skillFilePath: linked },
          { name: 'external', directory: outside, skillFilePath: other },
        ],
      }),
    ).resolves.toEqual([]);
  });

  test('requires the contained directory to match candidate name', async () => {
    const project = fixture();
    const directory = join(project, 'skills', 'actual');
    mkdirSync(directory, { recursive: true });
    const skillFilePath = join(directory, 'SKILL.md');
    writeFileSync(skillFilePath, '---\nname: claimed\n---\nBody');
    await expect(
      loadV2ProjectSkillSources({
        projectBoundary: project,
        candidates: [{ name: 'claimed', directory, skillFilePath }],
      }),
    ).resolves.toEqual([]);
  });

  test('preserves resolver order for first-name-wins deduplication', async () => {
    const project = fixture();
    const candidates = ['z', 'a'].map((parent) => {
      const directory = join(project, 'skills', parent, 'shared');
      mkdirSync(directory, { recursive: true });
      const skillFilePath = join(directory, 'SKILL.md');
      writeFileSync(skillFilePath, `---\nname: shared\n---\n${parent}`);
      return { name: 'shared', directory, skillFilePath };
    });
    const forward = await loadV2ProjectSkillSources({
      projectBoundary: project,
      candidates,
    });
    const reversed = await loadV2ProjectSkillSources({
      projectBoundary: project,
      candidates: [...candidates].reverse(),
    });
    expect(forward[0]?.skillFilePath).toBe(candidates[0]?.skillFilePath);
    expect(reversed[0]?.skillFilePath).toBe(candidates[1]?.skillFilePath);
  });
});

describe('frontmatter header scanning', () => {
  test('accepts a BOM-prefixed header', async () => {
    const project = fixture();
    writeSkill(
      project,
      'bom-folder',
      '\uFEFF---\nname: bom-skill\n---\nbody\n',
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['bom-skill'], complete: true });
  });

  test('accepts CRLF headers', async () => {
    const project = fixture();
    writeSkill(
      project,
      'crlf-folder',
      '---\r\nname: crlf-skill\r\n---\r\nbody\r\n',
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['crlf-skill'], complete: true });
  });

  test('finds a closing delimiter split across two reads', async () => {
    const project = fixture();
    const open = '---\nname: split\n';
    const content = `${open}${'x'.repeat(CHUNK_BYTES - 1 - open.length)}\n---\ntail`;
    // The newline ends the first read; the dashes only arrive in the second.
    expect(content.indexOf('\n---')).toBe(CHUNK_BYTES - 1);
    writeSkill(project, 'chunk-boundary', content);
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['split'], complete: true });
  });

  test('finds a CRLF closing delimiter split across two reads', async () => {
    const project = fixture();
    const open = '---\r\nname: crlf-split\r\n';
    const content = `${open}${'x'.repeat(CHUNK_BYTES - 1 - open.length)}\r\n---\r\ntail`;
    expect(content.indexOf('\r\n---')).toBe(CHUNK_BYTES - 1);
    writeSkill(project, 'crlf-boundary', content);
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['crlf-split'], complete: true });
  });

  test('stops at the first closing delimiter inside a multi-read body', async () => {
    const project = fixture();
    writeSkill(
      project,
      'inner-delimiter',
      `---\nname: inner\n${'x'.repeat(CHUNK_BYTES + 5)}\n---\nname: outer\n---\ntail`,
    );
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: ['inner'], complete: true });
  });

  test('rejects a header whose closing delimiter starts at the read cap', async () => {
    const project = fixture();
    const prefix = '---\nname: beyond\n';
    const content = `${prefix}${'x'.repeat(1024 * 1024 - prefix.length - 1)}\n---\nname: late\n---\n`;
    // The dashes begin exactly at maxHeaderBytes, which stays unread.
    expect(content.indexOf('---', 1024 * 1024)).toBe(1024 * 1024);
    writeSkill(project, 'over-cap', content);
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({ names: [], complete: false });
  });

  test('rejects empty and truncated headers', async () => {
    for (const content of [
      '',
      '--',
      '---',
      '---\n',
      '--\nname: x\n---\n',
      'not frontmatter',
    ]) {
      const project = fixture();
      writeSkill(project, 'short', content);
      await expect(
        scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
      ).resolves.toEqual({ names: [], complete: false });
    }
  });

  test('agrees with the whole-buffer reference regex at every chunk alignment', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    const cases: { readonly name: string; readonly content: string }[] = [];
    let index = 0;
    for (const bom of ['', '\uFEFF'])
      for (const [lineEnding, open] of [
        ['\n', '---\n'],
        ['\r\n', '---\r\n'],
      ] as const)
        for (let pad = CHUNK_BYTES - 20; pad <= CHUNK_BYTES + 4; pad += 1)
          for (const closing of [`${lineEnding}---${lineEnding}tail`, null]) {
            const name = `probe-${index++}`;
            cases.push({
              name,
              content: `${bom}${open}name: ${name}${lineEnding}${'x'.repeat(pad)}${closing ?? ''}`,
            });
          }
    const expectedNames: string[] = [];
    let unterminated = 0;
    for (const { name, content } of cases) {
      const header = referenceHeader(content);
      // Unterminated probes are written too, so the reader has to reject them
      // at every alignment instead of those alignments going untested.
      writeFileSync(join(root, `${name}.md`), content);
      if (header === undefined) {
        unterminated += 1;
        continue;
      }
      expect(header).toContain(`name: ${name}`);
      expectedNames.push(name);
    }
    expect(unterminated).toBeGreaterThan(0);
    await expect(
      scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
    ).resolves.toEqual({
      names: expectedNames.sort(),
      complete: unterminated === 0,
    });
  });

  test('rescans only the newly read tail of an unterminated header', async () => {
    const project = fixture();
    const size = 256 * 1024;
    writeSkill(
      project,
      'unterminated',
      `---\nname: unterminated\n${'x'.repeat(size)}`,
    );
    const meter = measureRegexInput();
    try {
      await expect(
        scanV2NativeProjectSkillNames({ boundaryDirectory: project }),
      ).resolves.toEqual({ names: [], complete: false });
    } finally {
      meter.restore();
    }
    expect(meter.largest()).toBeLessThanOrEqual(size / 4);
    expect(meter.total()).toBeLessThanOrEqual(size * 8);
  });
});
