const KNOWN_VARIANTS = new Set([
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'minimal',
  'none',
  'auto',
  'thinking',
]);
const MODEL_FAMILY_SEPARATOR_PATTERN =
  /claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)|kimi-k2[.-](\d+)|\b(glm|gpt)-(\d+)[.-](\d+)/g;

export function normalizeModelName(value: string): string {
  return value.replace(MODEL_FAMILY_SEPARATOR_PATTERN, (...parts: string[]) => {
    const [full, claudeFamily, claudeMajor, claudeMinor, kimiVersion] = parts;
    if (claudeFamily && claudeMajor && claudeMinor) {
      return `claude-${claudeFamily}-${claudeMajor}.${claudeMinor}`;
    }
    if (kimiVersion) return `kimi-k2.${kimiVersion}`;

    const glmOrGpt = parts[5];
    const major = parts[6];
    const minor = parts[7];
    return glmOrGpt && major && minor ? `${glmOrGpt}-${major}.${minor}` : full;
  });
}

export function stripKnownVariant(value: string): string {
  const trimmed = value.trim();
  const parenthesized = trimmed.match(/^(.*\S)\(([^()]+)\)\s*$/);
  if (parenthesized?.[2]?.trim()) {
    return parenthesized[1]?.trim() ?? trimmed;
  }

  const colon = trimmed.match(/^(.*\S):([^\s:]+)\s*$/);
  if (colon && KNOWN_VARIANTS.has(colon[2]?.toLowerCase() ?? '')) {
    return colon[1]?.trim() ?? trimmed;
  }

  const spaced = trimmed.match(/^(.*\S)\s+([a-z][a-z0-9_-]*)$/i);
  if (spaced && KNOWN_VARIANTS.has(spaced[2]?.toLowerCase() ?? '')) {
    return spaced[1]?.trim() ?? trimmed;
  }

  return trimmed;
}
