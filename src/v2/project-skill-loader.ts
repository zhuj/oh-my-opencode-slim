import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../utils/frontmatter';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
} from '../utils/skill-policy-validation';

const NATIVE_ROOTS = [
  '.opencode/skills',
  '.opencode/skill',
  '.claude/skills',
  '.agents/skills',
] as const;

export const getV2NativeProjectSkillRoots = (
  boundaryDirectory: string,
): readonly string[] =>
  NATIVE_ROOTS.map((root) => path.join(boundaryDirectory, root));

export interface V2NativeProjectSkillNameScan {
  readonly names: readonly string[];
  readonly complete: boolean;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0;
}

const CHUNK_BYTES = 4096;
const MAX_HEADER_BYTES = 1024 * 1024;
const OPENING_DELIMITER = /^\uFEFF?---\r?\n/;
/**
 * The opening half of a closing delimiter: an optional CR, the line ending
 * and the three dashes. A windowed search only has to locate that half; the
 * terminator is validated against the full buffer so the returned header is
 * still the exact whole-buffer match.
 */
const CLOSING_DELIMITER = /\r?\n---/g;
/**
 * A closing delimiter with its terminator is at most `\r\n---\r\n`, so a
 * window one read longer than the chunk always covers a delimiter that starts
 * inside the newest chunk, including one split across a read boundary, while
 * keeping each scan constant-size instead of proportional to the header.
 */
const CLOSING_WINDOW = CHUNK_BYTES + 16;

function closingHeaderEnd(
  header: string,
  after: number,
  atEof: boolean,
): number | undefined {
  if (header.startsWith('\r\n', after)) return after + 2;
  if (header.startsWith('\n', after)) return after + 1;
  return atEof && after === header.length ? after : undefined;
}

