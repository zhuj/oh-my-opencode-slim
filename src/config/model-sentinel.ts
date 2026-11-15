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
  if (!Array.isArray(model)) return undefined;
  const first = model[0];
  return typeof first === 'string' ? first : first?.id;
}
