import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../utils/guards';

const WRITE_RECEIPT = /^(?:Wrote|Created) file successfully: ([^\r\n]+)$/;
const READ_RECEIPT =
  /^Read file ([^\r\n]+), (?:0 lines|lines \d+-\d+(?: \(offset \d+ is past the end; the file has \d+ lines?\))?)(?:\r?\n|$)/;

/** Extract paths from successful native file-tool results, including OpenCode 2.4 receipts. */
export function resolveV2TouchedFilePaths(
  tool: string,
  result: unknown,
  locationDirectory?: string,
): readonly string[] {
  if (!isRecord(result)) return [];
  const output = result.output;
  const fields = isRecord(output) ? output : undefined;
  const metadata = isRecord(result.metadata) ? result.metadata : undefined;
  const paths = new Set<string>();
  const addAbsolute = (value: unknown) => {
    if (isCanonicalAbsolute(value)) paths.add(normalize(value));
  };
  const addResource = (value: unknown) => {
    if (typeof value !== 'string') return;
    if (isAbsolute(value)) {
      addAbsolute(value);
      return;
    }
    if (!isCanonicalAbsolute(locationDirectory) || !isSafeRelative(value))
      return;
    const path = resolve(locationDirectory, value);
    if (isWithin(locationDirectory, path)) paths.add(path);
  };

  if (tool === 'read') {
    if (fields?.type === 'media' && Array.isArray(result.content)) {
      // 2.4 media's file URI can denote a file on another machine. Its
      // rendered attachment name is the host-confirmed requested resource.
      for (const item of result.content) {
        if (isRecord(item) && item.type === 'file') addResource(item.name);
      }
    } else if (fields?.type === 'file' && typeof fields.uri === 'string') {
      try {
        const url = new URL(fields.uri);
        if (url.protocol === 'file:') addAbsolute(fileURLToPath(url));
      } catch {
        // Malformed or non-local URI.
      }
    } else if (
      (fields?.type === 'text' || fields?.type === 'text-page') &&
      typeof fields.content === 'string' &&
      typeof result.content === 'string'
    ) {
      addResource(READ_RECEIPT.exec(result.content)?.[1]);
    }
  } else if (tool === 'write') {
    if (typeof output === 'string')
      addResource(WRITE_RECEIPT.exec(output)?.[1]);
    else addAbsolute(fields?.target);
  } else if (tool === 'edit' || tool === 'patch') {
    // 2.3's FileDiff entries are relative to Location for internal paths.
    if (Array.isArray(metadata?.files)) {
      for (const item of metadata.files)
        if (isRecord(item)) addResource(item.file);
    } else if (tool === 'edit' && Array.isArray(fields?.files)) {
      for (const item of fields.files)
        if (isRecord(item)) addResource(item.file);
    } else if (tool === 'patch' && Array.isArray(fields?.applied)) {
      for (const item of fields.applied)
        if (isRecord(item)) addAbsolute(item.target);
    }
  }
  return [...paths];
}

function isCanonicalAbsolute(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    isAbsolute(path) &&
    normalize(path) === (sep === '\\' ? path.replaceAll('/', sep) : path) &&
    (sep === '\\' || !path.includes('\\')) &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}

function isSafeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !/[:\\\0]/.test(path) &&
    !path
      .split('/')
      .some((part) => part === '..' || part === '.' || part === '')
  );
}

function isWithin(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}
