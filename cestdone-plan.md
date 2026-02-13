# Phase 1 Implementation Plan

**Status:** approved
**Created:** 2026-02-13
**Phase:** 1 — Agent SDK integration (Coder)
**SDK version:** `@anthropic-ai/claude-agent-sdk@0.2.41`

This file is the Coder's contract. If this chat dies and we resume in a new session, the Coder reads this file and picks up where it left off.

---

## 1. File Structure

### New files (5 source + 4 test)

| File | Purpose |
|---|---|
| `src/coder/permissions.ts` | `getAllowedTools(step)` — maps WorkflowStep to Agent SDK `allowedTools` string arrays |
| `src/coder/result-parser.ts` | Extracts structured `CoderResult` from `SDKResultMessage`, with JSON parse + fallback |
| `src/coder/coder-prompt.ts` | Builds the Coder prompt string from Director instructions + phase context |
| `tests/permissions.test.ts` | Tests for tool permission mapping per step |
| `tests/result-parser.test.ts` | Tests for structured output extraction, JSON fallback, error subtypes |
| `tests/coder.test.ts` | **Overwrite existing stub test** — new tests for `executeCoder()` with mocked `query()` |
| `tests/coder-prompt.test.ts` | Tests for prompt assembly (house-rules injection, phase context) |

### Modified files (5)

| File | What changes |
|---|---|
| `src/coder/coder.ts` | Full rewrite: wraps Agent SDK `query()`, streams events to logger, returns parsed `CoderResult` |
| `src/director/director.ts` | Steps 6-7 call real `executeCoder()` instead of stub; Step 7 review loop with fix instructions |
| `src/shared/types.ts` | Add `CoderReport` (structured output schema type), expand `CoderResult`, add `CoderOptions` |
| `src/shared/config.ts` | Add `maxTurns`, `maxBudgetUsd` to `Config` type + defaults |
| `src/cli/index.ts` | Pass `targetRepoPath` and config to Coder dependency; update `DirectorDeps.coderExecute` signature |
| `package.json` | Add `@anthropic-ai/claude-agent-sdk` production dependency |
| `tests/director.test.ts` | Update mocks for new `coderExecute` async signature |
| `tests/config.test.ts` | Add tests for new config fields |
| `tests/integration.test.ts` | Update to mock Agent SDK `query()` instead of just the stub |

**Total: 5 new source files, 5 modified source files, 4 new test files, 3 modified test files**

---

## 2. Dependency Changes

```
+ @anthropic-ai/claude-agent-sdk  ^0.2.41   (production)
```

No other dependency changes. The existing `@anthropic-ai/sdk` stays for the Director's Messages API calls.

Install: `npm install @anthropic-ai/claude-agent-sdk@^0.2.41`

---

## 3. Architecture Decisions (from Director analysis)

These are pre-approved — do NOT re-decide:

| Decision | Value |
|---|---|
| SDK version | V1 stable (`query()` async generator) |
| Permission mode | `bypassPermissions` + `allowDangerouslySkipPermissions: true` |
| System prompt | `{ type: 'preset', preset: 'claude_code', append: houseRules + stepInstructions }` |
| Session model | New `query()` per Director→Coder call (no session resume within a phase) |
| `cwd` | Resolved `targetRepoPath` from config |
| `maxTurns` | 100 default, configurable in `.cestdonerc.json` |
| `model` | Set by Director's `selectModel()` per step |
| Streaming | ALL `SDKMessage` events logged to pino at debug level |
| Terminal output | Director summaries only, NOT Coder stream |
| Cost tracking | `total_cost_usd` from `SDKResultMessage`, logged per step + accumulated per phase |
| Structured output | `outputFormat` with JSON schema for Coder's final report |

### Step-level tool permissions

| Steps | Mode | `allowedTools` |
|---|---|---|
| 1, 4 (analyze/plan) | Read-only | `['Read', 'Glob', 'Grep']` |
| 3 (spec update) | Spec editing | `['Read', 'Write', 'Edit', 'Glob', 'Grep']` |
| 6 (execute) | Full auto-edit | `['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']` |

### Structured output schema (Coder report)

