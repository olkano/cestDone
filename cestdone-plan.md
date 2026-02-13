# Phase 0 Implementation Plan

**Status:** approved
**Created:** 2026-02-13
**Phase:** 0 — Project scaffold + Director loop

This file is the Coder's contract. If this chat dies and we resume in a new session, the Coder reads this file and picks up where it left off.

---

## 1. File Structure

**Config files (4 files)**

| File | Purpose |
|---|---|
| `package.json` | Project manifest, bin entry for `npx cestdone`, scripts |
| `tsconfig.json` | TypeScript strict config, ESM output |
| `vitest.config.ts` | Vitest config with src alias |
| `.gitignore` | node_modules, dist, .env, *.tsbuildinfo |

**Source files (11 files)**

| File | Purpose |
|---|---|
| `src/shared/types.ts` | All shared types: `Phase`, `ParsedSpec`, `Config`, `DirectorAction`, step enums |
| `src/shared/logger.ts` | Pino logger singleton, respects config log level |
| `src/shared/config.ts` | Loads `.cestdonerc.json` from CWD + `ANTHROPIC_API_KEY` from env |
| `src/shared/spec-parser.ts` | Parses spec MD → `ParsedSpec` with phases, context, house-rules metadata |
| `src/shared/spec-writer.ts` | Atomic writes to spec MD: status transitions, Done summaries |
| `src/director/model-selector.ts` | `selectModel(step, complexity)` → model ID string |
| `src/director/prompt-builder.ts` | Assembles Claude API messages from parsed spec + conversation history |
| `src/director/director.ts` | Workflow orchestration: Steps 1-5 + 8, multi-turn message history, API calls |
| `src/coder/coder.ts` | Stub interface: logs "manual execution required", returns a no-op result |
| `src/cli/prompt.ts` | Readline-based human prompts: approve/reject/input, TTY check, Windows-safe |
| `src/cli/index.ts` | Commander setup: `run` and `resume` commands, wires everything together |

**Test files (7 files + 3 fixtures)**

| File | Purpose |
|---|---|
| `tests/spec-parser.test.ts` | Parser: valid/multi-phase/malformed specs, metadata extraction, H1 detection |
| `tests/spec-writer.test.ts` | Status updates, Done summary writing, atomic write behavior |
| `tests/config.test.ts` | Config loading, defaults, env var handling, missing file |
| `tests/model-selector.test.ts` | Model selection per step/complexity |
| `tests/prompt-builder.test.ts` | Prompt assembly, context inclusion, tool_use schema |
| `tests/director.test.ts` | Workflow steps with mocked Anthropic SDK, rejection counting, escalation |
| `tests/prompt.test.ts` | Approval flow, rejection with feedback, non-TTY error |
| `tests/fixtures/valid-spec.md` | Well-formed single-phase spec |
| `tests/fixtures/multi-phase-spec.md` | Multiple phases in various states (pending/in-progress/done) |
| `tests/fixtures/malformed-spec.md` | Bad phase numbering, missing sections |

**Total: 25 files**

---

## 2. Dependency List

```
dependencies:
  @anthropic-ai/sdk    ^0.39.0   — Claude API client (core requirement)
  commander            ^13.0.0   — CLI framework (spec mandates it)
  pino                 ^9.6.0    — Structured logging (house-rules mandate)

devDependencies:
  typescript           ^5.7.0    — Language
  vitest               ^3.0.0    — Test framework (house-rules mandate)
  @types/node          ^22.0.0   — Node type definitions
  pino-pretty          ^13.0.0   — Dev-only readable log output
```

**Justifications for non-obvious:**
- **pino-pretty** — dev-only log formatter. Without it, pino outputs JSON which is unreadable during development. Zero production cost.
- That's it. No markdown parser (regex is sufficient for strict format), no extra file utils (Node `fs` + rename for atomic writes), no readline wrapper (Node built-in).

---

## 3. TDD Sequence

### Module A: `shared/types.ts`

No tests. Pure type definitions: `Phase`, `PhaseStatus`, `ParsedSpec`, `SpecMetadata`, `Config`, `DirectorAction` (the `tool_use` envelope), `WorkflowStep` enum.

