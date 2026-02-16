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
│  Two-flow architecture: planning + phase execution.                 │
│  Director: continuous session (resume). Coder: fresh per phase.     │
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

Both agents use `@anthropic-ai/claude-agent-sdk` with `outputFormat` for structured JSON responses.

**Session strategy:**
- **Director**: Single continuous session per process run. The first `query()` call creates the session; all subsequent calls pass `resume: sessionId` to continue the conversation. The Director remembers what it read, what clarifications were given, and what each Coder phase reported — no redundant re-exploration.
- **Coder**: Fresh `query()` session per phase. Clean context prevents cross-phase pollution.

## Workflow

There are two flows: **Planning** (once per spec) and **Phase Execution** (once per phase).

### Planning Flow

```
Human writes free-form spec.md + optional house-rules.md
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
             ◄───────────────────────┘
             │
             ▼
 ┌─ 3. CREATE PLAN ──────────────────────────────────────────┐
 │  Director creates structured .plan.md with phases          │
 │  Human approves or rejects with feedback (max 3 rejections)│
 └────────────────────────────┬───────────────────────────────┘
                              │ approved
                              ▼
                    .plan.md written to disk
                    (source of truth for tracking)
```

### Phase Execution (per phase)

```
 ┌─ EXECUTE ─────────────────────────────────────────────────┐
 │  Coder receives phase spec + plan context (tech stack,     │
 │  project context, completed phases) and implements directly │
 │  Full tools: edit, bash, etc.                              │
 │  Returns: status, summary, files changed, test results     │
 └────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
 ┌─ REVIEW (always runs) ───────────────────────────────────────┐
 │  Director reads files, runs tests via Bash, verifies work    │
 │                                                               │
 │  → "done"     All verified → git commit → COMPLETE            │
 │  → "continue" Current work OK → git commit → back to EXECUTE  │
 │               (with next instructions from Director)           │
 │  → "fix"      Issues found → NO commit → back to EXECUTE     │
 │               with fix instructions (max 3, then human)       │
 └──────────────────────────┬───────────────────────────────────┘
                             │ done
                             ▼
 ┌─ COMPLETE ────────────────────────────────────────────────┐
 │  Director writes Done summary to .plan.md                  │
 │  Phase status: done                                        │
 └────────────────────────────────────────────────────────────┘
```

## Example Session

Given this spec file (`spec.md`):

```
Add POST /api/auth/login with JWT tokens. Use bcrypt for passwords.
```

And a house rules file, here's what happens when you run:

```bash
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app --house-rules house-rules.md
```

```
── Planning: Analyze ───────────────────────────────────────
Director explores my-app/ with Read/Glob/Grep, reads spec.

  Director → { action: "ask_human",
               questions: ["Where should JWT secret come from?",
                           "Token expiry duration?"] }

── Planning: Clarify ───────────────────────────────────────
  Director asks: Where should JWT secret come from?
  Your answer: JWT_SECRET env var

  Director asks: Token expiry duration?
  Your answer: 24h

── Planning: Create Plan ───────────────────────────────────
Director creates structured plan with phases.

  === Director's Plan ===
  # Plan: My App Auth
  ## Phase 1: Auth middleware + login
  ### Spec
  Create JWT middleware and POST /api/auth/login...
  ## Phase 2: Registration
  ### Spec
  Add POST /api/auth/register...
  ======================

  Approve? (y/n): y

Plan written to spec.plan.md

── Phase 1: Execute ────────────────────────────────────────
Coder receives phase spec + plan context and implements directly.

  Coder: Created JWT middleware and login endpoint. 5 tests pass.
         (cost: $0.30)

── Phase 1: Review ─────────────────────────────────────────
Director reads files, runs npm test, verifies work.

  Director runs: git add -A && git commit -m "cestdone: auth middleware + login"

  Director → { action: "done", message: "All verified." }

── Phase 1: Complete ───────────────────────────────────────
Director writes Done summary to spec.plan.md. Phase status → done.

── Phase 2: Execute ────────────────────────────────────────
Coder implements registration, building on existing auth code.

  Coder: Added register endpoint. 8 tests pass. (cost: $0.25)

── Phase 2: Review ─────────────────────────────────────────
Director verifies all work, runs full test suite.

  Director runs: git add -A && git commit -m "cestdone: registration endpoint"

  Director → { action: "done", message: "All verified." }

  Total Coder cost: $0.55

── Phase 2: Complete ───────────────────────────────────────
All phases done.
```

