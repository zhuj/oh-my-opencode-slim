import { assertSkillIdentifier } from '../utils/skill-policy-validation';
import type { ProjectSkillCandidate } from './project-skills';

export interface ProjectSkillHostSource extends ProjectSkillCandidate {
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly content: string;
}

/** Native v2 skill registration uses the SKILL.md path. */
export interface ProjectSkillV2Info {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
}

/** Convert candidate content to V2 Skill.Info records, excluding host IDs. */
export function toV2ProjectSkillInfos(
  existingHostSkillIds: readonly string[],
  candidates: readonly ProjectSkillHostSource[],
): ProjectSkillV2Info[] {
  for (const candidate of candidates)
    assertSkillIdentifier(candidate.name, 'V2 project skill registration');
  const seen = new Set(existingHostSkillIds);
  const infos: ProjectSkillV2Info[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);

    infos.push({
      id: candidate.name,
      name: candidate.name,
      ...(candidate.description === undefined
        ? {}
        : { description: candidate.description }),
      ...(candidate.autoinvoke === undefined
        ? {}
        : { autoinvoke: candidate.autoinvoke }),
      path: candidate.skillFilePath,
      content: candidate.content,
    });
  }

  return infos;
}
