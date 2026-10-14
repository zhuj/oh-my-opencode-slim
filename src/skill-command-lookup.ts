/**
 * Which slash-command names the plugin knows about, and the pure decision
 * whether a name is genuinely missing. Two independent sources feed it:
 *
 * - the merged host config captured by `prepareCommands` (v1: every host and
 *   user command; v2: only the plugin's own reserved command names, because
 *   the v2 setup hands `prepareCommands` an empty config), and
 * - the v2 generated skill-command names.
 *
 * A name absent from BOTH is reported as missing. Either set being unknown
 * leaves the host's own error in place rather than guessing.
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

let generatedSkillCommandNames: ReadonlySet<string> | undefined;

/**
 * Record the names the v2 skill-command bridge currently owns. `undefined`
 * (the initial state, and after a dispose) means the bridge never registered,
 * so only the merged config is authoritative.
 */
export function setGeneratedSkillCommandNames(
  names: readonly string[] | undefined,
): void {
  generatedSkillCommandNames = names === undefined ? undefined : new Set(names);
}

export function readGeneratedSkillCommandNames():
  | ReadonlySet<string>
  | undefined {
  return generatedSkillCommandNames;
}

/**
 * Missing-command text, or `undefined` when the name must be left alone
 * because a name set is unavailable or the name is known to one of them.
 */
export function resolveMissingCommandMessage(
  name: string,
  knownCommandNames: ReadonlySet<string> | undefined,
  generatedNames: ReadonlySet<string> | undefined = generatedSkillCommandNames,
): string | undefined {
  if (knownCommandNames === undefined) return undefined;
  if (knownCommandNames.has(name)) return undefined;
  if (generatedNames?.has(name)) return undefined;
  return formatMissingCommandMessage(name);
}