```json
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["success", "error", "partial"] },
    "summary": { "type": "string" },
    "filesChanged": { "type": "array", "items": { "type": "string" } },
    "testResults": { "type": "string" },
    "questions": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["status", "summary"]
}
```

---

## 4. TDD Sequence

### Module L: `src/shared/types.ts` — Type updates

No tests. Add:
- `CoderReport` — the structured output shape (status, summary, filesChanged, testResults, questions)
- Expand `CoderResult` — add `cost`, `numTurns`, `durationMs`, `report` (parsed `CoderReport | null`)
- `CoderOptions` — `{ step, phase, model, targetRepoPath, houseRulesContent, maxTurns, maxBudgetUsd, instructions }`

### Module M: `src/shared/config.ts` — Config additions

| # | Red (test) | Green (code) |
|---|---|---|
| M1 | `maxTurns` defaults to 100 when not in `.cestdonerc.json` | Add to `DEFAULTS` |
| M2 | `maxBudgetUsd` defaults to `undefined` when not set | Add optional field |
| M3 | `.cestdonerc.json` with `maxTurns: 50` overrides default | Already works via spread, just add test |

### Module N: `src/coder/permissions.ts` — Tool permissions

| # | Red (test) | Green (code) |
|---|---|---|
| N1 | Steps 1, 4 return `['Read', 'Glob', 'Grep']` | Switch on step |
| N2 | Step 3 returns `['Read', 'Write', 'Edit', 'Glob', 'Grep']` | Add case |
| N3 | Step 6 returns `['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']` | Add case |
| N4 | Other steps (2, 5, 7, 8) throw — Director-only, no Coder call | Default throws |

### Module O: `src/coder/coder-prompt.ts` — Prompt builder

| # | Red (test) | Green (code) |
|---|---|---|
| O1 | Includes Director's instructions in prompt | Template with instructions field |
| O2 | Includes house-rules content when provided | Conditional append |
| O3 | Includes phase context (number, name, spec) | Add phase section |
| O4 | Includes reporting instructions (diff to cestdone-diff.txt, test results) | Append report format section |
| O5 | Read-only steps include "Do NOT modify any files" constraint | Conditional constraint based on step |

### Module P: `src/coder/result-parser.ts` — Result extraction

| # | Red (test) | Green (code) |
|---|---|---|
| P1 | Parses `structured_output` from successful `SDKResultMessage` into `CoderReport` | Check `subtype === 'success'`, read `structured_output` |
| P2 | Falls back to extracting from `result` text when `structured_output` is missing | Try `JSON.parse(result)`, catch → raw text |
| P3 | Returns error result for `error_max_turns` subtype | Map subtype to `CoderResult` with error status |
| P4 | Returns error result for `error_during_execution` | Map subtype |
| P5 | Returns error result for `error_max_budget_usd` | Map subtype |
| P6 | Extracts `total_cost_usd`, `num_turns`, `duration_ms` into `CoderResult` fields | Map from `SDKResultMessage` |
| P7 | Raw text fallback produces `CoderReport` with `status: 'partial'` and `summary` from text | Wrap raw text into report shape |

### Module Q: `src/coder/coder.ts` — Core Agent SDK wrapper

| # | Red (test) | Green (code) |
|---|---|---|
| Q1 | Calls `query()` with correct `prompt`, `cwd`, `model`, `maxTurns` | Build options, call query |
| Q2 | Sets `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true` | Add to options |
| Q3 | Sets `allowedTools` from `getAllowedTools(step)` | Call permissions module |
| Q4 | Sets `systemPrompt` with `preset: 'claude_code'` and appended house-rules | Build systemPrompt object |
| Q5 | Sets `outputFormat` with the `CoderReport` JSON schema | Add outputFormat to options |
| Q6 | Sets `maxBudgetUsd` from config when defined | Conditional option |
| Q7 | Iterates async generator, logs `SDKSystemMessage` at debug | for-await loop with type switch |
| Q8 | Logs `SDKAssistantMessage` content blocks at debug (text + tool calls) | Log text blocks and tool name/input summaries |
| Q9 | Logs `SDKResultMessage` at info (cost, turns, duration, subtype) | Log result fields |
| Q10 | Returns parsed `CoderResult` from result-parser | Call `parseResult()` on final message |
| Q11 | Handles generator yielding no result message (edge case) — returns error | Null check after loop |
| Q12 | `query()` throws exception (network error, SDK crash) — catches and returns `CoderResult` with `status: 'error'`, `report.summary` containing the error message, `cost: 0`. Does NOT propagate | try/catch around entire query loop |

