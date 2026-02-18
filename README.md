# cestdone

AI-orchestrated development CLI. A Director AI plans and executes — or delegates to a Coder AI for two-agent mode.

## Why

The bottleneck in AI-assisted development is the human sitting between the AI planner and the AI coder. **cestdone** removes that bottleneck by having a Director AI orchestrate the entire workflow, with the human intervening only when explicitly opted in.

## Architecture

cestdone supports two execution modes:

**Director-only mode** (default) — the Director plans and executes everything directly:

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI Orchestrator (TypeScript)                                       │
│  src/cli/index.ts → src/director/director.ts                        │
│                                                                      │
│  Two-flow architecture: planning + phase execution.                 │
│  Director: continuous session (resume) across all steps.            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  DIRECTOR AI        │
                    │                     │
                    │  Agent SDK query()  │
                    │                     │
                    │  Planning:          │
                    │  Read, Glob, Grep   │
                    │                     │
                    │  Execution:         │
                    │  Read, Write, Edit, │
                    │  MultiEdit, Bash,   │
                    │  Glob, Grep         │
                    │                     │
                    │  Returns JSON:      │
                    │  { action, message, │
                    │    questions? }     │
                    └─────────────────────┘
```

**Two-agent mode** (`--with-coder`) — the Director plans and reviews, a separate Coder implements:

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI Orchestrator (TypeScript)                                       │
│  src/cli/index.ts → src/director/director.ts                        │
│                                                                      │
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
- **Director**: Single continuous session per process run. The first `query()` call creates the session; all subsequent calls pass `resume: sessionId` to continue the conversation. The Director remembers what it read, what clarifications were given, and what each phase reported — no redundant re-exploration.
- **Coder** (two-agent mode only): Fresh `query()` session per phase. Clean context prevents cross-phase pollution.

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
 │  With --with-human-validation:                             │
 │    Human approves or rejects (max 3 rejections)            │
 │  Without (default):                                        │
 │    Plan auto-approved after format validation              │
 └────────────────────────────┬───────────────────────────────┘
                              │ approved
                              ▼
                    .plan.md written to disk
                    (source of truth for tracking)
```

### Phase Execution (per phase)

**Director-only mode** (default):

```
 ┌─ EXECUTE ─────────────────────────────────────────────────┐
 │  Director implements the phase directly using full tools    │
 │  (Read, Write, Edit, MultiEdit, Bash, Glob, Grep)          │
 │  Returns: done action with summary                         │
 └────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
 ┌─ COMPLETE ────────────────────────────────────────────────┐
 │  Director writes Done summary to .plan.md                  │
 │  Phase status: done                                        │
 └────────────────────────────────────────────────────────────┘
```

**Two-agent mode** (`--with-coder`):

```
 ┌─ EXECUTE ─────────────────────────────────────────────────┐
 │  Coder receives phase spec + plan context (tech stack,     │
 │  project context, completed phases) and implements directly │
 │  Full tools: edit, bash, etc.                              │
 │  Returns: status, summary, files changed, test results     │
 └────────────────────────────┬───────────────────────────────┘
                              │
                    ┌─── --with-reviews? ───┐
                    │ yes                   │ no
                    ▼                       │
 ┌─ REVIEW ───────────────────────────────┐ │
 │  Director reads files, verifies work   │ │
 │  With --with-bash-reviews: runs tests  │ │
 │  Without: read-only review             │ │
 │                                         │ │
 │  → "done"     → COMPLETE               │ │
 │  → "continue" → back to EXECUTE        │ │
 │  → "fix"      → back to EXECUTE        │ │
 │    (max 3, then escalate to human)     │ │
 └─────────────┬───────────────────────────┘ │
               │                             │
               ◄─────────────────────────────┘
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

### Director-only (default)

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
Plan auto-approved. Written to spec.plan.md.

── Phase 1: Execute (Director) ─────────────────────────────
Director implements the phase directly with full tools.

  Director → { action: "done", message: "Created JWT middleware
               and POST /api/auth/login. 5 tests pass." }

── Phase 1: Complete ───────────────────────────────────────
Phase status → done.

── Phase 2: Execute (Director) ─────────────────────────────
Director implements registration, building on existing auth code.

  Director → { action: "done", message: "Added register endpoint.
               8 tests pass." }

── Phase 2: Complete ───────────────────────────────────────
All phases done.
```

### Two-agent mode with all bells and whistles

```bash
npx tsx --env-file=.env src/cli/index.ts run \
  --spec spec.md --target ./my-app --house-rules house-rules.md \
  --with-coder --with-reviews --with-bash-reviews --with-human-validation
```

```
── Planning: Analyze ───────────────────────────────────────
Director explores my-app/ with Read/Glob/Grep, reads spec.
(same clarification flow as above)

── Planning: Create Plan ───────────────────────────────────
  === Director's Plan ===
  # Plan: My App Auth
  ## Phase 1: Auth middleware + login
  ## Phase 2: Registration
  ======================

  Approve? (y/n): y                ← only with --with-human-validation

── Phase 1: Execute (Coder) ────────────────────────────────
Coder implements the phase.

  Coder: Created JWT middleware. 5 tests pass. (cost: $0.30)

── Phase 1: Review ─────────────────────────────────────────
Director reads files, runs npm test (Bash enabled via --with-bash-reviews).

  Director → { action: "done", message: "All verified." }

── Phase 1: Complete ───────────────────────────────────────
Phase status → done.

── Phase 2: Execute (Coder) ────────────────────────────────
  Coder: Added register endpoint. 8 tests pass. (cost: $0.25)

── Phase 2: Review + Complete ──────────────────────────────
All phases done. Total Coder cost: $0.55
```

