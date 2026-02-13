# CestDone Revamp Spec

## Context

CestDone is a CLI tool that uses two AI agents (Director + Coder) to implement software from a spec file. The Director analyzes requirements, asks clarifying questions, produces implementation plans, and reviews results. The Coder executes implementation tasks.

Phase 1 delivered 115 tests, Agent SDK integration for the Coder, and an execute→review loop. A live test revealed three critical bugs that require an architectural revamp rather than incremental fixes.

## Problems Found in Live Test

### Problem 1: Director Blind to Codebase

The Director uses the Claude Messages API with zero file access. It receives only spec text, its own prior messages, and the Coder's JSON report. It cannot read existing code, verify implementation results, or understand the target repo's current state.

**Impact**: Director produced a plan for work the Coder had already completed, because it couldn't see the files already created.

### Problem 2: `allowedTools` Does Not Restrict Tools

The Coder's `permissions.ts` maps each workflow step to an `allowedTools` array. However, `allowedTools` is only an auto-approval list in `bypassPermissions` mode — it does not limit which tools the model can use.

**Evidence**: Step 3 logged `allowedTools: ["Read","Write","Edit","Glob","Grep"]` but the session initialized with the full toolset including `Bash`, `Task`, `TodoWrite`, etc. The Coder used `Bash` freely throughout.

**Root cause**: The correct parameter is `tools: string[]`, which physically restricts which tools are available to the model. Spike test confirmed: when `tools` is set, only those tools + `StructuredOutput` appear in the session.

### Problem 3: Vague UpdateSpec Prompt

`prompt-builder.ts:75` sends `"Continue with step 3 for Phase 0: Public metrics scraper + dashboard."` to the Director. This is meaningless — the Director interpreted "continue" as "start implementing" and returned `action: "fix"` with implementation instructions, which the Coder then executed in full ($4.32, 49 turns) before the plan was even approved.

## Architecture: Current vs Target

### Current (Phase 1)

```
CLI orchestrator (director.ts)
  → Director (Claude Messages API, no file access, message threading)
  → Coder (Agent SDK query(), bypassPermissions, fresh context per call)
```

Dependencies: `@anthropic-ai/sdk` (Director) + `@anthropic-ai/claude-agent-sdk` (Coder)

### Target (Revamp)

```
CLI orchestrator (director.ts — TypeScript controls workflow)
  → Director AI (Agent SDK query(), read-only tools, outputFormat for structured JSON)
  → Coder AI (Agent SDK query(), full tools, outputFormat for structured JSON)
```

Dependencies: `@anthropic-ai/claude-agent-sdk` only. Remove `@anthropic-ai/sdk`.

## Detailed Changes

### 1. Director: Messages API → Agent SDK

Replace the `sendStep()` function (which calls `anthropic.messages.create()` and manages a growing message array) with `executeDirector()` using Agent SDK `query()`.

**Director `query()` config:**

```typescript
const result = query({
  prompt: directorPrompt,           // focused per-step prompt (see §4)
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: DIRECTOR_SYSTEM_PROMPT   // role definition, output format instructions
  },
  tools: ['Read', 'Glob', 'Grep'],  // read-only for most steps
  outputFormat: {
    type: 'json_schema',
    schema: DirectorResponseSchema   // { action, message, questions }
  },
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  cwd: config.targetDir,
  model: config.model,
  maxTurns: 15,
})
```

**Director tools by step:**

| Step | Tools | Rationale |
|------|-------|-----------|
| Analyze | `Read, Glob, Grep` | Read spec, explore codebase |
| Clarify | (none needed, pure Q&A) | `Read, Glob, Grep` |
| UpdateSpec | `Read, Glob, Grep` | Director produces spec update text; Coder writes it |
| Plan | `Read, Glob, Grep` | Read codebase to ground the plan |
| Approve | (human gate, no AI) | — |
| Execute | (Coder runs) | — |
| Review | `Read, Glob, Grep, Bash` | Run `npm test`, `tsc --noEmit`, read files |
| Complete | `Read, Glob, Grep` | Final summary |

