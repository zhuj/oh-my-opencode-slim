import type { DynamicModelRef, ModelEntry } from './schema';

/** A single entry in an array-form model override: a bare model id or a
 *  `{ id, variant? }` object. */
export type ModelArrayEntry = string | ModelEntry;

export type SentinelModelInput =
  | string
  | ModelEntry
  | ModelArrayEntry[]
  | DynamicModelRef
  | undefined
  | null;

/** Returns true when `model` is the dynamic "use UI-selected model" reference
 *  (e.g. `{ dynamic: 'selected' }`). Strings, ModelEntry objects, and arrays
 *  are not dynamic refs. */
export function isDynamicModelRef(
  model: SentinelModelInput,
): model is DynamicModelRef {
  return (
    model !== null &&
    typeof model === 'object' &&
    !Array.isArray(model) &&
    'dynamic' in model &&
    typeof model.dynamic === 'string' &&
    model.dynamic === 'selected'
  );
}

/** Returns the primary (first) model id from a model override value, or
 *  `undefined` for empty/undefined/dynamic-ref inputs. Strings pass through
 *  unchanged; array-form entries use their first element (a bare id string or a
 *  `{ id, variant? }` object). */
export function firstModelId(
  model: string | ModelArrayEntry[] | DynamicModelRef | undefined,
): string | undefined {
  if (typeof model === 'string') return model;
  if (Array.isArray(model) && model.length) {
    return resolveFirstModel(model);
  }
  return undefined;
}

function resolveFirstModel(
  models: Array<string | ModelEntry>,
): string | undefined {
  if (models.length === 0) return undefined;
  const first = models[0];
  return typeof first === 'string' ? first : first?.id;
}

export type ResolvedModel =
  | { type: 'inherit' }
  | { type: 'concrete'; value: string | ModelEntry[] };

/** Normalizes an AgentOverrideConfig model value into either "inherit the session model"
 *  (undefined or a dynamic ref) or "use this concrete value". The schema's array form
 *  is `(string | ModelEntry)[]`; string entries are normalized to `{ id }` so callers
 *  always receive a `ModelEntry[]`. Plain strings and the dynamic ref
 *  (`{ dynamic: 'selected' }`) pass through unchanged. */
export function resolveModelOverride(
  model: string | ModelArrayEntry[] | DynamicModelRef | undefined,
): ResolvedModel {
  if (model === undefined) {
    return { type: 'inherit' };
  }
  if (isDynamicModelRef(model)) {
    return { type: 'inherit' };
  }
  if (typeof model === 'string') {
    return { type: 'concrete', value: model };
  }
  // Array form: normalize string entries to { id } so callers get ModelEntry[].
  const normalized = model.map((m) => (typeof m === 'string' ? { id: m } : m));
  return { type: 'concrete', value: normalized };
}
