# src/hooks/deepwork/

**Last Updated:** 2026-10-20

## Responsibility

Provides an OpenCode hook implementation for managing deepwork sessions - heavy, multi-phase coding tasks that require structured planning, phased execution, and continuous validation.

This hook enables developers to:
- Initiate deepwork sessions via `/deepwork <task>` command
- Maintain `.local/.slim/deepwork/` progress tracking files
- Keep OpenCode todos synchronized with the current pass when available
- Run pass-by-pass work (sketch → structure → detail) with one `@oracle` gate per pass
- Execute passes with background specialist agents where appropriate
- Step back between passes to re-plan and reorganize code

## Design

### Core Abstraction
The hook follows the OpenCode plugin hook pattern, exposing a factory function `createDeepworkCommandHook()` that returns an object with two methods:

- `registerCommand(config)`: Registers the `deepwork` command in OpenCode configuration
- `handleCommandExecuteBefore(input, output)`: Intercepts command execution to inject the deepwork activation prompt

### State Management
- Uses OpenCode's internal agent text part system (`createInternalAgentTextPart`) for output
- Clears existing output parts before injecting deepwork prompt
- Validates task presence before activation

### Integration Points
- Consumes OpenCode session context (`sessionID`)
- Integrates with OpenCode command system via `command` configuration
- Leverages `@oracle` for review and simplification feedback
- Supports background specialist agents (`@fixer`, `@explorer`, etc.) for phase execution

## Flow

### Command Registration Phase
1. Plugin initialization calls `registerCommand()` with OpenCode configuration
2. Checks if `deepwork` command already registered
3. If not, adds command configuration:
   - Template: "Start a deepwork session for a complex coding task"
   - Description: "Use the deepwork workflow for heavy multi-phase coding work"

### Command Execution Phase
1. User invokes `/deepwork <task>` command
2. OpenCode triggers `handleCommandExecuteBefore()` hook
3. Hook validates command name (`deepwork`)
4. If no task provided:
   - Outputs error message via `createInternalAgentTextPart()`
   - Prompts user: "What task should deepwork manage? Run `/deepwork <task>`."
5. If task provided:
   - Clears existing output parts (`output.parts.length = 0`)
   - Generates activation prompt via `activationPrompt(task, sessionID)`
   - Injects activation prompt into output parts
   - Prompt = bundled SKILL.md body (single contract source, build-time text
     import) + pinned router-head path + task

### Deepwork Session Execution
1. Agent receives the full workflow instructions (SKILL.md body) with the pinned router-head path and task
2. Agent creates its `.local/.slim/deepwork/<session-id>.md` router head (`status:` + `slug:`) and the task directory it points to
3. Agent works in passes over the whole product (sketch → structure → detail), each with a one-line goal and a few disjoint lanes
4. One `@oracle` design review of the pass plan covers risky lanes before code; lanes report files, commands, and exit codes
5. Each pass ends with broad validation, one `@oracle` gate scoped to that pass, a commit, and a step back (re-plan, reorganize code if needed)
6. Runs autonomously to the end; asks only when truly blocked
7. Completion rewrites the progress file into a `status: completed` tombstone listing remaining known issues

## Integration

### Consumers
- **Main plugin** (`src/index.ts`): Registers the deepwork hook during plugin initialization
- **OpenCode CLI**: Invokes hook when `/deepwork` command is executed
- **Agents** (`@oracle`, `@fixer`, `@explorer`, etc.): Follow deepwork workflow for complex tasks

### Dependencies
- **Local utilities** (`src/utils`): Provide `createInternalAgentTextPart`; the host invokes the command hook interface
- **Configuration system**: Reads from `opencodeConfig.command` structure
- **Session system**: Receives `sessionID` for context tracking
- **Agent ecosystem**: Leverages specialist agents for phase execution


### Configuration Schema
```json
{
  "command": {
    "deepwork": {
      "template": "Start a deepwork session for a complex coding task",
      "description": "Use the deepwork workflow for heavy multi-phase coding work"
    }
  }
}
```

### File System
- Router head: `.local/.slim/deepwork/<session-id>.md`, path pinned by the activation prompt; task state lives in `.local/.slim/deepwork/<task-slug>/progress.md`
- Known migration gap: `src/hooks/deepwork-goal/index.ts` still reads and emits `.slim/deepwork/<session-id>.md`. The command's migrated path does not establish that the goal hook or all runtime guards read migrated state. Resume from the activation prompt's pinned head; this map does not claim a complete runtime path migration.


### Hook Contract
- **Input**: `{ command: string, sessionID: string, arguments: string }`
- **Output**: `{ parts: Array<{ type: string, text?: string }> }`
- **Side effects**: Modifies output parts array; the agent, not the hook, creates progress files
- **Validation**: Validates task presence, validates command name