### Module R: `src/director/director.ts` — Steps 6-7 rewrite

| # | Red (test) | Green (code) |
|---|---|---|
| R1 | Step 6 calls `coderExecute` with instructions from Director's approved plan | Pass plan text + phase + step + config to coder |
| R2 | Step 6 passes correct `model` from `selectModel()` | Use model selector |
| R3 | Step 7 reviews `CoderResult` — if `status === 'success'`, proceeds to Step 8 | Check result status |
| R4 | Step 7 on `status === 'error'` or `'partial'` — sends fix instructions back to Coder (Step 6 retry) | Loop: Step 6→7 until success or max retries |
| R5 | Step 7 max review iterations (3) — escalates to human if Coder keeps failing | Counter + askInput for guidance |
| R6 | Step 7 displays Coder summary to human (not full stream, just the summary from result) | Call `deps.display()` with report summary |
| R7 | `coderExecute` in `DirectorDeps` signature changes to async with `CoderOptions` param | Update interface |
| R8 | Cost accumulation: logs total cost after each Coder call | Sum `coderResult.cost` across calls |
| R9 | Step 3 (spec update) calls Coder with spec-editing permissions instead of context-only note | New Coder call for spec update |

### Module S: Integration updates

| # | Red (test) | Green (code) |
|---|---|---|
| S1 | `cli/index.ts` — `buildDeps()` creates async `coderExecute` that calls `executeCoder()` | Wire new coder module |
| S2 | `cli/index.ts` — passes `targetRepoPath` and config through to Coder | Thread config |
| S3 | Integration test — mocks `query()` from Agent SDK, verifies full Director→Coder→Director flow | Mock at SDK import level |
| S4 | Integration test — verifies Coder receives correct `allowedTools` for each step | Assert mock calls |

---

## 5. TODO Checklist (Implementation Order)

This is the contract. Executed in this exact order:

```
 1. [ ] Install dependency: npm install @anthropic-ai/claude-agent-sdk@^0.2.41
 2. [ ] shared/types.ts — add CoderReport, CoderOptions, expand CoderResult (Module L)
 3. [ ] shared/config.ts — TDD: M1 red→green, M2 red→green, M3 red→green
 4. [ ] coder/permissions.ts — TDD: N1 red→green, N2 red→green, N3 red→green, N4 red→green
 5. [ ] coder/coder-prompt.ts — TDD: O1 red→green, O2 red→green, ... O5 red→green
 6. [ ] coder/result-parser.ts — TDD: P1 red→green, P2 red→green, ... P7 red→green
 7. [ ] coder/coder.ts — TDD: Q1 red→green, Q2 red→green, ... Q12 red→green
 8. [ ] director/director.ts — TDD: R1 red→green, R2 red→green, ... R9 red→green
 9. [ ] cli/index.ts — update buildDeps() wiring (S1, S2)
10. [ ] Update existing tests: director.test.ts, integration.test.ts (S3, S4)
11. [ ] npx tsc — zero errors
12. [ ] npm run test — all pass
13. [ ] Review for dead code, unused imports, clean up
```

Steps 1-2 are foundation (types + dependency). Steps 3-6 are bottom-up unit-tested leaf modules. Step 7 is the core SDK wrapper. Step 8 is the Director orchestration update. Steps 9-10 are wiring + integration. Steps 11-13 are the acceptance gate.

---

## 6. Key Implementation Details

### 6a. `executeCoder()` signature

```typescript
export async function executeCoder(options: CoderOptions): Promise<CoderResult>
```

Where `CoderOptions`:
```typescript
interface CoderOptions {
  step: WorkflowStep
  phase: Phase
  model: string
  targetRepoPath: string
  houseRulesContent: string
  instructions: string
  maxTurns: number
  maxBudgetUsd?: number
  apiKey: string
  logLevel: string
}
```

