#!/usr/bin/env node
// allow: SIZE_OK — cohesive dependency-free CLI shipped as one skill script.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
export const STATE_DIR = path.join('.local', '.slim');
export const LEGACY_STATE_DIR = '.slim';
export const STATE_FILE = 'codemap.json';
export const LEGACY_STATE_FILE = 'cartography.json';
export const CODEMAPS_DIR = 'codemaps';
export const CODEMAP_FILE = 'codemap.md';

export class PatternMatcher {
  regex;

  constructor(patterns) {
    if (!patterns.length) {
      this.regex = null;
      return;
    }

    const regexParts = patterns.map((pattern) => {
      let reg = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reg = reg.replace(/\\\*\\\*\//g, '(?:.*/)?');
      reg = reg.replace(/\\\*\\\*/g, '.*');
      reg = reg.replace(/\\\*/g, '[^/]*');
      reg = reg.replace(/\\\?/g, '.');

      if (pattern.endsWith('/')) {
        reg += '.*';
      }

      if (pattern.startsWith('/')) {
        reg = `^${reg.slice(1)}`;
      } else {
        reg = `(?:^|.*/)${reg}`;
      }

      return `(?:${reg}$)`;
    });

    this.regex = new RegExp(regexParts.join('|'));
  }

  matches(filePath) {
    if (!this.regex) return false;
    return this.regex.test(filePath);
  }
}

export function loadGitignore(root) {
  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  return readFileSync(gitignorePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function walkFiles(root) {
  const files = [];

  function visit(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          visit(fullPath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  visit(root);
  return files.sort();
}

export function selectFiles(
  root,
  includePatterns,
  excludePatterns,
  exceptions,
  gitignorePatterns,
) {
  const includeMatcher = new PatternMatcher(includePatterns);
  const excludeMatcher = new PatternMatcher(excludePatterns);
  const gitignoreMatcher = new PatternMatcher(gitignorePatterns);
  const exceptionSet = new Set(exceptions);

  return walkFiles(root).filter((fullPath) => {
    let relPath = path.relative(root, fullPath).replaceAll(path.sep, '/');
    if (relPath.startsWith('./')) {
      relPath = relPath.slice(2);
    }

    if (gitignoreMatcher.matches(relPath)) return false;
    if (excludeMatcher.matches(relPath) && !exceptionSet.has(relPath)) {
      return false;
    }

    return includeMatcher.matches(relPath) || exceptionSet.has(relPath);
  });
}

export function computeFileHash(filePath) {
  try {
    const buffer = readFileSync(filePath);
    return createHash('md5').update(buffer).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Visits every ancestor folder of a relative file path, shallowest first.
 *
 * Walking separators avoids splitting the path and repeatedly slicing and
 * joining segment arrays. Materializing all ancestor names still costs their
 * total prefix length. Top-level files visit `.` only.
 *
 * @param {string} filePath
 * @param {(folder: string) => void} visit
 */
function forEachAncestorFolder(filePath, visit) {
  const firstSlash = filePath.indexOf('/');
  if (firstSlash === -1) {
    visit('.');
    return;
  }

  let folder = filePath.slice(0, firstSlash);
  visit(folder);

  let segmentStart = firstSlash + 1;
  for (;;) {
    const slash = filePath.indexOf('/', segmentStart);
    if (slash === -1) return;
    folder = `${folder}/${filePath.slice(segmentStart, slash)}`;
    visit(folder);
    segmentStart = slash + 1;
  }
}

/**
 * Derives every folder hash in a single pass over the file hash map.
 *
 * Each file belongs to exactly its own ancestor folders, so the entries are
 * listed and collation-sorted once and then replayed in that order: every
 * folder's hasher sees exactly the `localeCompare` order (and the same stable
 * tie-break among collation-equal paths) that sorting a filtered subset
 * produced, without re-materializing the whole entry list per folder.
 *
 * @param {Record<string, string>} fileHashes
 */
export function buildFolderHashIndex(fileHashes) {
  const entries = Object.entries(fileHashes);
  entries.sort(([a], [b]) => a.localeCompare(b));

  const hashers = new Map();
  let pairChecks = 0;
  for (const [filePath, hash] of entries) {
    const hashLine = `${filePath}:${hash}\n`;
    forEachAncestorFolder(filePath, (folder) => {
      pairChecks++;
      let hasher = hashers.get(folder);
      if (!hasher) {
        hasher = createHash('md5');
        hashers.set(folder, hasher);
      }
      hasher.update(hashLine);
    });
  }

  const hashes = new Map();
  for (const [folder, hasher] of hashers) {
    hashes.set(folder, hasher.digest('hex'));
  }

  return {
    /** Folders that contain at least one file, in first-seen order. */
    folders: hashes,
    /** @param {string} folder */
    hashFor(folder) {
      return hashes.get(folder) ?? '';
    },
    /** Work counters, so cost claims can be asserted instead of timed. */
    stats: { entryLists: 1, entryElements: entries.length, pairChecks },
  };
}

export function computeFolderHash(folder, fileHashes) {
  // Standalone callers only need one hash; don't build all ancestor hashers.
  const prefix = `${folder}/`;
  const folderFiles = Object.entries(fileHashes)
    .filter(
      ([filePath]) =>
        filePath.startsWith(prefix) ||
        (folder === '.' && !filePath.includes('/')),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  if (!folderFiles.length) return '';

  const hasher = createHash('md5');
  for (const [filePath, hash] of folderFiles) {
    hasher.update(`${filePath}:${hash}\n`);
  }
  return hasher.digest('hex');
}

export function getFoldersWithFiles(files, root) {
  const folders = new Set(['.']);

  for (const filePath of files) {
    const relPath = path.relative(root, filePath).replaceAll(path.sep, '/');
    // Top-level files visit `.` only, which the seed already covers.
    forEachAncestorFolder(relPath, (folder) => folders.add(folder));
  }

  return folders;
}

export function migrateLegacyState(root) {
  const stateDir = path.join(root, STATE_DIR);
  const statePath = path.join(stateDir, STATE_FILE);

  if (existsSync(statePath)) {
    return false;
  }

  for (const legacyFile of [STATE_FILE, LEGACY_STATE_FILE]) {
    const legacyPath = path.join(root, LEGACY_STATE_DIR, legacyFile);
    if (!existsSync(legacyPath)) continue;

    try {
      const state = JSON.parse(readFileSync(legacyPath, 'utf8'));
      saveState(root, state);
      console.log(
        `Migrated ${LEGACY_STATE_DIR}/${legacyFile} -> ${STATE_DIR}/${STATE_FILE} (legacy file preserved)`,
      );
      return true;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }

  return false;
}

export function loadState(root) {
  migrateLegacyState(root);
  const statePath = path.join(root, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(root, state) {
  const stateDir = path.join(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export function createEmptyCodemap(folderPath, folderName) {
  const codemapPath = path.join(folderPath, CODEMAP_FILE);
  if (existsSync(codemapPath)) return;

  mkdirSync(folderPath, { recursive: true });

  const content = `# ${folderName}/

<!-- Fixer: Fill in this section with architectural understanding -->

## Responsibility

<!-- What is this folder's job in the system? -->

## Design

<!-- Key patterns, abstractions, architectural decisions -->

## Flow

<!-- How does data/control flow through this module? -->

## Integration

<!-- How does it connect to other parts of the system? -->
`;

  writeFileSync(codemapPath, content);
}

function buildState(
  root,
  includePatterns,
  excludePatterns,
  exceptions,
  selectedFiles,
) {
  const fileHashes = {};
  for (const filePath of selectedFiles) {
    const relPath = path.relative(root, filePath).replaceAll(path.sep, '/');
    fileHashes[relPath] = computeFileHash(filePath);
  }

  const folderIndex = buildFolderHashIndex(fileHashes);
  const folders = getFoldersWithFiles(selectedFiles, root);
  const folderHashes = {};
  for (const folder of folders) {
    folderHashes[folder] = folderIndex.hashFor(folder);
  }

  const state = {
    metadata: {
      version: VERSION,
      last_run: new Date().toISOString(),
      root,
      include_patterns: includePatterns,
      exclude_patterns: excludePatterns,
      exceptions,
    },
    file_hashes: fileHashes,
    folder_hashes: folderHashes,
  };

  return { state, folders };
}

/**
 * @param {{
 *   root: string,
 *   include?: string[],
 *   exclude?: string[],
 *   exception?: string[]
 * }} options
 */
export function cmdInit({ root, include = [], exclude = [], exception = [] }) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    console.error(`Error: ${resolvedRoot} is not a directory`);
    return 1;
  }

  const includePatterns = include.length ? include : ['**/*'];
  const excludePatterns = exclude;
  const exceptions = exception;
  const gitignore = loadGitignore(resolvedRoot);

  console.log(`Scanning ${resolvedRoot}...`);
  console.log(`Include patterns: ${JSON.stringify(includePatterns)}`);
  console.log(`Exclude patterns: ${JSON.stringify(excludePatterns)}`);
  console.log(`Exceptions: ${JSON.stringify(exceptions)}`);

  const selectedFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  console.log(`Selected ${selectedFiles.length} files`);

  const { state, folders } = buildState(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    selectedFiles,
  );

  saveState(resolvedRoot, state);
  console.log(`Created ${STATE_DIR}/${STATE_FILE}`);

  const codemapsRoot = path.join(resolvedRoot, STATE_DIR, CODEMAPS_DIR);
  for (const folder of folders) {
    const folderPath =
      folder === '.' ? codemapsRoot : path.join(codemapsRoot, folder);
    const folderName = folder === '.' ? path.basename(resolvedRoot) : folder;
    createEmptyCodemap(folderPath, folderName);
  }

  console.log(
    `Created ${folders.size} empty maps under ${STATE_DIR}/${CODEMAPS_DIR}`,
  );
  return 0;
}

export function cmdChanges({ root }) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) {
    console.error("No codemap state found. Run 'init' first.");
    return 1;
  }

  const metadata = state.metadata ?? {};
  const includePatterns = metadata.include_patterns ?? ['**/*'];
  const excludePatterns = metadata.exclude_patterns ?? [];
  const exceptions = metadata.exceptions ?? [];
  const gitignore = loadGitignore(resolvedRoot);

  const currentFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  const currentHashes = Object.fromEntries(
    currentFiles.map((filePath) => [
      path.relative(resolvedRoot, filePath).replaceAll(path.sep, '/'),
      computeFileHash(filePath),
    ]),
  );

  const savedHashes = state.file_hashes ?? {};
  const currentPaths = new Set(Object.keys(currentHashes));
  const savedPaths = new Set(Object.keys(savedHashes));

  const added = [...currentPaths]
    .filter((filePath) => !savedPaths.has(filePath))
    .sort();
  const removed = [...savedPaths]
    .filter((filePath) => !currentPaths.has(filePath))
    .sort();
  const modified = [...currentPaths]
    .filter((filePath) => savedPaths.has(filePath))
    .filter((filePath) => currentHashes[filePath] !== savedHashes[filePath])
    .sort();

  if (!added.length && !removed.length && !modified.length) {
    console.log('No changes detected.');
    return 0;
  }

  if (added.length) {
    console.log(`\n${added.length} added:`);
    for (const filePath of added) console.log(`  + ${filePath}`);
  }

  if (removed.length) {
    console.log(`\n${removed.length} removed:`);
    for (const filePath of removed) console.log(`  - ${filePath}`);
  }

  if (modified.length) {
    console.log(`\n${modified.length} modified:`);
    for (const filePath of modified) console.log(`  ~ ${filePath}`);
  }

  const affectedFolders = new Set(['.']);
  for (const filePath of [...added, ...removed, ...modified]) {
    forEachAncestorFolder(filePath, (folder) => affectedFolders.add(folder));
  }

  const sortedFolders = [...affectedFolders].sort();
  console.log(`\n${sortedFolders.length} folders affected:`);
  for (const folder of sortedFolders) {
    console.log(`  ${folder}/`);
  }

  return 0;
}

export function cmdUpdate({ root }) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) {
    console.error("No codemap state found. Run 'init' first.");
    return 1;
  }

  const metadata = state.metadata ?? {};
  const includePatterns = metadata.include_patterns ?? ['**/*'];
  const excludePatterns = metadata.exclude_patterns ?? [];
  const exceptions = metadata.exceptions ?? [];
  const gitignore = loadGitignore(resolvedRoot);

  const selectedFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  const { state: nextState } = buildState(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    selectedFiles,
  );

  saveState(resolvedRoot, nextState);
  console.log(
    `Updated ${STATE_DIR}/${STATE_FILE} with ${selectedFiles.length} files`,
  );
  return 0;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { include: [], exclude: [], exception: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];

    if (!arg?.startsWith('--')) continue;
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    const key = arg.slice(2);
    if (key === 'include' || key === 'exclude' || key === 'exception') {
      options[key].push(value);
    } else if (key === 'root') {
      options.root = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    i++;
  }

  return { command, options };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);

    if (!command || !options.root) {
      console.error(
        'Usage: codemap.mjs <init|changes|update> --root /path [--include glob] [--exclude glob] [--exception path]',
      );
      return 1;
    }

    if (command === 'init') return cmdInit(options);
    if (command === 'changes') return cmdChanges(options);
    if (command === 'update') return cmdUpdate(options);

    console.error(`Unknown command: ${command}`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  process.exit(main());
}
