import { normalizeScopeDirectory } from '../utils/event-directory-scope';
import { getGlobalStore } from '../utils/global-store';
import { isRecord } from '../utils/guards';

export type NativeAdmissionRecovery = (
  event: Record<string, unknown>,
  sessionID: string,
  message: string,
) => Promise<string | undefined> | undefined;

const resolvers = getGlobalStore(
  'oh-my-opencode-slim.native-admission-recovery',
  () => new Map<string, Map<symbol, NativeAdmissionRecovery>>(),
);

export const nativeAdmissionChildrenKey =
  'oh-my-opencode-slim.native-admission-children';

export function registerNativeAdmissionRecovery(
  directory: string,
  resolver: NativeAdmissionRecovery,
): () => void {
  const path = normalizeScopeDirectory(directory);
  const owner = Symbol();
  const local =
    resolvers.get(path) ?? new Map<symbol, NativeAdmissionRecovery>();
  local.set(owner, resolver);
  resolvers.set(path, local);
  return () => {
    local.delete(owner);
    if (!local.size && resolvers.get(path) === local) resolvers.delete(path);
  };
}

export function nativeAdmissionRecoveryFor(
  event: Record<string, unknown>,
  fallbackDirectory: string,
): NativeAdmissionRecovery | undefined {
  const location =
    isRecord(event.location) && typeof event.location.directory === 'string'
      ? event.location.directory
      : fallbackDirectory;
  const local = resolvers.get(normalizeScopeDirectory(location));
  return local ? [...local.values()].at(-1) : undefined;
}

/** A destination with its queue turned off can still dispatch an exact
 * tracked failure, including while the origin event subscriber reloads. */
export function observeTrackedAdmissionFailure(
  event: Record<string, unknown>,
): boolean {
  if (
    event.type !== 'session.execution.failed' ||
    !isRecord(event.data) ||
    typeof event.data.sessionID !== 'string' ||
    !isRecord(event.durable) ||
    event.durable.aggregateID !== event.data.sessionID ||
    typeof event.durable.seq !== 'number' ||
    !Number.isSafeInteger(event.durable.seq)
  )
    return false;
  const child = getGlobalStore(
    nativeAdmissionChildrenKey,
    () =>
      new Map<
        string,
        {
          observe: (event: Record<string, unknown>) => boolean;
        }
      >(),
  ).get(event.data.sessionID);
  return child?.observe(event) === true;
}