**Note on Review step**: Director gets `Bash` only during review so it can run test commands. The system prompt constrains Bash usage to verification commands only.

### 2. Coder: Fix `tools` Parameter

Replace `allowedTools` with `tools` in the `query()` call. This is the actual restriction mechanism.

**Coder tools by step:**

| Step | `tools` |
|------|---------|
| UpdateSpec | `Read, Write, Edit, Glob, Grep` |
| Execute | `Read, Write, Edit, MultiEdit, Bash, Glob, Grep` |

### 3. Structured Output for Both Agents

Both Director and Coder use `outputFormat` to return typed JSON instead of relying on `tool_use` parsing.

**Director response schema:**

```typescript
interface DirectorResponse {
  action: 'analyze' | 'ask_human' | 'approve' | 'fix' | 'done' | 'escalate'
  message: string            // analysis, plan, or instructions for Coder
  questions?: string[]       // only when action === 'ask_human'
}
```

**Coder response schema:**

```typescript
interface CoderResponse {
  status: 'success' | 'partial' | 'failed'
  summary: string
  filesChanged: string[]
  testsRun?: { passed: number; failed: number; skipped: number }
  issues?: string[]
}
```

### 4. Per-Step Focused Prompts (No Message Accumulation)

The current Director accumulates messages across steps (growing context = growing cost and confusion). The revamp gives each step a focused, self-contained prompt.

All prompt templates live in a single file: **`src/director/prompts.ts`**. This includes both the Director system prompt and every per-step template, making them easy to find and tweak without touching orchestration logic.

**Step 1 — Analyze:**

```
You are analyzing a software project for implementation.

## Spec
{specContent}

## Current Codebase
Explore the project at {cwd} using Read/Glob/Grep to understand existing code.

## Task
List clarifying questions about requirements, ambiguities, or assumptions.
If the spec is clear enough to proceed, say so.
Do NOT make any file changes.
```

**Step 2 — Clarify (only if questions exist):**

```
You asked these questions about the spec:
{questions}

The human answered:
{answers}

Based on these clarifications, are there any remaining ambiguities?
If clear, indicate ready to proceed.
```

**Step 3 — UpdateSpec:**

```
## Original Spec
{specContent}

## Clarifications
{clarificationsText}

## Task
Produce an updated spec that incorporates all clarifications.
Return the full updated spec text in your message field.
Do NOT modify any files — just return the text.
```

Then the orchestrator (TypeScript) calls the Coder to write the updated spec to disk.

**Step 4 — Plan:**

```
## Updated Spec
{updatedSpec}

## Current Codebase
Explore {cwd} to understand what already exists.

## Task
Produce a detailed implementation plan as a numbered list of tasks.
Consider existing code — don't plan work that's already done.
Include file paths, function signatures, test strategy.
```

**Step 6 — Review (after Coder executes):**

```
## Implementation Plan
{plan}

## Coder Report
{coderReport}

## Task
Verify the implementation:
1. Read the files the Coder changed
2. Run `npm test` (or equivalent) via Bash
3. Run `tsc --noEmit` if TypeScript
4. Check that the plan's requirements are met

Report: what works, what's broken, what's missing.
If issues found, return action "fix" with specific instructions for the Coder.
If everything passes, return action "done".
```

### 5. Remove `@anthropic-ai/sdk` Dependency

The only consumer was the Director's `sendStep()` in `director.ts`. After switching to Agent SDK, remove:
- `@anthropic-ai/sdk` from `package.json`
- `CreateMessageFn`, `ApiResponse`, `ContentBlock` types from `director.ts`
- `sendStep()` / `extractAction()` functions and message accumulation logic in `director.ts`
- `src/director/prompt-builder.ts` (replaced by `src/director/prompts.ts`)

### 6. Strip `CLAUDECODE` Environment Variable

When running Agent SDK from within Claude Code (e.g. during development or testing), the `CLAUDECODE` env var triggers nesting detection and blocks child processes. Strip it in `coder.ts` before passing env to `query()`:

