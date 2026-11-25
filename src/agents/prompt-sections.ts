export interface PromptSectionInputs {
  readonly agentNames: readonly string[];
}

export interface PromptSections extends Readonly<Record<string, string>> {
  readonly intent_gate: string;
  readonly agents: string;
  readonly task_management: string;
  readonly verification: string;
  readonly orchestration: string;
  readonly delegation: string;
  readonly result_synthesis: string;
}

const INTENT_GATE_SECTION = [
  '<Intent_Gate>',
  'Classify the current turn before choosing tools or making changes.',
  '',
  '- Explain or ask how something works: research, then synthesize an answer.',
  '- Implement, add, create, fix, or change: plan the concrete implementation.',
  '- Look into, check, or investigate: gather evidence and report findings.',
  '- Evaluate or ask for an opinion: propose an approach and wait for approval.',
  '- Refactor or improve: assess the codebase before proposing a change.',
  '',
  'Reset intent from the current turn. Do not carry implementation authorization',
  'into a later question or investigation. A bug report authorizes diagnosis,',
  'not edits that were not explicitly requested.',
  '',
  'Before implementation, require an explicit request, concrete enough scope,',
  'and no blocking specialist result that the implementation depends on.',
  '</Intent_Gate>',
].join('\n');

const VERIFICATION_SECTION = [
  '<Verification_Gate>',
  'Before reporting completion, verify the changed files with diagnostics,',
  'focused tests, and the relevant build or runtime surface.',
  'Separate failures caused by the change from pre-existing failures.',
  '</Verification_Gate>',
].join('\n');

export const ORCHESTRATION_SECTION = [
  '<Orchestration_Guide>',
  'Own the overall outcome by separating discovery, implementation, and',
  'verification into clear phases. Coordinate specialist work instead of',
  'becoming the default implementation worker when a suitable lane exists.',
  '</Orchestration_Guide>',
].join('\n');

export const DELEGATION_SECTION = [
  '<Delegation_Guide>',
  'Give each specialist a bounded brief, explicit dependencies, a validation',
  'owner, and non-overlapping write ownership. Dispatch independent lanes in',
  'parallel and reconcile their results before dependent work proceeds.',
  '</Delegation_Guide>',
].join('\n');

export const RESULT_SYNTHESIS_SECTION = [
  '<Result_Synthesis_Guide>',
  'Reconcile specialist reports and partial changes into one outcome. Resolve',
  'contradictions, distinguish reported results from verified evidence, and',
  'surface unresolved blockers instead of silently choosing a guess.',
  '</Result_Synthesis_Guide>',
].join('\n');

const TASK_MANAGEMENT_SECTION = [
  '<Task_Management>',
  'Review the native completion results alongside any available artifacts before continuing dependent work.',
  '</Task_Management>',
].join('\n');

export function buildPromptSections(
  inputs: PromptSectionInputs,
): PromptSections {
  return {
    intent_gate: INTENT_GATE_SECTION,
    agents: buildAgentsSection(inputs.agentNames),
    task_management: TASK_MANAGEMENT_SECTION,
    verification: VERIFICATION_SECTION,
    orchestration: ORCHESTRATION_SECTION,
    delegation: DELEGATION_SECTION,
    result_synthesis: RESULT_SYNTHESIS_SECTION,
  };
}

function buildAgentsSection(agentNames: readonly string[]): string {
  const names = [...new Set(agentNames)].sort();
  if (names.length === 0) return '<Available_Agents />';

  return [
    '<Available_Agents>',
    ...names.map((name) => `- @${name}`),
    '</Available_Agents>',
  ].join('\n');
}
