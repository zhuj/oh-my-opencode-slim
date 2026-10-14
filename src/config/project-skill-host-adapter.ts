import { assertSkillIdentifier } from '../utils/skill-policy-validation';
import type { ProjectSkillCandidate } from './project-skills';

export interface ProjectSkillHostSource extends ProjectSkillCandidate {
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly content: string;
}

/** Supported V2 Skill.Info (2.0.15-2.0.19); path is the skill directory. */
export interface ProjectSkillV2Info {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
}

/** Return an ordered, deduplicated V1 skill path list without mutating inputs. */
export function appendV1ProjectSkillPaths(
  existingPaths: readonly string[] | undefined,
  candidates: readonly ProjectSkillCandidate[],
): string[] {
  for (const candidate of candidates)
    assertSkillIdentifier(candidate.name, 'V1 project skill registration');
  const paths = [...(existingPaths ?? [])];
  const seen = new Set(paths);

  for (const candidate of candidates) {
    if (seen.has(candidate.directory)) continue;
    seen.add(candidate.directory);
    paths.push(candidate.directory);
  }

  return paths;
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
      path: candidate.directory,
      content: candidate.content,
    });
  }

  return infos;
}
