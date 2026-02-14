# cestdone

AI-orchestrated development CLI. A Director AI plans, a Coder AI implements, and the human approves.

## Why

The bottleneck in AI-assisted development is the human sitting between the AI planner and the AI coder. **cestdone** removes that bottleneck by having a Director AI orchestrate a Coder AI, with the human intervening only at approval gates.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI Orchestrator (TypeScript)                                       │
│  src/cli/index.ts → src/director/director.ts                        │
│                                                                      │
│  Controls the 8-step workflow. All logic is in TypeScript —          │
│  the AIs are called per-step via Agent SDK query().                  │
└──────────┬────────────────────────────┬──────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────┐     ┌─────────────────────────┐
│  DIRECTOR AI        │     │  CODER AI               │
│                     │     │                          │
│  Agent SDK query()  │     │  Agent SDK query()       │
│  Read, Glob, Grep   │     │  Read, Write, Edit,      │
│  + Bash (review)    │     │  MultiEdit, Bash,        │
│                     │     │  Glob, Grep              │
│  Returns JSON:      │     │                          │
│  { action, message, │     │  Returns JSON:           │
│    questions? }     │     │  { status, summary,      │
│                     │     │    filesChanged?,         │
│  Can read code,     │     │    testsRun?, issues? }  │
│  run tests,         │     │                          │
│  explore codebase   │     │  Can edit code, run      │
│  CANNOT edit files  │     │  commands, run tests     │
└─────────────────────┘     └─────────────────────────┘
```

Both agents use `@anthropic-ai/claude-agent-sdk` with `outputFormat` for structured JSON responses. Each call is a fresh `query()` session — no message accumulation across steps.

## Workflow

```
Human writes spec.md
       │
       ▼
 ┌─ 1. ANALYZE ──────────────────────────────────────────────┐
 │  Director reads spec + explores codebase (Read/Glob/Grep) │
 │  Lists clarifying questions or says "ready to proceed"     │
 └────────────────────────────┬───────────────────────────────┘
                              │
              ┌───── questions? ─────┐
              │ yes                  │ no
              ▼                      │
 ┌─ 2. CLARIFY ──────────┐          │
 │  Human answers each    │          │
 │  question via CLI      │          │
 └───────────┬────────────┘          │
             │                       │
             ▼                       │
 ┌─ 3. UPDATE SPEC ──────┐          │
 │  Director drafts text  │          │
 │  Orchestrator writes   │          │
 │  to spec.md            │          │
 └───────────┬────────────┘          │
             │                       │
             ◄───────────────────────┘
             │
             ▼
 ┌─ 4. PLAN ─────────────────────────────────────────────────┐
 │  Director reads codebase, produces numbered task list      │
 │  Includes file paths, TDD sequence, TODO checklist         │
 └────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
 ┌─ 5. APPROVE ──────────────────────────────────────────────┐
 │  Human reviews plan: approve or reject with feedback       │
 │  On rejection → Director revises (max 3, then escalate)    │
 └────────────────────────────┬───────────────────────────────┘
                              │ approved
                              ▼
 ┌─ 6. EXECUTE ──────────────────────────────────────────────┐
 │  Coder implements current sub-phase (~15-25 turns)         │
 │  Full tools: edit, bash, etc.                              │
 │  Returns: status, summary, files changed, test results     │
 └────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
 ┌─ 7. REVIEW (always runs) ───────────────────────────────────┐
 │  Director reads files, runs tests via Bash, verifies work   │
 │                                                              │
 │  → "done"     All verified → git commit → Step 8             │
 │  → "continue" Sub-phase OK → git commit → back to 6         │
 │               (with next sub-phase instructions)             │
 │  → "fix"      Issues found → NO commit → back to 6          │
 │               with fix instructions (max 3, then human)      │
 └──────────────────────────┬──────────────────────────────────┘
                             │ done
                             ▼
 ┌─ 8. COMPLETE ─────────────────────────────────────────────┐
 │  Director writes Done summary to spec.md                   │
 │  Phase status: done                                        │
 └────────────────────────────────────────────────────────────┘
```

## Example Session

Given this spec file:

```markdown
# My App

## Context
A Node.js REST API with Express and PostgreSQL.

## House rules
See `house-rules.md`

