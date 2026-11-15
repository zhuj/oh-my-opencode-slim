/**
 * Which slash-command names the plugin knows about, and the pure decision
 * whether a name is genuinely missing. Two independent sources feed it:
 *
 * - the merged host config captured by `prepareCommands` (v1: every host and
 *   user command; v2: only the plugin's own reserved command names, because
 *   the v2 setup hands `prepareCommands` an empty config), and
 * - the v2 generated skill-command names.
 *
 * A name absent from both is reported as missing once the config inventory is
 * known. Generated names are an optional, setup-local supplement; this module
 * never retains a catalog across workspaces or plugin generations.
 */
import { formatMissingCommandMessage } from './skill-command-template';

/** Command names present in a merged OpenCode config. */
export function readConfigCommandNames(
  opencodeConfig: Record<string, unknown>,
): ReadonlySet<string> {
  const registry = opencodeConfig.command;
  if (registry === null || typeof registry !== 'object') return new Set();
  return new Set(Object.keys(registry));
}

/**
 * Missing-command text, or `undefined` when the name must be left alone
 * because config names are unavailable or the name is known to either source.
 */
export function resolveMissingCommandMessage(
  name: string,
  knownCommandNames: ReadonlySet<string> | undefined,
  generatedNames?: ReadonlySet<string>,
): string | undefined {
  if (knownCommandNames === undefined) return undefined;
  if (knownCommandNames.has(name)) return undefined;
  if (generatedNames?.has(name)) return undefined;
  return formatMissingCommandMessage(name);
}