### 6b. `query()` call shape

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: buildCoderPrompt(options),
  options: {
    model: options.model,
    cwd: path.resolve(options.targetRepoPath),
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: getAllowedTools(options.step),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.houseRulesContent + '\n\n' + stepInstructions,
    },
    outputFormat: {
      type: 'json_schema',
      schema: CODER_REPORT_SCHEMA,
    },
  },
})
```

### 6c. Director Steps 6-7 rewrite pattern

```
Step 6 (Execute):
  formulate instructions from approved plan
  call executeCoder({ step: Execute, instructions, ... })
  capture CoderResult

Step 7 (Review):
  reviewCount = 0
  while coderResult.status !== 'success' AND reviewCount < MAX_REVIEWS:
    display coderResult summary to human
    formulate fix instructions from Director via API call
    call executeCoder({ step: Execute, instructions: fixInstructions, ... })
    reviewCount++
  if still failing after MAX_REVIEWS:
    escalate to human
```

### 6d. `DirectorDeps` interface change

```typescript
// Before (Phase 0):
coderExecute: () => CoderResult

// After (Phase 1):
coderExecute: (options: CoderOptions) => Promise<CoderResult>
```

This is the only breaking change to the Director interface. All existing tests mock this — they need updating.

### 6e. Logging strategy

| Event | Level | What's logged |
|---|---|---|
| `SDKSystemMessage` (init) | debug | session_id, model, tools, cwd |
| `SDKAssistantMessage` | debug | text content (truncated to 500 chars), tool name + input keys |
| `SDKResultMessage` | info | subtype, cost, turns, duration, result summary (first 200 chars) |
| Coder call start | info | step, model, phase, allowedTools |
| Coder call end | info | status, cost, turns |
| Cost accumulation | info | total phase cost so far |

### 6f. Test mocking strategy

The Coder tests mock `query()` at the module level:

```typescript
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}))
```

The mock returns an async generator that yields a sequence of `SDKMessage` objects, ending with an `SDKResultMessage`. This allows testing:
- That correct options are passed to `query()`
- That events are logged correctly
- That the result is parsed correctly
- Error subtypes are handled

The Director tests mock `coderExecute` directly (it's a dep injection), so they don't need to know about the SDK at all.

---

## 7. Estimated Scope

| Category | Files | Lines (approx) |
|---|---|---|
| Type additions (types.ts) | 1 (modified) | +40 |
| Config additions (config.ts) | 1 (modified) | +10 |
| Permissions module | 1 (new) | ~30 |
| Coder prompt builder | 1 (new) | ~60 |
| Result parser | 1 (new) | ~70 |
| Coder SDK wrapper | 1 (rewrite) | ~100 |
| Director update | 1 (modified) | +60 (net, replacing ~15 stub lines) |
| CLI wiring update | 1 (modified) | +15 |
| New tests (permissions, result-parser, coder, coder-prompt) | 4 (new) | ~400 |
| Modified tests (director, config, integration) | 3 (modified) | +100 |
| **Total** | **15 files** | **~885 lines** |

### Risk items

- **Agent SDK as subprocess:** The SDK spawns a subprocess internally. Tests must mock at the `query()` import level to avoid actual subprocess creation. If mocking proves brittle, we may need a thin adapter interface.
- **Structured output reliability:** If the Coder fails to produce valid JSON matching the schema, the SDK returns `error_max_structured_output_retries`. The result-parser handles this gracefully (P3-P5), but the Director's Step 7 loop also needs to handle it as a retry-able failure.
- **Cost tracking accuracy:** `total_cost_usd` from `SDKResultMessage` should be reliable. If it's `0` or missing for bypass-permission runs, we log a warning and continue.

### Deliberately excluded

- **Session resume within a phase** — each Coder call is a fresh `query()`. Resume is a Phase 2 concern.
- **Parallel Coder sessions** — spec mentions this as a Director capability but it's not in Phase 1 acceptance criteria.
- **AbortController / cancellation** — not wired in Phase 1. The Coder runs to completion or hits maxTurns/maxBudget.
- **Step 3 Coder call** — listed in R9 as a stretch goal. If it complicates the Director flow significantly, we keep the Phase 0 approach (context-only) and defer to Phase 2. Decision at implementation time.
