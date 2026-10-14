import matter from 'gray-matter';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
} from '../utils/skill-policy-validation';

/**
 * Quote malformed plain YAML values containing colons by converting them to
 * block scalars, matching OpenCode's tolerance for Claude-style descriptions.
 */
function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const lines = match[1].split(/\r?\n/);
  const sanitized: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '' || /^\s/.test(line)) {
      sanitized.push(line);
      continue;
    }

    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!keyValue) {
      sanitized.push(line);
      continue;
    }

    const [, key, rawValue] = keyValue;
    const value = rawValue.trim();
    if (
      value === '' ||
      value === '>' ||
      value === '|' ||
      value.startsWith('"') ||
      value.startsWith("'") ||
      !value.includes(':')
    ) {
      sanitized.push(line);
      continue;
    }

    sanitized.push(`${key}: |-`, `  ${value}`);
  }

  return content.replace(match[1], sanitized.join('\n'));
}

function isSkillFrontmatter(
  data: unknown,
): data is { name: string; description?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as { name?: unknown }).name === 'string' &&
    ((data as { description?: unknown }).description === undefined ||
      typeof (data as { description?: unknown }).description === 'string')
  );
}

function normalizedSkillName(data: unknown): string | undefined {
  if (
    data !== null &&
    typeof data === 'object' &&
    'name' in data &&
    typeof data.name === 'number'
  ) {
    assertSkillIdentifier(String(data.name), 'marketplace skill frontmatter');
  }
  if (!isSkillFrontmatter(data)) return undefined;

  const name = data.name.trim();
  assertSkillIdentifier(name, 'marketplace skill frontmatter');
  return name === '' ? undefined : name;
}

/** Parse skill frontmatter and return its string name when valid. */
export function parseSkillFrontmatterName(content: string): string | undefined {
  try {
    const parsed = matter(content);
    return normalizedSkillName(parsed.data);
  } catch (error) {
    if (error instanceof InvalidSkillPolicyError) throw error;
    try {
      const parsed = matter(fallbackSanitization(content));
      return normalizedSkillName(parsed.data);
    } catch (fallbackError) {
      if (fallbackError instanceof InvalidSkillPolicyError) throw fallbackError;
      return undefined;
    }
  }
}
