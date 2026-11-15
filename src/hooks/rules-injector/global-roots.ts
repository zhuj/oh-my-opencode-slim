import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfigSearchDirs } from '../../config/paths';
import {
  computeResourceDepth,
  type ProjectResourceRoot,
} from '../../config/project-resource-paths';

/**
 * Resolve the user-global `rules/` directories under every OpenCode config dir.
 *
 * These roots deliberately sit outside the project boundary, so
 * `resolveProjectResourceRoots` cannot produce them: it drops any canonical
 * path that fails its `isWithin` check. They are resolved separately here, and
 * the matcher orders them ahead of project rules because a config directory
 * scores `OPENCODE_CONFIG_DEPTH`, the smallest depth there is.
 *
 * Symlinks are not resolved. The stored path is what the config dir spells,
 * so a symlinked config dir keeps the identity the user configured and the
 * registry that `matchRulesForFile` builds stays keyed on that spelling.
 *
 * Each directory resolves inside its own try/catch. A global root is a
 * convenience layered on top of project rules, so an unreadable one (dangling
 * symlink, symlink loop, permission denied) must cost that directory only.
 * Letting the throw escape would abort the whole injection pass and silently
 * drop the project rules alongside it.
 */
export function resolveGlobalRuleRoots(): readonly ProjectResourceRoot[] {
  const roots: ProjectResourceRoot[] = [];
  const seen = new Set<string>();
  for (const configDir of getConfigSearchDirs()) {
    const root = buildGlobalRuleRoot(configDir);
    if (root === undefined || seen.has(root.path)) continue;
    seen.add(root.path);
    roots.push(root);
  }
  return roots;
}

/** Build one global root, or `undefined` when it is absent or unreadable. */
function buildGlobalRuleRoot(
  configDir: string,
): ProjectResourceRoot | undefined {
  try {
    const path = resolve(configDir, 'rules');
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats?.isDirectory()) return undefined;
    return {
      path,
      relativePath: 'global-rules',
      ancestor: configDir,
      depth: computeResourceDepth(configDir),
      prefix: 'global',
      prefixIndex: 0,
      category: 'rules',
      global: true,
    };
  } catch {
    return undefined;
  }
}
