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
 │  Coder writes to disk  │          │
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
 │  Coder implements the plan (full tools: edit, bash, etc.)  │
 │  Returns: status, summary, files changed, test results     │
 └────────────────────────────┬───────────────────────────────┘
                              │
                 ┌─── success? ───┐
                 │ no             │ yes
                 ▼                │
 ┌─ 7. REVIEW ──────────┐       │
 │  Director reads files,│       │
 │  runs tests via Bash, │       │
 │  sends fix instruct-  │       │
 │  ions → back to 6     │       │
 │  (max 3, then human)  │       │
 └───────────────────────┘       │
                                 │
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
Director drafts updated spec text. Coder writes it to spec.md.
Spec now includes: "JWT_SECRET from env, 24h expiry."

── Step 4: Plan ─────────────────────────────────────────────
Director reads codebase, produces plan:

  === Director's Plan ===
  1. Create src/middleware/auth.ts — JWT verify middleware
  2. Create src/routes/auth.ts — POST /api/auth/login
  3. Add tests: tests/auth.test.ts (TDD: write tests first)
  4. Update src/app.ts to mount /api/auth routes
  ======================

── Step 5: Approve ──────────────────────────────────────────
  Approve? (y/n): n
  Feedback: Also add a /register endpoint

Director revises plan, adds registration. Human approves.

── Step 6: Execute ──────────────────────────────────────────
Coder implements with full tools (edit, bash, etc.)

  Coder: Created auth module with login+register. 8 tests pass.
         (cost: $0.45)

── Step 7: Review (skipped — Coder reported success) ────────

── Step 8: Complete ─────────────────────────────────────────
Director writes Done summary to spec.md. Phase status → done.

  Phase 0 status: done
  Done: Added POST /api/auth/login and /register with JWT (24h,
  env-based secret), bcrypt passwords, 8 passing tests.
```

If the Coder had failed at Step 6 (e.g., tests failing), the Director would:
1. Read the changed files and run `npm test` via Bash (Review step)
2. Send fix instructions back to the Coder
3. Retry up to 3 times, then ask the human for guidance

## Tool Restrictions

Each agent gets only the tools it needs per step:

| Step | Agent | Tools |
|------|-------|-------|
| Analyze | Director | Read, Glob, Grep |
| Clarify | Director | Read, Glob, Grep |
| UpdateSpec (Director) | Director | Read, Glob, Grep |
| UpdateSpec (Coder) | Coder | Read, Write, Edit, Glob, Grep |
| Plan | Director | Read, Glob, Grep |
| Execute | Coder | Read, Write, Edit, MultiEdit, Bash, Glob, Grep |
| Review | Director | Read, Glob, Grep, **Bash** |
| Complete | Director | Read, Glob, Grep |

Tools are enforced via the `tools` parameter in Agent SDK `query()`, which physically restricts available tools in the session.

## Structured Output

Both agents return typed JSON via `outputFormat`:

**Director** returns `DirectorResponse`:
```json
{ "action": "approve | ask_human | fix | done | ...",
  "message": "plan text or instructions",
  "questions": ["only with ask_human"] }
```

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

Set your API key:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Run a spec:
```bash
npx cestdone run --spec ./my-spec.md --target /path/to/repo
```

Resume from last incomplete phase:
```bash
npx cestdone resume --spec ./my-spec.md --target /path/to/repo
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
    ├── spec-parser.ts    # Markdown spec parsing
    ├── spec-writer.ts    # Atomic spec file updates
    └── logger.ts         # Pino file logging
```

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (both Director and Coder)
- **Tests:** Vitest (124 tests across 14 files)
- **Logging:** Pino with file rotation
- **CLI:** Commander

## What's Been Built (Phases 0–1 + Revamp)

- Full 8-step Director workflow with human approval gates
- Agent SDK integration for both Director (read-only) and Coder (full tools)
- Structured JSON output for both agents
- Per-step tool restrictions enforced via `tools` parameter
- Spec file parsing, status tracking, and atomic updates
- Execute→Review retry loop with escalation (max 3 retries)
- Plan approval with rejection feedback loop (max 3 rejections)
- Cost tracking and accumulation across retries
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
