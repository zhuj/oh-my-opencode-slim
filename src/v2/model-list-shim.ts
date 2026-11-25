import { isRecord } from '../utils/guards';

/** One executable model reference row (v1-shaped; `provider`/`id`). */
export type V2ModelListRow = {
  provider: string;
  id: string;
  limit?: { context?: number };
};

/** Missing discovery is unavailable, never an authoritative empty catalog. */
export function rowsFromModelDraft(
  draft: unknown,
): readonly V2ModelListRow[] | undefined {
  if (!isRecord(draft)) return undefined;
  // The v2.0.10+ `ModelEditor` draft (`ctx.model.transform`) nests the
  // immutable provider inputs under `provider.list()`; the `ProviderEditor`
  // draft (`ctx.provider.transform`) exposes the same `ProviderRecord[]`
  // via a flat `list()`. Prefer the nested surface, fall back to flat.
  const provider = isRecord(draft.provider) ? draft.provider : undefined;
  // The native model editor's own list enumerates models of available
  // providers. Its provider editor also includes inactive source templates.
  if (provider && typeof draft.list === 'function') {
    const available = rowsFromModelInfoList(draft.list());
    if (available) return available;
  }
  const nestedList =
    provider && typeof provider.list === 'function' ? provider.list : undefined;
  const list =
    nestedList ?? (typeof draft.list === 'function' ? draft.list : undefined);
  if (typeof list !== 'function') return undefined;
  const records: unknown = nestedList ? list.call(provider) : list.call(draft);
  if (!Array.isArray(records)) return undefined;
  const rows: V2ModelListRow[] = [];
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.provider)) return undefined;
    const recordProvider = record.provider;
    if (typeof recordProvider.id !== 'string' || !recordProvider.id.trim())
      return undefined;
    // v2.0.10+ marks off providers with `activation: 'disabled'`; older
    // hosts used a boolean `disabled` flag — either skips the whole record.
    if (recordProvider.activation === 'disabled') continue;
    if (recordProvider.disabled === true) continue;
    const entries =
      record.models instanceof Map
        ? [...record.models.entries()]
        : isRecord(record.models)
          ? Object.entries(record.models)
          : undefined;
    if (!entries) return undefined;
    for (const [modelID, info] of entries) {
      if (typeof modelID !== 'string' || !modelID.trim()) return undefined;
      // Per-model literal IDs (e.g. `inkling-small:free`) ride the map key
      // verbatim — never stripped, never normalized.
      if (isRecord(info) && info.enabled === false) continue;
      rows.push({
        provider: recordProvider.id,
        id: modelID,
        ...(isRecord(info) &&
        isRecord(info.limit) &&
        typeof info.limit.context === 'number'
          ? { limit: { context: info.limit.context } }
          : {}),
      });
    }
  }
  return rows;
}

/** Mutable snapshot the setup-time `ctx.model.transform`/provider
 * transform callback fills. */
export interface V2ModelListSnapshot {
  capture(draft: unknown): void;
  rows(): readonly V2ModelListRow[] | undefined;
}

export function createModelListSnapshot(): V2ModelListSnapshot {
  let rows: readonly V2ModelListRow[] | undefined;
  return {
    capture(draft: unknown) {
      rows = rowsFromModelDraft(draft);
    },
    rows() {
      return rows;
    },
  };
}

/** The live v2 model surface (`ctx.model.list()`, structural subset — no
 * @opencode package imports). `ModelDomain` extends the client `model`
 * API, so `list()` is a real RPC-backed call returning the host's current
 * filtered snapshot (`{location, data: ModelInfo[]}`): only enabled models
 * of configured providers, host-side availability predicate applied. */
export interface V2ModelListSource {
  list(): Promise<{ data: readonly unknown[] }>;
}

/** Map a live `ModelInfo[]` payload to v1 rows. Each element must carry a
 * string `providerID` and `modelID`; elements missing either are skipped.
 * The row id is `modelID` (the provider-scoped model name — e.g.
 * `thinkingmachines/inkling-small:free`, literal suffix, never stripped),
 * NOT the possibly-compound `id` field. Non-array input → undefined
 * (discovery unavailable, never fake-empty). */
export function rowsFromModelInfoList(
  list: unknown,
): readonly V2ModelListRow[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const rows: V2ModelListRow[] = [];
  let hasValidRows = list.length === 0;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const providerID = entry.providerID;
    const modelID = entry.modelID;
    if (typeof providerID !== 'string' || !providerID.trim()) continue;
    if (typeof modelID !== 'string' || !modelID.trim()) continue;
    hasValidRows = true;
    if (entry.enabled === false) continue;
    rows.push({
      provider: providerID,
      id: modelID,
      ...(isRecord(entry.limit) && typeof entry.limit.context === 'number'
        ? { limit: { context: entry.limit.context } }
        : {}),
    });
  }
  return hasValidRows ? rows : undefined;
}

/** Live-first model list shim: `liveList` is the host's `ctx.model.list()`
 * (fresh filtered snapshot at every call — resolve_model sees ONLY
 * configured providers/models). On any live failure (rejection, non-object
 * response, malformed payload) it falls back to the setup-time draft
 * snapshot; when neither yields rows it returns undefined (unavailable,
 * never fake-empty). Never throws. */
export function createLiveModelListShim(
  liveList: () => Promise<unknown> | undefined,
  snapshot: V2ModelListSnapshot,
): () => Promise<{ data: readonly V2ModelListRow[] } | undefined> {
  return async () => {
    try {
      const res = await liveList();
      if (res && typeof res === 'object') {
        const rows = rowsFromModelInfoList((res as { data?: unknown }).data);
        if (rows) return { data: rows };
      }
    } catch {
      // Live discovery failed — fall back to the setup-time snapshot.
    }
    const fallback = snapshot.rows();
    return fallback ? { data: fallback } : undefined;
  };
}

/** v1-shaped `client.model.list` served from the CAPTURED draft snapshot
 * (fallback-only path — the live `ctx.model.list()` shim in
 * createLiveModelListShim is preferred on v2 hosts). Undefined until a
 * draft was captured (and on malformed drafts) — callers treat that as
 * discovery unavailable, not an authoritative empty catalog. */
export function createModelListShim(
  snapshot: V2ModelListSnapshot,
): () => Promise<{ data: readonly V2ModelListRow[] } | undefined> {
  return async () => {
    const rows = snapshot.rows();
    if (!rows) return undefined;
    return { data: rows };
  };
}