**Error handling** (two-agent mode with reviews): If the Coder produces broken code, the Director:
1. Reviews the code and identifies issues (runs tests if `--with-bash-reviews`)
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
| Execute (director-only) | Director | Read, Write, Edit, MultiEdit, Bash, Glob, Grep |
| Execute (two-agent) | Coder | Read, Write, Edit, MultiEdit, Bash, Glob, Grep |
| Review (`--with-bash-reviews`) | Director | Read, Glob, Grep, **Bash** |
| Review (read-only) | Director | Read, Glob, Grep |
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

### Authentication

cestdone uses the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk), which requires `ANTHROPIC_API_KEY` in the environment. The SDK reads it automatically — cestdone does not manage the key itself.

Set it in a `.env` file (Node 22+ loads it via `--env-file`):
```
ANTHROPIC_API_KEY=sk-ant-...
```

> **Note:** The Agent SDK requires an API key. Claude Max/Pro subscriptions cannot be used — Anthropic explicitly prohibits third-party tools from using subscription-based authentication. API billing is separate from your Claude subscription.

### Commands

**Run** — create a plan from a spec and execute all phases:
```bash
npx tsx --env-file=.env src/cli/index.ts run --spec ./my-spec.md --target /path/to/repo
```

**Resume** — continue execution from an existing `.plan.md`:
```bash
npx tsx --env-file=.env src/cli/index.ts resume --spec ./my-spec.md --target /path/to/repo
```

### CLI Flags

Both `run` and `resume` accept these flags:

| Flag | Description | Default |
|------|-------------|---------|
| `--spec <path>` | Path to spec file (required) | — |
| `--target <path>` | Target repository path | `.cestdonerc.json` value or `.` |
| `--house-rules <path>` | Path to house rules file (`run` only) | none |
| `--director-model <model>` | Director model: `haiku`, `sonnet`, `opus`, or full ID | `sonnet` |
| `--coder-model <model>` | Coder model: `haiku`, `sonnet`, `opus`, or full ID | `haiku` |
| `--with-coder` | Enable two-agent mode (Director + Coder) | off (director-only) |
| `--with-reviews` | Enable Director reviews after Coder execution | off |
| `--with-bash-reviews` | Enable Bash in Director reviews (implies `--with-reviews`) | off (read-only review) |
| `--with-human-validation` | Require human approval of plan before execution | off (auto-approve) |

**Flag implications:**
- `--with-bash-reviews` automatically enables `--with-reviews`
- `--with-reviews` without `--with-coder` is invalid (warns and disables reviews)

**Examples:**

```bash
# Cheapest: Director-only, no reviews, no approval
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app

# Full two-agent mode with all safety gates
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app \
  --with-coder --with-reviews --with-bash-reviews --with-human-validation \
  --house-rules house-rules.md

# Two-agent without reviews (Coder runs, straight to complete)
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app \
  --with-coder

# Override models
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app \
  --director-model opus --coder-model sonnet --with-coder
```

### Model Selection

Models are resolved in this order: CLI flag → environment variable → default.

| Role | CLI flag | Env var | Default |
|------|----------|---------|---------|
| Director | `--director-model` | `CESTDONE_DIRECTOR_MODEL` | `sonnet` (claude-sonnet-4) |
| Coder | `--coder-model` | `CESTDONE_CODER_MODEL` | `haiku` (claude-haiku-4.5) |

Aliases `haiku`, `sonnet`, and `opus` resolve to full model IDs. You can also pass a full model ID directly (e.g., `claude-opus-4-20250514`).

### Configuration

Optional `.cestdonerc.json` in the target repo:
```json
{
  "defaultModel": "claude-opus-4-20250514",
  "maxTurns": 100,
  "maxBudgetUsd": 5.0,
  "directorModel": "sonnet",
  "coderModel": "haiku",
  "withCoder": false,
  "withReviews": false,
  "withBashReviews": false,
  "withHumanValidation": false
}
```

CLI flags override `.cestdonerc.json` values.

## Project Structure

```
src/
├── cli/
│   ├── index.ts          # CLI entry point (run, resume commands)
│   └── prompt.ts         # Terminal interaction (askApproval, askInput)
├── director/
│   ├── director.ts       # Planning + phase execution orchestrator
│   ├── prompts.ts        # All prompt templates + response schema
│   └── model-selector.ts # Model alias resolution + selection
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
- **Tests:** Vitest (256 tests across 17 files)
- **Logging:** Pino with file rotation
- **CLI:** Commander

## What's Been Built

- Two execution modes: director-only (default, cheaper) and two-agent (`--with-coder`)
- Two-flow architecture: planning flow (spec → .plan.md) + phase execution
- Configurable execution pipeline via CLI flags (`--with-reviews`, `--with-bash-reviews`, `--with-human-validation`)
- Model alias resolution (`haiku`/`sonnet`/`opus`) with CLI override → env var → default fallback
- Automatic sequential execution of all phases (no human intervention by default)
- Free-form spec input with optional house rules
- Agent SDK integration with structured JSON output for both agents
- Director session resumption — single continuous conversation across planning + all phases
- Per-step tool restrictions enforced via `tools` parameter
- Plan file parsing, status tracking, and atomic updates
- Execute→Review loop with iteration (continue/done/fix) in two-agent mode
- Retry with escalation (max 3 retries, then human)
- Optional plan approval with rejection feedback loop (max 3 rejections, then escalate)
- Cost tracking and accumulation across retries
- Git initialization with `.gitignore` on first run
- Director-owned commits on verified work (no commit on failure)
- CLI with `run` and `resume` commands, `--help`, and error-on-invalid-flag
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
