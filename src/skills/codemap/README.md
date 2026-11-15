# Codemap Skill

Repository understanding and hierarchical codemap generation.

## Overview

Codemap helps orchestrators map and understand codebases by:

1. Selecting relevant code/config files using LLM judgment
2. Creating `.local/.slim/codemap.json` for change tracking
3. Generating empty maps under `.local/.slim/codemaps/`

When new-root state is absent, legacy state is read in this order:

1. `.slim/codemap.json`
2. `.slim/cartography.json`

The first valid legacy state is copied to `.local/.slim/codemap.json`.
Migration is non-destructive: legacy state and authored `codemap.md` files in
the project root or source directories are left untouched.

## Commands

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

```json
{
  "metadata": {
    "version": "1.0.0",
    "last_run": "2026-01-25T19:00:00Z",
    "include_patterns": ["src/**/*.ts"],
    "exclude_patterns": ["node_modules/**"]
  },
  "file_hashes": {
    "src/index.ts": "abc123..."
  },
  "folder_hashes": {
    "src": "def456..."
  }
}
```

### `.local/.slim/codemaps/`

Generated maps mirror source paths without writing into source directories.
For example, `src/agents/` maps to
`.local/.slim/codemaps/src/agents/codemap.md`, while the generated repository
atlas is `.local/.slim/codemaps/codemap.md`.

Each empty template is ready for fixers to fill with:
- Responsibility
- Design patterns
- Data/control flow
- Integration points

## Installation

Installed automatically via oh-my-opencode-slim installer when custom skills are enabled.