export async function readFrontmatterHeader(
  filePath: string,
): Promise<string | undefined> {
  const handle = await fs.promises.open(filePath, 'r');
  const chunk = Buffer.alloc(CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8');
  let header = '';
  let position = 0;
  let openingLength = 0;
  try {
    while (position < MAX_HEADER_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      const atEof = bytesRead < CHUNK_BYTES;
      if (bytesRead > 0) {
        header += decoder.decode(chunk.subarray(0, bytesRead), {
          stream: true,
        });
      }
      if (position === 0) {
        const opening = OPENING_DELIMITER.exec(header);
        if (!opening) return undefined;
        openingLength = opening[0].length;
      }
      if (atEof) {
        // Flush any buffered partial UTF-8 sequence at actual EOF
        // BEFORE scanning, so split bytes don't hide delimiter validity.
        const flushed = decoder.decode();
        if (flushed) header += flushed;
      }
      // Rescan only the tail of the accumulated buffer: a delimiter
      // starting before the newest chunk was already considered on an
      // earlier pass, so the window bounds the per-read work.
      const from = Math.max(openingLength, header.length - CLOSING_WINDOW);
      const window = header.slice(from);
      CLOSING_DELIMITER.lastIndex = 0;
      let match = CLOSING_DELIMITER.exec(window);
      while (match) {
        const end = closingHeaderEnd(
          header,
          from + match.index + match[0].length,
          atEof,
        );
        if (end !== undefined) return header.slice(0, end);
        match = CLOSING_DELIMITER.exec(window);
      }
      if (atEof) break;
      position += bytesRead;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export async function scanV2NativeProjectSkillNames(options: {
  readonly boundaryDirectory: string;
}): Promise<V2NativeProjectSkillNameScan> {
  const names = new Set<string>();
  let complete = true;
  const boundary = await fs.promises
    .realpath(options.boundaryDirectory)
    .catch(() => undefined);
  if (!boundary) return { names: [], complete: false };

  const inspect = async (directory: string): Promise<void> => {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await fs.promises.realpath(directory);
      if (!isWithin(boundary, canonicalDirectory)) {
        complete = false;
        return;
      }
    } catch {
      complete = false;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(canonicalDirectory, {
        withFileTypes: true,
      });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        try {
          const real = await fs.promises.realpath(candidate);
          if (!isWithin(boundary, real) || real !== candidate) {
            complete = false;
            continue;
          }
        } catch {
          complete = false;
          continue;
        }
        await inspect(candidate);
        continue;
      }
      if (
        !entry.isFile() ||
        (entry.name !== 'SKILL.md' &&
          !(
            NATIVE_ROOTS.some(
              (root) => canonicalDirectory === path.join(boundary, root),
            ) && entry.name.endsWith('.md')
          ))
      )
        continue;
      try {
        const stat = await fs.promises.lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          complete = false;
          continue;
        }
        const real = await fs.promises.realpath(candidate);
        if (!isWithin(boundary, real) || real !== candidate) {
          complete = false;
          continue;
        }
        const id =
          entry.name === 'SKILL.md'
            ? path.basename(canonicalDirectory)
            : entry.name.slice(0, -3);
        assertSkillIdentifier(id, candidate);
        const header = await readFrontmatterHeader(candidate);
        const metadata = header
          ? parseFrontmatter(header.replace(/^\uFEFF/, ''))
          : null;
        if (!metadata) {
          complete = false;
          continue;
        }
        const name = metadata?.name?.trim() || id;
        assertSkillIdentifier(name, candidate);
        if (!validName(name)) {
          complete = false;
          continue;
        }
        names.add(name);
      } catch (error) {
        if (error instanceof InvalidSkillPolicyError) throw error;
        complete = false;
      }
    }
  };

  for (const relativeRoot of NATIVE_ROOTS) {
    const root = path.join(boundary, relativeRoot);
    try {
      const stat = await fs.promises.lstat(root);
      if (stat.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (!stat.isDirectory()) {
        complete = false;
        continue;
      }
      const canonicalRoot = await fs.promises.realpath(root);
      if (!isWithin(boundary, canonicalRoot)) {
        complete = false;
        continue;
      }
      if (canonicalRoot !== root) {
        complete = false;
        continue;
      }
      await inspect(canonicalRoot);
    } catch (error) {
      if (error instanceof InvalidSkillPolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    }
  }
  return { names: [...names].sort(), complete };
}

export interface V2ProjectSkillCandidate {
  readonly name: string;
  readonly directory: string;
  readonly skillFilePath: string;
}

export interface V2ProjectSkillSource extends V2ProjectSkillCandidate {
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly content: string;
}

export async function loadV2ProjectSkillSources(options: {
  readonly projectBoundary: string;
  readonly candidates: readonly V2ProjectSkillCandidate[];
}): Promise<readonly V2ProjectSkillSource[]> {
  for (const candidate of options.candidates) {
    assertSkillIdentifier(candidate.name, 'V2 project candidate');
    assertSkillIdentifier(
      path.basename(candidate.directory),
      'V2 project path ID',
    );
  }
  const boundary = await fs.promises
    .realpath(options.projectBoundary)
    .catch(() => undefined);
  if (!boundary) return [];
  const sources: V2ProjectSkillSource[] = [];
  const seen = new Set<string>();
  for (const candidate of options.candidates) {
    try {
      if (!validName(candidate.name)) continue;
      const directory = await fs.promises.realpath(candidate.directory);
      const expectedFile = path.join(directory, 'SKILL.md');
      if (
        !isWithin(boundary, directory) ||
        path.basename(directory) !== candidate.name ||
        path.resolve(candidate.skillFilePath) !== expectedFile
      )
        continue;
      const fileStat = await fs.promises.lstat(expectedFile);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
      const file = await fs.promises.realpath(expectedFile);
      if (!isWithin(boundary, file) || file !== expectedFile) continue;
      const content = await fs.promises.readFile(expectedFile, 'utf8');
      const metadata = parseFrontmatter(content.replace(/^\uFEFF/, ''));
      if (metadata?.name?.trim())
        assertSkillIdentifier(metadata.name.trim(), expectedFile);
      if (
        (metadata?.name?.trim() || path.basename(directory)) !==
          candidate.name ||
        seen.has(candidate.name)
      )
        continue;
      const description = metadata?.description?.trim();
      sources.push({
        ...candidate,
        ...(description ? { description } : {}),
        ...(metadata?.autoinvoke === 'true' ? { autoinvoke: true } : {}),
        ...(metadata?.autoinvoke === 'false' ? { autoinvoke: false } : {}),
        content,
      });
      seen.add(candidate.name);
    } catch (error) {
      if (error instanceof InvalidSkillPolicyError) throw error;
      // Optional candidate files fail closed without aborting setup.
    }
  }
  return sources;
}
