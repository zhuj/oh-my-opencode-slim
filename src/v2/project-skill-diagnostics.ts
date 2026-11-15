export interface DiscoveryView {
  readonly diagnostics: readonly { readonly code: string }[];
}

export const ALLOWED_COLLISION_CODES: Set<string> = new Set([
  'duplicate-name',
  'host-name-conflict',
]);

export const BLOCKING_DIAGNOSTIC_CODES: Set<string> = new Set([
  'unreadable-root',
]);

export interface DiscoveryAcceptabilityOptions {
  readonly discovery: DiscoveryView;
  readonly nativeScanComplete: boolean;
  readonly editorInventoryComplete: boolean;
}

/** Fail-closed: skills accepted only when inventory is complete
 * and diagnostics contain only known benign collision codes.
 * Unreadable-root or any unknown/incomplete inventory blocks. */
export function isDiscoveryAcceptable(
  options: DiscoveryAcceptabilityOptions,
): boolean {
  const { discovery, nativeScanComplete, editorInventoryComplete } = options;
  if (!nativeScanComplete || !editorInventoryComplete) return false;
  for (const d of discovery.diagnostics) {
    if (BLOCKING_DIAGNOSTIC_CODES.has(d.code)) return false;
    if (!ALLOWED_COLLISION_CODES.has(d.code)) return false;
  }
  return true;
}
