export function maskNonCode(source: string): string {
  const masked = source.split('');
  const blank = (index: number) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };
  const maskRange = (start: number, end: number): void => {
    for (let index = start; index < end; ) {
      const current = source[index];
      const next = source[index + 1];
      if (current === '/' && next === '/') {
        while (index < end && source[index] !== '\n') blank(index++);
      } else if (current === '/' && next === '*') {
        blank(index++);
        blank(index++);
        while (
          index < end &&
          !(source[index] === '*' && source[index + 1] === '/')
        )
          blank(index++);
        if (index < end) {
          blank(index++);
          blank(index++);
        }
      } else if (current === '`') {
        blank(index++);
        while (index < end) {
          if (source[index] === '\\') {
            blank(index++);
            if (index < end) blank(index++);
          } else if (source[index] === '`') {
            blank(index++);
            break;
          } else if (source[index] === '$' && source[index + 1] === '{') {
            blank(index++);
            blank(index++);
            const interpolationEnd = findClosingBrace(source, index);
            if (interpolationEnd < 0 || interpolationEnd >= end) break;
            maskRange(index, interpolationEnd);
            index = interpolationEnd;
            blank(index++);
          } else blank(index++);
        }
      } else if (current === '"' || current === "'") {
        index = skipQuoted(source, index, current, blank);
      } else if (current === '/' && isRegexStart(source, index)) {
        index = skipRegex(source, index, blank);
      } else index++;
    }
  };
  maskRange(0, source.length);
  return masked.join('');
}

function skipQuoted(
  source: string,
  start: number,
  quote: string,
  blank?: (index: number) => void,
): number {
  blank?.(start);
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      blank?.(index);
      index++;
      if (index < source.length) {
        blank?.(index);
        index++;
      }
    } else if (character === quote) {
      blank?.(index);
      return index + 1;
    } else {
      blank?.(index);
      index++;
    }
  }
  return index;
}

function isRegexStart(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor--;
  const previousLineEnd = source.lastIndexOf('\n', index - 1);
  if (previousLineEnd >= 0) {
    const previousLineStart = source.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const lineComment = source.indexOf('//', previousLineStart);
    const beforeComment = source.slice(previousLineStart, lineComment);
    if (
      lineComment >= previousLineStart &&
      lineComment < previousLineEnd &&
      cursor < previousLineEnd &&
      !/['"`]/.test(beforeComment)
    ) {
      cursor = lineComment - 1;
      while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor--;
    }
  }
  while (cursor >= 0) {
    const blockComment = source.lastIndexOf('*/', cursor);
    if (
      blockComment < 0 ||
      source.slice(blockComment + 2, cursor + 1).trim() !== ''
    )
      break;
    const blockStart = source.lastIndexOf('/*', blockComment);
    if (blockStart < 0) break;
    cursor = blockStart - 1;
    while (cursor >= 0 && /\s/.test(source[cursor] ?? '')) cursor--;
  }
  const previous = source[cursor];
  const prefix = source.slice(Math.max(0, cursor - 32), cursor + 1);
  return (
    previous === undefined ||
    /[([{:;,=!?&|+\-*%^~<>]/.test(previous) ||
    /\b(?:return|throw|case|yield|await)\s*$/.test(prefix)
  );
}

function findClosingBrace(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length; ) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'")
      index = skipQuoted(source, index, current);
    else if (current === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
    } else if (current === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      )
        index++;
      index = Math.min(index + 2, source.length);
    } else if (current === '`') index = skipTemplate(source, index);
    else if (current === '/' && isRegexStart(source, index))
      index = skipRegex(source, index);
    else if (current === '{') {
      depth++;
      index++;
    } else if (current === '}' && --depth === 0) return index;
    else index++;
  }
  return -1;
}

function skipRegex(
  source: string,
  start: number,
  blank?: (index: number) => void,
): number {
  let inClass = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    blank?.(index);
    if (character === '\\') {
      index++;
      blank?.(index);
    } else if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && index > start && !inClass) {
      index++;
      while (/[a-z]/i.test(source[index] ?? '')) {
        blank?.(index);
        index++;
      }
      return index;
    } else if (character === '\n') return index;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  for (let index = start + 1; index < source.length; ) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === '`') return index + 1;
    else if (source[index] === '$' && source[index + 1] === '{') {
      const end = findClosingBrace(source, index + 2);
      if (end < 0) return source.length;
      index = end + 1;
    } else index++;
  }
  return source.length;
}

export function isInsideComment(source: string, end: number): boolean {
  for (let index = 0; index < end; ) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2);
      if (lineEnd < 0 || end < lineEnd) return true;
      index = lineEnd + 1;
      continue;
    }
    if (current === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd < 0 || end < commentEnd + 2) return true;
      index = commentEnd + 2;
    } else if (current === "'" || current === '"') {
      index = skipQuoted(source, index, current);
    } else if (current === '`') {
      index = skipTemplate(source, index);
    } else if (current === '/' && isRegexStart(source, index)) {
      index = skipRegex(source, index);
    } else {
      index++;
    }
  }
  return false;
}
