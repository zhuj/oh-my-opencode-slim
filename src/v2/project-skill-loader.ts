import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripFrontmatter } from '../cli/custom-skills';
import { resolveProjectResourceRoots } from '../config/project-resource-paths';
import { toV2ProjectSkillInfos } from '../config/project-skill-host-adapter';
import { discoverProjectSkills } from '../config/project-skills';
import { parseFrontmatter } from '../utils/frontmatter';
import { isRecord } from '../utils/guards';
import { withTimeout } from '../utils/session';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
} from '../utils/skill-policy-validation';
import { isDiscoveryAcceptable } from './project-skill-diagnostics';
import type { V2ProjectSkillInfo, V2SkillDraft } from './types';

const NATIVE_ROOTS = [
  '.opencode/skills',
  '.opencode/skill',
  '.claude/skills',
  '.agents/skills',
  '.claude/skill',
  '.agents/skill',
] as const;

export const getV2NativeProjectSkillRoots = (
  directory: string,
  boundaryDirectory = directory,
): readonly string[] => {
  const roots: string[] = [];
  const boundary = path.resolve(boundaryDirectory);
  let ancestor = path.resolve(directory);
  while (isWithin(boundary, ancestor)) {
    roots.push(...NATIVE_ROOTS.map((root) => path.join(ancestor, root)));
    if (ancestor === boundary) break;
    ancestor = path.dirname(ancestor);
  }
  return roots;
};

