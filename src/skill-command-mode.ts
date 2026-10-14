import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

export const SkillCommandModeSchema = z.enum(['none', 'full', 'reference']);
export type SkillCommandMode = z.infer<typeof SkillCommandModeSchema>;

const frontmatterSchema = z.object({
  slim: z.object({ command: SkillCommandModeSchema.optional() }).optional(),
});
const YAML_FRONTMATTER = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** Metadata only: never use the parser's stripped content as the skill body. */
export function parseSkillCommandMode(
  markdown: string,
): SkillCommandMode | undefined {
  const frontmatter = YAML_FRONTMATTER.exec(markdown)?.[0];
  if (!frontmatter) return undefined;
  try {
    // Only accept plain YAML delimiters, not gray-matter's executable engines.
    // Passing options also avoids caching complete skill sources globally.
    const parsed = frontmatterSchema.safeParse(
      matter(frontmatter.replace(/^\uFEFF/, ''), {}).data,
    );
    return parsed.success ? parsed.data.slim?.command : undefined;
  } catch {
    // Malformed optional metadata inherits the configured command mode.
    return undefined;
  }
}

export function resolveSkillCommandMode(
  skill: { readonly path?: string; readonly content?: string },
  globalMode: SkillCommandMode = 'full',
): SkillCommandMode {
  if (skill.path) {
    try {
      const stat = statSync(skill.path);
      const file = stat.isDirectory()
        ? join(skill.path, 'SKILL.md')
        : skill.path;
      const fileStat = stat.isDirectory() ? statSync(file) : stat;
      if (fileStat.isFile()) {
        const source = readFileSync(file, 'utf8');
        // Readable source is authoritative, even when metadata is absent/invalid.
        return parseSkillCommandMode(source) ?? globalMode;
      }
    } catch {
      // Virtual and host-managed skills need no readable filesystem source.
    }
  }
  return parseSkillCommandMode(skill.content ?? '') ?? globalMode;
}
