# Project-local Customization

A project can define specialists, prompts, file-operation rules, and supplemental
skills. Project configuration and these resources can influence model behavior
and access. Open trusted projects and review inherited configuration in parent
directories.

## Configuration and prompts

Slim loads OpenCode user settings first, then project settings from the eligible
ancestor `.opencode/oh-my-opencode-slim.json[c]` files, with the nearer layer
winning. Within a directory, `.jsonc` takes precedence over `.json`. Set
`OPENCODE_DISABLE_PROJECT_CONFIG=1` to disable the project config walk.
Root `agents.*` settings take precedence over the active preset’s entries.

An agent’s inline `prompt` takes precedence over its replacement file. At each
project ancestor, look for the preset-specific file before the root file and
then continue to the next ancestor. The same lookup applies independently to
`<agent>_append.md`. User-level prompt files follow project files. For example:

```text
.opencode/oh-my-opencode-slim/
├── oracle.md
├── oracle_append.md
└── review/
    ├── oracle.md
    └── oracle_append.md
```

See [Configuration](configuration.md) for agent definitions, prompt sections,
routing, and presets.

## Resource prefixes

Supplemental rules and skills are found from the active OpenCode directory
through the project or worktree boundary, inclusive. The directories searched
at each ancestor depend on the ordered `resource_prefixes` setting. Defaults
are `.local`, `.local/.slim`, and `.opencode`. Configure a complete replacement
list in `.opencode/oh-my-opencode-slim.jsonc`:

```jsonc
{
  "resource_prefixes": [".local", ".team-config"]
}
```

Prefixes are relative directory paths. Absolute paths, `..` traversal and roots
that resolve outside the project are excluded. A symlinked prefix within the
boundary retains its configured spelling when ranking roots. Roots are ranked
by ancestor depth, with prefix order breaking ties. An empty list disables
supplemental project rules and skills. OpenCode independently loads its native
skills, commands, agents, and instructions.

## Hierarchical rules

Place Markdown `.md` or `.mdc` files under `<prefix>/rules/`. A rule can opt in
for every eligible file with `alwaysApply: true` or match files with `globs`,
`paths`, or `applyTo`. Selectors are evaluated against a project-relative path
and its basename. A matching negative selector excludes the file.

```md
---
globs: src/**/*.ts
---

Use the shared API client for requests from this directory.
```

The plugin also reads `rules/` under the OpenCode config directories,
including `OPENCODE_CONFIG_DIR` and the user config directory. Those global
rules are considered first. A more specific rule file with the same basename
replaces a global or ancestor rule. An empty project rule file can suppress the
same-named inherited rule.

Slim appends matched rules to fresh successful native `read`, `write`, `edit`
and `patch` file results with verifiable paths inside the project. Rules are
ordered from least specific to most specific. The original tool output remains
the exact prefix. The hook ignores directory reads, remote or virtual paths,
unresolved result paths, failed operations and paths that escape through a
symlink. OpenCode continues to load `AGENTS.md` and other native instructions
itself.

Unchanged rules are delivered once per session and can be delivered again
after they change or the session compacts. A shared output budget is estimated
from a 50,000-token ceiling and half the remaining context when the host
provides current usage and model limits. The budget includes headings and
markers. Session deletion and plugin disposal clear the tracking state.

## Supplemental project skills

A supplemental skill has an ordinary `SKILL.md` file with a nonempty
frontmatter `name` matching its parent directory. For example:

```text
.local/skills/
└── project-review/
    └── SKILL.md
```

Slim discovers supplemental skills on setup and adds eligible definitions to
OpenCode’s native inventory. The native editor keeps existing identities and
loads standard OpenCode, Agents, and compatibility skill directories itself.
Hidden skill directories or names and paths that escape the project are
excluded. For a duplicate supplemental name, the nearest accepted root wins,
with prefix order breaking ties. Reload OpenCode after changing supplemental
files.

Enable `skills_include_local` for an agent to select discovered project skills
without listing every ID:

```jsonc
{
  "agents": {
    "oracle": {
      "skills_include_local": true,
      "skills_remove": ["project-release"]
    }
  }
}
```

This includes accepted supplemental IDs and valid native project skills from
the supported local discovery trees. Use matching frontmatter names and
directory IDs for native skills you want to grant this way. Explicit skill
permissions, global disables and removals still apply. See
[Skills](skills.md#skills-assignment) for additional selection forms and
[Skill Slash Commands](skills.md#skill-slash-commands) for command modes.
