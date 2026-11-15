import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils';
import { readFrontmatterHeader } from './project-skill-loader';

const fixtures: string[] = [];

function fixture(): string {
  const root = createTmpDir();
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const f of fixtures) {
    try {
      removeTmpDir(f);
    } catch {
      // ignore cleanup errors
    }
  }
  fixtures.length = 0;
});

function skillPath(project: string, name: string): string {
  const dir = join(project, '.opencode', 'skills', name);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'SKILL.md');
}

describe('chunk-boundary / EOF / UTF-8 preservation', () => {
  test('does not treat end-of-chunk as EOF when delimiter followed by non-newline content', async () => {
    const project = fixture();
    const open = '---\nname: false-eof\n';
    // Place \n--- so its dashes end exactly at byte 4096 (after = 4096).
    const pad = 4092 - open.length;
    const content = open + 'x'.repeat(pad) + '\n---foobar\n---\nname: real\n';
    // The first \n--- at char 4092 is a false delimiter (no terminator).
    // The real delimiter is after foobar.
    const path = skillPath(project, 'false-eof');
    writeFileSync(path, content);
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    // Must continue past false delimiter (includes foobar)
    // and stop at real delimiter (does not include post-delimiter content).
    expect(header!.includes('foobar')).toBe(true);
    expect(header!.includes('name: false-eof')).toBe(true);
    expect(header!.includes('name: real')).toBe(false);
  });

  test('accepts CRLF delimiter ending exactly at chunk boundary when file ends there', async () => {
    const project = fixture();
    const open = '---\r\nname: crlf-end\r\n';
    const pad = 4092 - open.length;
    const content = open + 'x'.repeat(pad) + '\r\n---\r\n';
    // \r\n--- ends at char 4096 (after = 4096) and file ends.
    const path = skillPath(project, 'crlf-end');
    writeFileSync(path, content);
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    expect(header!.includes('name: crlf-end')).toBe(true);
  });

  test('preserves multibyte UTF-8 when split across the 4096-byte read boundary', async () => {
    const project = fixture();
    const open = '---\nname: utf8\n';
    // Emoji 😀 is 4 UTF-8 bytes (F0 9F 98 80). Start it at byte 4095 so
    // byte 4096 falls inside the emoji, splitting across reads.
    const padChars = 4095 - open.length;
    const content = open + 'x'.repeat(padChars) + '😀\n---\n';
    const path = skillPath(project, 'utf8');
    writeFileSync(path, content);
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    expect(header!.includes('name: utf8')).toBe(true);
    // The decoded header must contain the emoji intact, not replaced.
    expect(header!.includes('\uFFFD')).toBe(false);
  });

  test('preserves CRLF with split multibyte near boundary', async () => {
    const project = fixture();
    const open = '---\r\nname: crlf-utf8\r\n';
    const padChars = 4095 - open.length;
    const content = open + 'x'.repeat(padChars) + '\u00E9\r\n---\r\n';
    // é (U+00E9) is 2 bytes (C3 A9); split at 4096.
    const path = skillPath(project, 'crlf-utf8');
    writeFileSync(path, content);
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    expect(header!.includes('name: crlf-utf8')).toBe(true);
    expect(header!.includes('\uFFFD')).toBe(false);
  });

  test('false EOF with CRLF followed by non-terminator content', async () => {
    const project = fixture();
    const open = '---\r\nname: crlf-false\r\n';
    const pad = 4092 - open.length;
    const content = open + 'x'.repeat(pad) + '\r\n---xyz\r\n---\r\n';
    // \r\n--- ends at 4096; next char is 'x', not terminator.
    const path = skillPath(project, 'crlf-false');
    writeFileSync(path, content);
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    expect(header!.includes('name: crlf-false')).toBe(true);
  });

  test('flush before scan: delimiter at 4096 followed by incomplete multibyte byte', async () => {
    const project = fixture();
    const open = '---\nname: flush-order\n';
    const pad = 4092 - open.length;
    const dir = join(project, '.opencode', 'skills', 'flush-order');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    // False delimiter: \n--- ends exactly at chunk boundary, followed by
    // raw byte 0xF0 (first byte of 4-byte emoji, never completed).
    const raw = Buffer.concat([
      Buffer.from(open + 'x'.repeat(pad) + '\n---'),
      Buffer.from([0xf0]),
    ]);
    writeFileSync(path, raw);
    const header = await readFrontmatterHeader(path);
    // Must NOT treat chunk-end as EOF; delimiter has no terminator,
    // so header must be undefined (not a false positive).
    expect(header).toBeUndefined();
  });

  test('reference parity: chunk-aligned closing delimiter with terminator', async () => {
    const project = fixture();
    const root = join(project, '.opencode', 'skills');
    mkdirSync(root, { recursive: true });
    const open = '---\nname: parity\n';
    // Closing \n---\n placed so dashes end at chunk boundary (4096 chars).
    const pad = 4092 - open.length;
    const content = open + 'x'.repeat(pad) + '\n---\n';
    writeFileSync(join(root, 'probe-p4096.md'), content);
    const path = join(root, 'probe-p4096.md');
    const header = await readFrontmatterHeader(path);
    expect(header).toBeDefined();
    expect(header!.includes('name: parity')).toBe(true);
  });
});