### Module B: `shared/config.ts`

| # | Red (test) | Green (code) | Refactor |
|---|---|---|---|
| B1 | Loads `.cestdonerc.json` from CWD, returns typed config | Read file, JSON.parse, return with defaults | — |
| B2 | Returns defaults when no `.cestdonerc.json` exists | Catch ENOENT, return default config | — |
| B3 | Reads `ANTHROPIC_API_KEY` from `process.env` | Add env lookup, throw if missing | — |
| B4 | Throws clear error when API key missing | Assert error message | Already done in B3 |

### Module C: `shared/logger.ts`

No dedicated tests. Thin wrapper: `pino({ level: config.logLevel })`. Tested implicitly.

### Module D: `shared/spec-parser.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| D1 | Parses single phase: extracts name, status, spec content, done content | Regex-based H2/H3 parsing | — |
| D2 | Parses multi-phase spec with pending/in-progress/done statuses | Loop over phase blocks | — |
| D3 | Extracts `## Context` and `## House rules` as metadata | Add metadata extraction before phase parsing | — |
| D4 | Handles "last H1 heading" — ignores docs above the actual spec | Find last `# ` heading, parse only below it | — |
| D5 | Throws on malformed input: missing `### Status`, bad phase number, non-numeric | Add validation with descriptive error messages | Extract validation into helper |
| D6 | Handles gaps in phase numbering (Phase 0, Phase 2 — no Phase 1) | Don't enforce sequential, just integer check | — |
| D7 | Resolves house-rules path relative to target dir; warns if missing | Path resolution + fs.existsSync check | — |

### Module E: `shared/spec-writer.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| E1 | Updates phase status (`pending` → `in-progress`) in spec file | String replacement in file content | — |
| E2 | Writes Done summary: clears Spec content to placeholder, populates Done | Replace content between headings | — |
| E3 | Write is atomic: uses temp file + rename | `writeFileSync` to `.tmp`, `renameSync` | — |
| E4 | Preserves rest of file untouched when updating one phase | Assertion on unchanged sections | Already covered |

### Module F: `director/model-selector.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| F1 | Steps 1, 4 → Opus always | Switch on step | — |
| F2 | Steps 2, 3, 5 → Sonnet if `complexity=low`, Opus if `high` | Add complexity param | — |
| F3 | Step 6 → Opus for `full`, Sonnet for `fix` | Extend switch | — |
| F4 | Steps 7, 8 → Opus always | Extend switch | Collapse into clean lookup |

### Module G: `director/prompt-builder.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| G1 | Builds Step 1 (Analyze) prompt: includes context, house-rules, current phase spec | Assemble system + user messages | — |
| G2 | Includes Done summaries of completed phases (not full spec) | Filter phases, extract summaries | — |
| G3 | Defines `tool_use` tool schema for action envelope: `{action, message, questions?}` | Return tools array with JSON schema | — |
| G4 | Builds Step 4 (Plan) prompt differently from Step 1 | Step-specific prompt templates | Extract shared assembly logic |
| G5 | Builds Step 8 (Complete) prompt with phase summary request | Add complete template | — |

### Module H: `cli/prompt.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| H1 | `askApproval()` returns `'approve'` or `'reject'` based on input | Readline interface, parse y/n | — |
| H2 | On rejection, prompts for feedback text and returns it | Chain readline question | — |
| H3 | Throws clear error on non-TTY (`!process.stdin.isTTY`) | Check before creating readline | — |
| H4 | `askInput(question)` — generic text prompt for Director escalations | Reuse readline pattern | Extract shared readline helper |

### Module I: `coder/coder.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| I1 | `execute()` logs "manual execution required" and returns stub result | Logger call, return `{ status: 'manual', message: '...' }` | — |

