const CREATION_APIS = new Set([
  'mkdtemp',
  'mkdtempSync',
  'mkdir',
  'mkdirSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
]);

const MAYBE_RAW_MKDTEMP = /\b(?:fs\s*\.\s*)?mkdtemp(?:Sync)?\s*\(/;
const MAYBE_CREATION_CALL = new RegExp(
  `\\b(?:${[...CREATION_APIS].join('|')})\\s*\\(`,
);
const MAYBE_WINDOWS_ROOT = /['"`]\s*(?:[a-z]:[\\/]|\\\\\\\\)/i;
const MAYBE_FORBIDDEN_BASE =
  /\b(?:homedir|tmpdir)\s*\(|\bprocess\s*\.\s*cwd\s*\(|['"`]\/(?:[^/\s]|$)/i;

import { isInsideComment, maskNonCode } from './test-scratch-lexical';

function matchingClose(source: string, opening: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [source[opening]];
  for (let index = opening + 1; index < source.length; index++) {
    const character = source[index];
    if (character === '(' || character === '[' || character === '{')
      stack.push(character);
    else if (character === ')' || character === ']' || character === '}') {
      if (pairs[stack.at(-1) ?? ''] !== character) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function firstArgumentEnd(code: string, start: number, close: number): number {
  const stack: string[] = [];
  for (let index = start; index < close; index++) {
    const character = code[index];
    if (character === '(' || character === '[' || character === '{')
      stack.push(character);
    else if (character === ')' || character === ']' || character === '}')
      stack.pop();
    else if (character === ',' && stack.length === 0) return index;
  }
  return close;
}

function hasPathBase(argument: string, code: string): boolean {
  if (/\b(?:homedir|tmpdir)\s*\(|\bprocess\s*\.\s*cwd\s*\(/.test(code))
    return true;
  const fixedRoot = /['"`]\/(?:[^/\s]|$)|['"`][a-z]:[\\/]|['"`]\\\\/gi;
  return [...argument.matchAll(fixedRoot)].some(
    ({ index }) => !isInsideComment(argument, index ?? 0),
  );
}

export function isScratchViolation(source: string): boolean {
  if (
    !MAYBE_RAW_MKDTEMP.test(source) &&
    !(MAYBE_CREATION_CALL.test(source) && MAYBE_FORBIDDEN_BASE.test(source)) &&
    !(MAYBE_CREATION_CALL.test(source) && MAYBE_WINDOWS_ROOT.test(source))
  )
    return false;
  const code = maskNonCode(source);
  const callPattern = new RegExp(
    `(?:\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*)*\\b(${[...CREATION_APIS].join('|')})\\s*\\(`,
    'g',
  );
  for (const match of code.matchAll(callPattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const end = firstArgumentEnd(code, open + 1, close);
    if (
      match[1] === 'mkdtemp' ||
      match[1] === 'mkdtempSync' ||
      hasPathBase(source.slice(open + 1, end), code.slice(open + 1, end))
    )
      return true;
  }
  return false;
}
