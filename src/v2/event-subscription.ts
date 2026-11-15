// Setup-fixed subset of the pinned host event union. The mirror guard checks
// each name; server.connected passes automatically through native filters.
const BASE_TYPES = [
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
  'session.step.started',
  'session.step.failed',
  'session.step.ended',
  'form.created',
  'form.replied',
  'form.cancelled',
  'permission.asked',
  'permission.replied',
] as const;

const INTERVIEW_TEXT_TYPES = ['session.text.ended'] as const;
const SKILL_INVENTORY_TYPES = ['skill.updated', 'plugin.updated'] as const;

export type V2EventSubscriptionType =
  | (typeof BASE_TYPES)[number]
  | (typeof INTERVIEW_TEXT_TYPES)[number]
  | (typeof SKILL_INVENTORY_TYPES)[number];

export interface V2EventSubscriptionOptions {
  interview?: boolean;
  skills?: boolean;
}

export function buildV2EventSubscriptionTypes(
  options?: V2EventSubscriptionOptions,
): ReadonlyArray<V2EventSubscriptionType> {
  return Object.freeze([
    ...BASE_TYPES,
    ...(options?.interview ? INTERVIEW_TEXT_TYPES : []),
    ...(options?.skills ? SKILL_INVENTORY_TYPES : []),
  ]);
}
