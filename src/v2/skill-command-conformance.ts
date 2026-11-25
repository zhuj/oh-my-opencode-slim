/** Supported-host drift guard; never imported by a runtime entry point. */
import type { CommandInvocation } from '@opencode/plugin/promise/command';
import type { SessionDomain } from '@opencode/plugin/promise/session';
import type { SkillDomain, SkillEditor } from '@opencode/plugin/promise/skill';
import type { ProjectSkillV2Info } from '../config/project-skill-host-adapter';
import type {
  V2CommandDefinition,
  V2ProjectSkillInfo,
  V2SkillDomain,
} from './types';

type Expect<T extends true> = T;
type OfficialSkillList = Awaited<ReturnType<SkillDomain['list']>>;
type MirrorSkillList = Awaited<ReturnType<NonNullable<V2SkillDomain['list']>>>;
type SkillMetadata = Pick<V2ProjectSkillInfo, 'id' | 'name' | 'description'>;
type OfficialSkill = Parameters<SkillEditor['add']>[0];
// Strip only upstream nominal brands; keep every field and optionality.
type UnbrandedSkill = {
  [K in keyof OfficialSkill]: OfficialSkill[K] extends string
    ? string
    : OfficialSkill[K];
};
type _projectRegistration = Expect<
  ProjectSkillV2Info extends UnbrandedSkill ? true : false
>;
type _mirrorRegistration = Expect<
  V2ProjectSkillInfo extends UnbrandedSkill ? true : false
>;
type _officialMirror = Expect<
  OfficialSkill extends V2ProjectSkillInfo ? true : false
>;
type _mirrorKeys = Expect<
  keyof V2ProjectSkillInfo extends keyof OfficialSkill ? true : false
>;
type _registrationKeys = Expect<
  keyof ProjectSkillV2Info extends keyof OfficialSkill ? true : false
>;

type _skillListEnvelope = Expect<
  OfficialSkillList extends {
    location: unknown;
    data: readonly SkillMetadata[];
  }
    ? true
    : false
>;
type _mirrorSkillListEnvelope = Expect<
  MirrorSkillList extends { location: unknown; data: readonly SkillMetadata[] }
    ? true
    : false
>;
type _commandInvocation = Expect<
  CommandInvocation extends Parameters<V2CommandDefinition['execute']>[0]
    ? true
    : false
>;

// The prompt-agent scan permits this native command bridge because the host
// retains session agent selection separately from both invocation and prompt.
// If either contract adds a selector, revisit that allowance and its tests.
type _commandInheritsSessionAgent = Expect<
  'agent' extends keyof CommandInvocation | keyof CommandInvocation['prompt']
    ? false
    : true
>;
type _hostPromptInheritsSessionAgent = Expect<
  'agent' extends keyof Parameters<SessionDomain['prompt']>[0] ? false : true
>;