## Phase 0: User auth endpoint
### Status: pending
### Spec
Add POST /api/auth/login with JWT tokens. Use bcrypt for passwords.
### Done
_(to be filled)_
```

Here's what happens when you run `npx cestdone run --spec spec.md --target ./my-app`:

```
── Step 1: Analyze ──────────────────────────────────────────
Director explores my-app/ with Read/Glob/Grep, reads spec.

  Director → { action: "ask_human", message: "Two questions",
               questions: ["Where should JWT secret come from?",
                           "Token expiry duration?"] }

── Step 2: Clarify ──────────────────────────────────────────
  Director asks: Where should JWT secret come from?
  Your answer: JWT_SECRET env var

  Director asks: Token expiry duration?
  Your answer: 24h

── Step 3: Update Spec ──────────────────────────────────────
Director drafts updated spec text. Orchestrator writes it to spec.md.
Spec now includes: "JWT_SECRET from env, 24h expiry."

── Step 4: Plan ─────────────────────────────────────────────
Director reads codebase, produces plan with sub-phases:

  === Director's Plan ===
  Sub-phase A: Auth middleware + login
    1. Create src/middleware/auth.ts — JWT verify middleware
    2. Create src/routes/auth.ts — POST /api/auth/login
    3. TDD: tests/auth.test.ts for login

  Sub-phase B: Registration
    4. Add POST /api/auth/register to src/routes/auth.ts
    5. TDD: tests/auth.test.ts for register
    6. Update src/app.ts to mount /api/auth routes
  ======================

── Step 5: Approve ──────────────────────────────────────────
  Approve? (y/n): y

── Step 6: Execute (Sub-phase A) ────────────────────────────
Coder implements auth middleware + login with TDD.

  Coder: Created JWT middleware and login endpoint. 5 tests pass.
         (cost: $0.30)