**Error handling:** If the Coder produces broken code, the Director:
1. Reviews the code and runs tests via Bash
2. Returns `fix` with specific instructions → Coder retries
3. After 3 failures, escalates to human for guidance
4. Retry count resets when Director sends new instructions via `continue`

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
| CreatePlan | Director | Read, Glob, Grep |
| Execute | Coder | Read, Write, Edit, MultiEdit, Bash, Glob, Grep |
| Review | Director | Read, Glob, Grep, **Bash** |
| Complete | Director | Read, Glob, Grep |

Tools are enforced via the `tools` parameter in Agent SDK `query()`, which physically restricts available tools in the session.

## Structured Output

Both agents return typed JSON via `outputFormat`:

**Director** returns `DirectorResponse`:
```json
{ "action": "approve | ask_human | fix | continue | done | escalate",
  "message": "plan text, review result, or next instructions",
  "questions": ["only with ask_human"] }
```

Actions: `approve` (plan/analysis OK), `ask_human` (needs input), `fix` (Coder retry), `continue` (current work OK, next instructions in message), `done` (all complete), `escalate` (stuck).

**Coder** returns `CoderReport`:
```json
{ "status": "success | partial | failed",
  "summary": "what was done",
  "filesChanged": ["src/auth.ts"],
  "testsRun": { "passed": 8, "failed": 0, "skipped": 0 },
  "issues": ["optional list of problems"] }
```

## Spec File Format

The spec is **free-form text** — just describe what you want built:

```markdown
Build a REST API with user authentication and a dashboard.
Use Express, PostgreSQL, and JWT tokens.
```

The Director creates a structured `.plan.md` file from this spec during the planning flow. The plan file follows this format and is the source of truth for tracking:

```markdown
# Plan: Project Name

## Context
Description derived from spec + Q&A.

## Tech Stack
Extracted/decided technologies.

## House Rules
Rules that apply to this project.

## Phase 1: First thing to build
### Status: pending | in-progress | done
### Spec
Detailed phase specification.
### Applicable Rules
Only the house rules relevant to this phase.
### Done
_(filled by Director when phase completes)_
```

Status transitions: `pending` → `in-progress` → `done`. The original spec file is never modified.

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
npx tsx --env-file=.env src/cli/index.ts run --spec ./my-spec.md --target /path/to/repo --house-rules house-rules.md
```

Resume all remaining phases (requires existing `.plan.md`):
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
│   ├── director.ts       # Planning + phase execution orchestrator
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
    ├── plan-parser.ts    # .plan.md parsing (getPlanPath, parsePlan)
    ├── spec-writer.ts    # Atomic plan file updates
    ├── cost-tracker.ts   # Per-session cost accumulation
    └── logger.ts         # Pino file logging
```

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` (both Director and Coder)
- **Tests:** Vitest (191 tests across 16 files)
- **Logging:** Pino with file rotation
- **CLI:** Commander

## What's Been Built

- Two-flow architecture: planning flow (spec → .plan.md) + phase execution (execute → review → complete)
- Automatic sequential execution of all phases after plan approval (no human intervention needed)
- Free-form spec input with optional house rules
- Agent SDK integration for both Director (read-only) and Coder (full tools)
- Director session resumption — single continuous conversation across planning + all phases (eliminates redundant file reads)
- Structured JSON output for both agents
- Per-step tool restrictions enforced via `tools` parameter
- Plan file parsing, status tracking, and atomic updates
- Execute→Review loop with iteration (continue/done/fix)
- Coder receives phase spec + plan context directly (no intermediate sub-planning)
- Retry with escalation (max 3 retries, then human)
- Plan approval with rejection feedback loop (max 3 rejections, then escalate)
- Cost tracking and accumulation across retries
- Git initialization with `.gitignore` on first run
- Director-owned commits on verified work (no commit on failure)
- CLI with `run` and `resume` commands
- File-based logging with rotation

## Planned Phases

### Phase 2: Git Branch Strategy
- Branch-per-phase strategy (`cestdone/phase-N`)

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