### Module J: `director/director.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| J1 | Step 1: sends Analyze prompt via mocked SDK, returns Coder's questions | Call API with prompt-builder output, parse response | — |
| J2 | Step 2: Director answers questions it can, escalates rest to human | Parse questions, call `askInput` for unknowns | — |
| J3 | Step 3: Calls spec-writer to update spec with clarifications | Invoke spec-writer | — |
| J4 | Step 4: Sends Plan prompt, receives implementation plan | API call with Step 4 prompt | — |
| J5 | Step 5: Presents plan to human, handles approve/reject | Call `askApproval`, branch on result | — |
| J6 | Steps 6-7: Prints "manual execution required", waits for human confirmation | Call coder stub, call `askInput("confirm when done")` | — |
| J7 | Step 8: Updates spec status to `done`, writes Done summary | Call spec-writer | — |
| J8 | Rejection counter: 3 rejections → escalates with "I'm stuck" summary | Increment counter, format escalation message | — |
| J9 | Multi-turn: message history accumulates across steps within a phase | Assert messages array grows | Already in J1-J7 |

### Module K: `cli/index.ts`

| # | Red | Green | Refactor |
|---|---|---|---|
| K1 | `run` command: parses args, finds first `pending` phase, starts Director | Commander setup, wire modules | — |
| K2 | `run` with in-progress phase: prompts "reset or continue?" | Detect in-progress, call prompt | — |
| K3 | `resume` command: finds first non-`done` phase, starts without prompting | Filter phases, start Director | — |

---

## 4. TODO Checklist (Implementation Order)

This is the contract. Executed in this exact order:

```
 1. [ ] Project scaffold: package.json, tsconfig.json, vitest.config.ts, .gitignore
 2. [ ] Install dependencies (npm install)
 3. [ ] Create src/ directory structure (empty files with POSIX path comments)
 4. [ ] shared/types.ts — all type definitions
 5. [ ] shared/config.ts — TDD: B1 red→green, B2 red→green, B3 red→green, B4 red→green
 6. [ ] shared/logger.ts — pino setup (no dedicated tests)
 7. [ ] shared/spec-parser.ts — TDD: D1 red→green, D2 red→green, ... D7 red→green + fixtures
 8. [ ] shared/spec-writer.ts — TDD: E1 red→green, E2 red→green, E3 red→green, E4 red→green
 9. [ ] director/model-selector.ts — TDD: F1 red→green, F2 red→green, F3 red→green, F4 red→green
10. [ ] director/prompt-builder.ts — TDD: G1 red→green, G2 red→green, ... G5 red→green
11. [ ] cli/prompt.ts — TDD: H1 red→green, H2 red→green, H3 red→green, H4 red→green
12. [ ] coder/coder.ts — TDD: I1 red→green
13. [ ] director/director.ts — TDD: J1 red→green, J2 red→green, ... J9 red→green
14. [ ] cli/index.ts — TDD: K1 red→green, K2 red→green, K3 red→green
15. [ ] Integration smoke test: npx cestdone run --spec ./tests/fixtures/valid-spec.md
16. [ ] npx tsc — zero errors
17. [ ] npm run test — all pass
18. [ ] Review for dead code, unused imports, clean up
```

Steps 1-3 are scaffold (one commit checkpoint). Steps 4-12 are bottom-up unit-tested modules. Steps 13-14 are the orchestration layer. Steps 15-18 are the acceptance gate.

---

## 5. Estimated Scope

| Category | Files | Lines (approx) |
|---|---|---|
| Config files | 4 | ~80 |
| Type definitions | 1 | ~80 |
| Shared modules (config, logger, parser, writer) | 4 | ~400 |
| Director modules (selector, prompt-builder, director) | 3 | ~350 |
| Coder stub | 1 | ~25 |
| CLI modules (prompt, index) | 2 | ~180 |
| Tests | 7 | ~650 |
| Fixtures | 3 | ~100 |
| **Total** | **25** | **~1,865** |

**Overengineering flags:**
- **None identified.** Everything maps directly to a spec requirement or TODO.md item. The model-selector feels premature (Phase 0 only calls one model), but the spec explicitly says "the plumbing must exist." The atomic spec writer is called out in TODO.md as high-priority. The coder stub is intentionally minimal.
- **Risk item:** The Director module (J1-J9) is the most complex single file (~200 lines). If it grows beyond ~250, I'll split the step handlers into a separate file. But I won't pre-split — Uncle Bob says extract when you need to.
- **Deliberately excluded:** No `src/index.ts` barrel export file. No abstract base classes. No dependency injection container. No event system. Those are Phase 1+ concerns if needed at all.
