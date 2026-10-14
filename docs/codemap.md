# Codemap Skill

Codemap is a **custom skill** bundled with this repo.

It helps agents quickly build a high-quality mental model of an unfamiliar codebase by generating a structured *codemap* and tracking changes over time.

## What it does

Codemap is designed for repository understanding and hierarchical codemap generation:

1. Selects relevant code/config files using LLM judgment
2. Creates `.local/.slim/codemap.json` for change tracking
3. Generates mirrored maps under `.local/.slim/codemaps/`
4. Non-destructively migrates legacy state into the new root

State lookup order is `.local/.slim/codemap.json`, `.slim/codemap.json`, then
`.slim/cartography.json`. When only legacy state exists, Codemap copies the
first valid file to the new root and preserves the original.

## How to use

Codemap is registered in-process with the bundled skills on supported V2 hosts.
V1 retains the legacy bundled command template. See [Skills](skills.md) for
host delivery and permission details.

### Run it (manual / local)

From a repo root (or with an explicit `--root`):

```bash
# Initialize mapping
node codemap.mjs init --root /repo --include "src/**/*.ts" --exclude "node_modules/**"

# Check what changed
node codemap.mjs changes --root /repo

# Update hashes
node codemap.mjs update --root /repo
```

## Outputs

### `.local/.slim/codemap.json`

A change-tracking file with hashes for files/folders.

### `.local/.slim/codemaps/`

Generated maps mirror source paths without writing into source directories.
For example, the map for `src/agents/` is
`.local/.slim/codemaps/src/agents/codemap.md`; the generated root atlas is
`.local/.slim/codemaps/codemap.md`.

Empty templates let a Fixer-style agent fill in:

- Responsibility
- Design patterns
- Data/control flow
- Integration points

Existing `codemap.md` files in the project root or source directories are
treated as authored legacy maps and are never deleted or overwritten. Existing
`AGENTS.md` repository-map references are likewise left intact; newly added
references should point to `.local/.slim/codemaps/codemap.md`.

## Screenshot

The existing screenshot lives in `img/cartography.png`.

![Codemap screenshot](../img/cartography.png)

## Related

- `src/skills/codemap/README.md` and `src/skills/codemap/SKILL.md` contain the skill’s internal docs.
- Existing `codemap.md` files at the repo root remain valid authored legacy maps.
