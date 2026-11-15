import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../utils/guards';

/** Extract touched paths only from documented V2 result fields. */
export function resolveV2TouchedFilePaths(
  tool: string,
  result: unknown,
  locationDirectory?: string,
): readonly string[] {
  if (!isRecord(result) || !isRecord(result.output)) return [];
  const output = result.output;
  const paths: string[] = [];
  const addAbsolute = (value: unknown) => {
    if (typeof value === 'string' && isCanonicalAbsolute(value))
      paths.push(value);
  };
  if (
    tool === 'read' &&
    output.type === 'file' &&
    typeof output.uri === 'string'
  ) {
    try {
      const url = new URL(output.uri);
      if (url.protocol === 'file:') addAbsolute(fileURLToPath(url));
    } catch {
      /* malformed host result */
    }
  } else if (tool === 'write') addAbsolute(output.target);
  else if (tool === 'edit' && Array.isArray(output.files)) {
    for (const item of output.files) {
      if (!isRecord(item) || typeof item.file !== 'string') continue;
      if (isAbsolute(item.file)) addAbsolute(item.file);
      else if (
        isCanonicalAbsolute(locationDirectory) &&
        isSafeRelative(item.file)
      ) {
        const path = resolve(locationDirectory, item.file);
        if (isWithin(locationDirectory, path)) paths.push(path);
      }
    }
  } else if (tool === 'patch' && Array.isArray(output.applied)) {
    for (const item of output.applied)
      if (isRecord(item)) addAbsolute(item.target);
  }
  return [...new Set(paths)];
}

function isCanonicalAbsolute(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    isAbsolute(path) &&
    normalize(path) === path &&
    !path.includes('\\') &&
    !path.split('/').includes('..')
  );
}

function isSafeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
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