── Step 7: Review ───────────────────────────────────────────
Director reads files, runs npm test, verifies Sub-phase A.

  Director runs: git add -A && git commit -m "cestdone: auth middleware + login"

  Director → { action: "continue",
               message: "Sub-phase A verified. Now implement
               Sub-phase B: registration endpoint..." }

  Sub-phase 1 complete. Continuing...

── Step 6: Execute (Sub-phase B) ────────────────────────────
Coder implements registration, building on existing auth code.
Receives context: "Previously completed: JWT middleware + login"

  Coder: Added register endpoint. 8 tests pass. (cost: $0.25)

── Step 7: Review ───────────────────────────────────────────
Director verifies all work, runs full test suite.

  Director runs: git add -A && git commit -m "cestdone: registration endpoint"

  Director → { action: "done", message: "All verified." }

  Total Coder cost: $0.55

── Step 8: Complete ─────────────────────────────────────────
Director writes Done summary to spec.md. Phase status → done.

  Phase 0 status: done
  Done: Added POST /api/auth/login and /register with JWT (24h,
  env-based secret), bcrypt passwords, 8 passing tests.
```

**Error handling:** If the Coder fails at Step 6, the Director:
1. Reviews the code and runs tests via Bash
2. Returns `fix` with specific instructions → Coder retries
3. After 3 failures, escalates to human for guidance
4. Retry count resets when moving to a new sub-phase

## Git Integration

**Initialization:** On first run, cestdone ensures the target repo has git initialized with a `.gitignore` (excludes `node_modules/`, `dist/`, `.env`, etc.). Existing repos and `.gitignore` files are left untouched.

**Commits by the Director:** The Director is responsible for committing verified work during the Review step. Each commit is a clean checkpoint:
- Tests pass + types check → `git add -A && git commit` → respond `continue` or `done`
- Tests fail or issues found → **no commit** → respond `fix`

This means every commit represents verified, working code. If a sub-phase fails after a commit, the previous commit serves as a safe rollback point.

## Tool Restrictions

Each agent gets only the tools it needs per step:

| Step | Agent | Tools |
|------|-------|-------|
| Analyze | Director | Read, Glob, Grep |
| Clarify | Director | Read, Glob, Grep |
| UpdateSpec | Director | Read, Glob, Grep (orchestrator writes spec) |
| Plan | Director | Read, Glob, Grep |
| Execute | Coder | Read, Write, Edit, MultiEdit, Bash, Glob, Grep |
| Review | Director | Read, Glob, Grep, **Bash** |
| Complete | Director | Read, Glob, Grep |

Tools are enforced via the `tools` parameter in Agent SDK `query()`, which physically restricts available tools in the session.

## Structured Output

Both agents return typed JSON via `outputFormat`:

**Director** returns `DirectorResponse`:
```json
{ "action": "approve | ask_human | fix | continue | done | escalate",
  "message": "plan text, instructions, or next sub-phase",
  "questions": ["only with ask_human"] }
```

Actions: `approve` (plan/analysis OK), `ask_human` (needs input), `fix` (Coder retry), `continue` (sub-phase done, next instructions in message), `done` (all complete), `escalate` (stuck).

**Coder** returns `CoderReport`:
```json
{ "status": "success | partial | failed",
  "summary": "what was done",
  "filesChanged": ["src/auth.ts"],
  "testsRun": { "passed": 8, "failed": 0, "skipped": 0 },
  "issues": ["optional list of problems"] }
```

## Spec File Format

```markdown
# Project Name

## Context
Tech stack, constraints, what this project is.

## House rules
See `house-rules.md` (or inline rules)

## Phase 0: First thing to build
### Status: pending | in-progress | done
### Spec
Requirements (high-level, not code).
### Done
_(filled by Director when phase completes)_

## Phase 1: Next thing
...
```

Status transitions: `pending` → `in-progress` → `done`. When done, the Spec section is replaced with a summary of what was built.

## Installation & Usage

```bash
npm install
```

Set your API key in a `.env` file (Node 22+ loads it via `--env-file`):
```
ANTHROPIC_API_KEY=sk-ant-...
```

Run a spec:
```bash
npx tsx --env-file=.env src/cli/index.ts run --spec ./my-spec.md --target /path/to/repo
```

Resume from last incomplete phase:
```bash
npx tsx --env-file=.env src/cli/index.ts resume --spec ./my-spec.md --target /path/to/repo
```

### Configuration

Optional `.cestdonerc.json` in the target repo:
```json
{
  "defaultModel": "claude-opus-4-20250514",
  "maxTurns": 100,
  "maxBudgetUsd": 5.0,
  "logLevel": "info"
}
```

## Project Structure

```
src/
├── cli/
│   ├── index.ts          # CLI entry point (run, resume commands)
│   └── prompt.ts         # Terminal interaction (askApproval, askInput)
├── director/
│   ├── director.ts       # 8-step workflow orchestrator
│   ├── prompts.ts        # All prompt templates + response schema
│   └── model-selector.ts # Opus vs Sonnet per step
├── coder/
│   ├── coder.ts          # Agent SDK wrapper for Coder
│   ├── coder-prompt.ts   # Coder prompt assembly
│   ├── permissions.ts    # Tool restrictions per step
│   └── result-parser.ts  # Parse Agent SDK results
└── shared/
    ├── types.ts          # All TypeScript types
    ├── config.ts         # .cestdonerc.json loading
    ├── git.ts            # Git repo init + .gitignore
    ├── spec-parser.ts    # Markdown spec parsing
    ├── spec-writer.ts    # Atomic spec file updates
    └── logger.ts         # Pino file logging
```

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (both Director and Coder)
- **Tests:** Vitest (142 tests across 15 files)
- **Logging:** Pino with file rotation
- **CLI:** Commander

## What's Been Built (Phases 0–1 + Revamp)

- Full 8-step Director workflow with human approval gates
- Agent SDK integration for both Director (read-only) and Coder (full tools)
- Structured JSON output for both agents
- Per-step tool restrictions enforced via `tools` parameter
- Spec file parsing, status tracking, and atomic updates
- Execute→Review loop with sub-phase iteration (continue/done/fix)
- Sub-phase chunking: Director breaks large plans into ~15-25 turn chunks
- Retry with escalation (max 3 retries per sub-phase, then human)
- Plan approval with rejection feedback loop (max 3 rejections)
- Cost tracking and accumulation across retries
- Git initialization with `.gitignore` on first run
- Director-owned commits on verified sub-phases (no commit on failure)
- CLI with `run` and `resume` commands
- File-based logging with rotation

## Planned Phases

### Phase 2: Git Integration + Session Resilience
- Commit with descriptive message after human approval
- Branch-per-phase strategy (`cestdone/phase-N`)
- Resume capability from any interruption point

### Phase 3: Visual Verification
- Playwright screenshots of running web apps
- Director uses Claude vision to verify UI
- Visual feedback loop for CSS/layout issues

### Phase 4: Notifications + Async Approval
- Email notifications via SendGrid when approval needed
- Webhook endpoint for approve/reject via email links
- Timeout handling with reminders

### Phase 5: Cron + Marketing Automation
- Scheduled recurring workflows
- Reddit monitoring, blog generation, SEO analysis
- State persistence across runs via SQLite