```typescript
const env = { ...process.env }
delete env.CLAUDECODE
// pass env to query() options
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types.ts` | **Update** | Add `DirectorResponse` schema. Update `CoderReport` to match new `CoderResponse`. |
| `src/coder/coder.ts` | **Fix** | Change `allowedTools` → `tools` in `query()` call. Strip `CLAUDECODE` env var. |
| `src/coder/permissions.ts` | **Fix** | Rename export to reflect `tools` semantics. |
| `src/coder/result-parser.ts` | **Simplify** | Parse `structured_output` from result instead of digging through `SDKResultMessage` fields. |
| `src/director/prompts.ts` | **New** | Single file containing all Director and Coder prompt templates (system prompts + per-step prompts). Easy to find and tweak. |
| `src/director/director.ts` | **Rewrite** | Replace `sendStep()`/`extractAction()` with `executeDirector()` via Agent SDK `query()`. Remove `CreateMessageFn`, `ApiResponse`, `ContentBlock` types, message accumulation. |
| `src/director/prompt-builder.ts` | **Delete** | Replaced by `src/director/prompts.ts`. |
| `package.json` | **Update** | Remove `@anthropic-ai/sdk` dependency. |
| `tests/*.test.ts` | **Update** | Rewrite Director tests to mock `query()` instead of `createMessage`. |

## Files That Stay the Same

- `cestdone-spec.md` — spec file format unchanged
- `src/shared/config.ts` — CLI config and options
- `src/cli/prompt.ts` — `askApproval()`, `askInput()`, terminal UI
- `src/shared/logger.ts` — pino logging
- `src/shared/spec-parser.ts` — spec file parsing
- `src/shared/spec-writer.ts` — spec file updates
- `src/director/model-selector.ts` — model selection per step
- `src/coder/coder-prompt.ts` — Coder prompt assembly (phase spec + instructions)
- Workflow step sequence (Analyze → Clarify → UpdateSpec → Plan → Approve → Execute → Review → Complete)
- Human approval gates

## Implementation Order

The changes are interdependent enough that splitting into phases adds overhead without reducing risk. Recommended: implement as a single batch, test-driven.

**Sequence within the batch:**

1. Update types (`DirectorResponse`, `CoderResponse` schemas) in `src/shared/types.ts`
2. Fix Coder tools restriction (`allowedTools` → `tools`) and strip `CLAUDECODE` env var in `src/coder/coder.ts`
3. Fix permissions export in `src/coder/permissions.ts`
4. Simplify result parser in `src/coder/result-parser.ts`
5. Create `src/director/prompts.ts` — all prompt templates in one file
6. Rewrite `src/director/director.ts` (Agent SDK `query()`, remove message accumulation)
7. Delete `src/director/prompt-builder.ts`
8. Remove `@anthropic-ai/sdk` from `package.json`
9. Update all tests

**Test strategy**: The existing 115 tests cover the Coder path well. The Director tests need rewriting since the underlying mechanism changes from Messages API to Agent SDK. Mock `query()` at the SDK wrapper boundary — same pattern used for Coder tests.

## Validation Criteria

A successful revamp means:

1. `npm test` — all tests pass
2. `tsc --noEmit` — no type errors
3. Live test with the same spec as the failed run:
   - Director explores the codebase before planning (verify via logs: Glob/Read tool calls)
   - Step 3 (UpdateSpec) does NOT trigger implementation
   - Coder tools are actually restricted (verify via logs: session only shows permitted tools)
   - Director reviews by reading files and running tests (verify via logs: Bash tool calls in review step)
   - Total cost < $3 for a simple spec (vs $4.32+ in the failed run)

## Spike Results (Pre-validated)

All three spike tests passed, confirming the architecture is viable:

| Test | Result | Key Finding |
|------|--------|-------------|
| Director with `outputFormat` | PASS | Structured JSON output works. Director read files via Glob+Read. |
| `tools` restriction | PASS | With `tools: ['Read','Glob','Grep']`, Write/Bash not available. File not created. |
| Sequential Director → Coder | PASS | Both returned structured output. Coder created file successfully. |

Critical discovery: `allowedTools` ≠ tool restriction. `tools` is the actual gate. This is the root cause of Problem 2.
