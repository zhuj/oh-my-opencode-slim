import type { ModelArrayEntry } from './model-sentinel';
import { firstModelId, isDynamicModelRef } from './model-sentinel';
import type { DynamicModelRef } from './schema';

/** Resolves the model value to write into an agent's runtime config when applying
 *  the active (runtime) preset. Returns `undefined` when the preset says to inherit
 *  the session-selected model (no model set, or a dynamic ref like
 *  `{ dynamic: 'selected' }`); otherwise the concrete model string (or the primary
 *  id of an array-form model). */
export function resolveRuntimePresetModel(
  model: string | ModelArrayEntry[] | DynamicModelRef | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  if (isDynamicModelRef(model)) return undefined;
  return firstModelId(model);
}