export interface V2NativeProjectSkillNameScan {
  readonly names: readonly string[];
  readonly complete: boolean;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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
  readonly activeDirectory?: string;
}): Promise<V2NativeProjectSkillNameScan> {
  const names = new Set<string>();
  let complete = true;
  const boundary = await fs.promises
    .realpath(options.boundaryDirectory)
    .catch(() => undefined);
  if (!boundary) return { names: [], complete: false };

  const active =
    options.activeDirectory === undefined
      ? boundary
      : await fs.promises
          .realpath(options.activeDirectory)
          .catch(() => undefined);
  if (!active || !isWithin(boundary, active))
    return { names: [], complete: false };

  const inspect = async (directory: string, depth: number): Promise<void> => {
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
    // OpenCode's native scanner skips hidden entries and stops descending
    // when a directory contains SKILL.md. Keep this pre-activation name probe
    // conservative when an eligible symlink cannot be inspected safely.
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const skillFile = visible.find((entry) => entry.name === 'SKILL.md');
    for (const entry of skillFile ? [skillFile] : visible) {
      const candidate = path.join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= 6) continue;
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
        await inspect(candidate, depth + 1);
        continue;
      }
      if (
        !entry.isFile() ||
        (entry.name !== 'SKILL.md' &&
          !(depth === 0 && entry.name.endsWith('.md')))
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
        names.add(id);
        names.add(name);
      } catch (error) {
        if (error instanceof InvalidSkillPolicyError) throw error;
        complete = false;
      }
    }
  };

  for (const root of getV2NativeProjectSkillRoots(active, boundary)) {
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
      await inspect(canonicalRoot, 0);
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
      if (!validName(candidate.name) || candidate.name.startsWith('.'))
        continue;
      if (!(await fs.promises.lstat(candidate.directory)).isDirectory())
        continue;
      const directory = await fs.promises.realpath(candidate.directory);
      const expectedFile = path.join(directory, 'SKILL.md');
      if (
        !isWithin(boundary, directory) ||
        path.basename(directory) !== candidate.name ||
        path.resolve(candidate.skillFilePath) !==
          path.join(path.resolve(candidate.directory), 'SKILL.md')
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
        name: candidate.name,
        directory,
        skillFilePath: file,
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

/** The old generation can still own an identical source during reload. */
async function isSameSkillSource(
  entry: Record<string, unknown>,
  candidate: V2ProjectSkillCandidate | undefined,
): Promise<boolean> {
  if (
    !candidate ||
    (entry.name !== undefined && entry.name !== candidate.name) ||
    typeof entry.path !== 'string' ||
    !path.isAbsolute(entry.path)
  )
    return false;

  const [previousFile, candidateFile] = await Promise.all([
    fs.promises.realpath(entry.path).catch(() => undefined),
    fs.promises.realpath(candidate.skillFilePath).catch(() => undefined),
  ]);
  return previousFile !== undefined && previousFile === candidateFile;
}

/**
 * Prepare a supplement before the host's post-plugin skill loader runs. That
 * loader wins same-ID writes on OpenCode 2.3. Check its local sources now for
 * display-name conflicts and check the current editor again on every replay.
 */
export async function prepareV2ProjectSkillProjection(options: {
  readonly activeDirectory: string;
  readonly boundaryDirectory?: string;
  readonly prefixes: readonly string[];
  readonly readHostSkills?: () => Promise<unknown>;
}): Promise<{
  readonly infos: readonly V2ProjectSkillInfo[];
  readonly permissionNames: readonly string[];
}> {
  const { activeDirectory, boundaryDirectory, prefixes } = options;
  const empty = { infos: [], permissionNames: [] } as const;
  if (!boundaryDirectory || prefixes.length === 0) return empty;
  const [active, boundary] = await Promise.all([
    fs.promises.realpath(activeDirectory).catch(() => undefined),
    fs.promises.realpath(boundaryDirectory).catch(() => undefined),
  ]);
  if (!active || !boundary || !isWithin(boundary, active)) return empty;
  let roots: ReturnType<typeof resolveProjectResourceRoots>;
  try {
    roots = resolveProjectResourceRoots({
      activeDirectory: active,
      boundaryDirectory: boundary,
      prefixes,
      category: 'skills',
    });
  } catch {
    return empty;
  }
  if (roots.length === 0) return empty;
  const hostOwnedSkillRoots = getV2NativeProjectSkillRoots(active, boundary);
  const discoveryOptions = {
    projectDirectory: active,
    resourcePrefixes: prefixes,
    resourceRoots: roots,
    hostOwnedSkillRoots,
  };
  const candidates = discoverProjectSkills({
    ...discoveryOptions,
    hostSkillNames: [],
  });
  if (candidates.skills.length === 0) return empty;

  const native = await scanV2NativeProjectSkillNames({
    activeDirectory: active,
    boundaryDirectory: boundary,
  });
  const hostNames = new Set(native.names);
  let editorInventoryComplete = true;
  if (options.readHostSkills) {
    const candidateByID = new Map(
      candidates.skills.map((candidate) => [candidate.name, candidate]),
    );
    try {
      const response = await withTimeout(
        options.readHostSkills(),
        2_000,
        'Project skill inventory lookup timed out',
      );
      if (!isRecord(response) || !Array.isArray(response.data)) {
        editorInventoryComplete = false;
      } else {
        for (const skill of response.data) {
          if (!isRecord(skill) || !validName(skill.id)) {
            editorInventoryComplete = false;
            break;
          }
          if (await isSameSkillSource(skill, candidateByID.get(skill.id)))
            continue;
          hostNames.add(skill.id);
          if (validName(skill.name)) hostNames.add(skill.name);
        }
      }
    } catch {
      editorInventoryComplete = false;
    }
  }

  if (
    !isDiscoveryAcceptable({
      discovery: candidates,
      nativeScanComplete: native.complete,
      editorInventoryComplete,
    })
  )
    return empty;

  const sources = await loadV2ProjectSkillSources({
    projectBoundary: boundary,
    candidates: candidates.skills.filter(({ name }) => !hostNames.has(name)),
  });
  // Only accepted supplemental sources contribute names here. The native
  // auto-grants are resolved independently by the runtime's existing loader.
  const infos = toV2ProjectSkillInfos(
    [],
    sources.map((source) => ({
      ...source,
      content: stripFrontmatter(source.content.replace(/^\uFEFF/, '')).trim(),
    })),
  );
  return { infos, permissionNames: infos.map(({ id }) => id) };
}

/** Add supplemental definitions without replacing any earlier host skill. */
export function addMissingV2ProjectSkills(
  draft: V2SkillDraft,
  infos: readonly V2ProjectSkillInfo[],
): void {
  if (typeof draft.list !== 'function' || typeof draft.add !== 'function')
    return;
  const identities = new Set(
    draft.list().flatMap(({ id, name }) => [id, name]),
  );
  for (const info of infos) {
    if (
      info.id.startsWith('.') ||
      info.name.startsWith('.') ||
      identities.has(info.id) ||
      identities.has(info.name)
    )
      continue;
    draft.add(info);
    identities.add(info.id);
    identities.add(info.name);
  }
}
