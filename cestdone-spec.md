# cestdone — AI-Orchestrated Development & Automation CLI

## Why

The bottleneck in AI-assisted development is the human sitting between the AI planner and the AI coder. You read the plan, copy instructions, wait for code, review, then relay back. **cestdone** removes that bottleneck by having a Director AI orchestrate a Coder AI, with the human intervening only at approval gates.

The same architecture extends beyond coding to any repeatable workflow: content creation, SEO monitoring, social engagement — anything where an AI can plan, execute, verify, and ask for human approval at the right moments.

## How it works

```
Human writes spec.md
        │
        ▼
┌──────────────────────┐
│  DIRECTOR            │   Claude API (Opus for phases, Sonnet for tweaks)
│  Reads spec + state  │   Has: vision, web search, planning ability
│  Creates phase plan  │   Cannot: edit files, run commands
│  Reviews results     │
│  Picks model/phase   │
└──────────┬───────────┘
           │  instructions (natural language)
           ▼
┌──────────────────────┐
│  CODER               │   Claude Agent SDK
│  Implements plan     │   Has: bash, file read/write/edit, git, test runner
│  Runs tests          │   Follows: house-rules.md
│  Takes screenshots   │   Reports: results, errors, screenshots
│  Reports back        │
└──────────┬───────────┘
           │  results + artifacts
           ▼
┌──────────────────────┐
│  DIRECTOR            │
│  Reviews output      │──→  If issues: sends fix instructions back to Coder
│  Updates spec.md     │──→  If done: requests human approval
│  Decides next step   │──→  If approved: commits, starts next phase
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  HUMAN               │
│  Approves/rejects    │   Via: CLI prompt (MVP), email (later)
│  Provides input when │   Only intervenes at gates or when Director
│  Director is stuck   │   explicitly asks
└──────────────────────┘
```

## Tech stack

- **Runtime:** Node.js + TypeScript
- **Test framework:** Vitest
- **Director:** Anthropic Messages API (`@anthropic-ai/sdk`)
- **Coder:** Claude Agent SDK (`claude-agent-sdk` / `@anthropic-ai/claude-agent-sdk`)
- **Model selection:** Director decides per iteration. Default: Opus for full phases and planning, Sonnet for minor follow-ups
- **State:** Markdown files in the target repo (this file + `cestdone-state.md` for run logs)
- **Notifications (future):** SendGrid API
- **Visual verification (future):** Playwright screenshots → Director vision analysis

## CLI interface

```bash
# Run a spec against a target repo
npx cestdone run --spec ./project-spec.md --target /path/to/repo

# Resume from where we left off (reads state from spec.md)
npx cestdone resume --spec ./project-spec.md --target /path/to/repo

# Run a single phase
npx cestdone run --spec ./project-spec.md --target /path/to/repo --phase 2
```

## Spec file format

Every project using cestdone provides a spec MD with this structure:

```markdown
# Project Name

## Context
What the project is, tech stack, key constraints.

## House rules
Path to house-rules.md or inline rules the Coder must follow.

## Phase 1: [Name]
### Status: pending | in-progress | done
### Spec
What needs to be built (high-level, not code).
### Done
_(Replaced by Director when phase completes: brief summary, file references, decisions made)_

## Phase 2: [Name]
...
```

**Rules for spec.md updates:**
- When a phase completes, Director replaces `### Spec` content with a concise `### Done` summary
- Summary includes: what was built, key files changed, any spec deviations and why
- Keep summaries under 10 lines — reference code/docs for details, don't duplicate
- Status transitions: `pending` → `in-progress` → `done`
- If implementation changed the spec, note the deviation in `### Done`

## Session management

Each phase runs in a fresh Agent SDK session to prevent context fill-up:

1. Director reads spec.md (full file, all phases including done summaries)
2. Director identifies the next `pending` phase
3. Director executes the **Director workflow protocol** (Steps 1–8) for the phase — analysis, clarification, planning, then execution — using fresh Agent SDK sessions as needed
4. When satisfied, Director updates spec.md, requests human approval to commit
5. On approval: git commit + push, session ends
6. Loop to step 1 for next phase

**Context budget rule:** If a Coder session exceeds ~80% of context window, Director should wrap up, commit progress, and continue in a new session. Partial progress is noted in spec.md.

**Coder permissions model:** Each workflow step restricts the Coder's capabilities via Agent SDK `allowedTools`. Plan-only steps (1, 4) grant read-only tools (file read, glob, grep). Auto-edit steps (3, 6) grant the full toolset (bash, file read/write/edit, git). The Director configures `allowedTools` per step to enforce this — the Coder cannot escalate its own permissions.

**Commit rule:** The Coder never commits autonomously. See Git and commit protocol.

**State persistence rule:** All decisions, plans, and progress must be persisted to files — never rely on conversation context alone. Before ending any Coder session, the Director ensures:
- Active implementation plans are saved to `cestdone-plan.md` (overwritten per phase)
- Decisions and clarifications are in `cestdone-spec.md` (the clarifications subsection)
- Progress is reflected in phase status and TODO.md

Before starting a new session, the Director's prompt includes all needed context assembled from these files. A session can be killed at any time without losing meaningful work.

**Parallel sessions:** The Director may run multiple Coder sessions when tasks are independent (e.g., one session updates docs while another fixes a test). Each session receives only the context it needs. Parallel sessions must NOT edit the same files. The Director is responsible for avoiding conflicts.

## Director-Coder protocol

The Director sends instructions to the Coder as structured natural language:

```
PHASE: 2 — API endpoint for user preferences
MODEL: opus
HOUSE_RULES: ./house-rules.md
CONTEXT: Phase 1 completed the user model (see src/models/user.ts).

TASK:
1. First, review the existing code in src/models/ and src/routes/ to understand patterns.
2. Propose a plan for implementing GET/PUT /api/users/:id/preferences.
3. After I approve the plan, implement using TDD per house-rules.
4. Run all tests (unit + integration) and report results.
5. Update Swagger docs.

REPORT BACK:
- Plan before coding
- Test results (pass/fail counts)
- Files changed
- Any questions or spec ambiguities
```

The Coder reports back:

```
PLAN:
- Will add PreferencesService in src/services/preferences.ts
- New route in src/routes/users.ts
- Schema: { theme, language, notifications: { email, push } }
- Question: should preferences be stored in the users table or separate?

READY TO PROCEED: waiting for plan approval
```

Director reviews, answers questions, approves or modifies the plan, then tells Coder to proceed.

**Reporting rules:**
- After modifications, Coder writes the diff to `cestdone-diff.txt` in the repo root: `git --no-pager diff > cestdone-diff.txt`. Always use relative path — the file lives in the repo root. The Director reads this file to review changes. This file is ephemeral — it's overwritten on every report cycle and is in `.gitignore`.
- For very large diffs (>500 lines), Coder writes `git diff --stat` to `cestdone-diff.txt` first and asks the Director which files to show in full.
- Coder also reports: test results (raw output from test runner), `tsc --noEmit` output, and a list of files changed.
- When the Director asks to commit, Coder runs: `git add -A`, then `git diff --cached --stat` (for Director review), then commits with the provided message. Coder does NOT push unless explicitly told.

## Director workflow protocol

The Director follows this sequence for every phase:

**Step 1 — Analyze** (Coder in plan-only mode)
Director sends the phase spec to Coder with instructions: "Read the phase spec, the house-rules, and the relevant existing code. Do NOT touch any files. List any clarifying questions about requirements, ambiguities, or assumptions you'd need resolved before implementing."

**Step 2 — Clarify**
Director reviews Coder's questions. For questions the Director can answer from context (previous phases, spec, general architecture knowledge), it answers directly. For questions requiring human judgment, Director escalates to the human with a clear summary.

**Step 3 — Update spec**
Director asks Coder (auto-edit mode) to update the phase spec in cestdone-spec.md incorporating the clarifications. This ensures the spec is always the source of truth, not conversation context.

**Step 4 — Plan** (Coder in plan-only mode)
Director asks Coder: "Now make an implementation plan observing house-rules.md. Include: file structure, TDD sequence (which tests first), and a TODO checklist. Do NOT write code yet."

**Step 5 — Approve plan**
Director reviews the plan. May request changes. When satisfied, tells Coder to proceed. If the plan is complex or the Director is uncertain, escalates to human for review.

**Step 6 — Execute** (Coder in auto-edit mode)
Director tells Coder: "Approved. Implement the plan following house-rules.md. Use TDD. Run all tests. Report back with: files changed, test results (pass/fail counts), and any issues encountered."

**Step 7 — Review**
Director reviews Coder's report. If tests fail or output seems wrong, sends fix instructions. May request screenshots for visual verification (Phase 3+). Loops back to Step 6 until satisfied.

**Step 8 — Complete**
Director updates cestdone-spec.md: sets phase status to done, replaces spec content with a concise Done summary. Requests human approval to commit.

**Model selection per step:**

| Step | Mode | Model |
|------|------|-------|
| Steps 1, 4 | Analysis/planning | Always Opus |
| Steps 2, 3, 5 | Clarification/spec updates | Sonnet if straightforward, Opus if complex |
| Step 6 | Execution | Opus for full phases, Sonnet for small fixes |
| Steps 7, 8 | Review/completion | Opus |

## Git and commit protocol

The Coder NEVER commits on its own initiative. All commits go through the Director.

**Rules:**
- Coder works on a working branch, never on main
- Coder does NOT commit, push, or create branches unless explicitly told by Director
- Director requests a commit only at Step 8 (Complete) of the workflow protocol, after reviewing the work
- Director proposes a commit message following the format: `cestdone: Phase N — [phase name]: [brief summary]`
- Human approves or modifies the commit message before it executes
- If a phase is interrupted mid-work (context budget hit), Director tells Coder to save all progress to files (no commit), notes the interruption in spec.md, and resumes in a new session

**Commit timing:**
- Step 8 commits are mandatory (phase completion)
- Steps 2-3 (spec clarification updates) should also be committed if the changes are substantial, to avoid losing decisions. Director decides. Commit message: `cestdone: Phase N — spec update: [brief description]`
- Never let more than ~30 minutes of meaningful work go uncommitted

**Branch strategy (MVP):**
- `main` — stable, only receives approved commits
- `cestdone/phase-N` — working branch per phase, created by Director at Step 6
- On approval: squash-merge into main, delete working branch

## House rules integration

The target repo's `house-rules.md` is passed to the Coder at the start of every session. The Director does NOT send code-level instructions that conflict with house rules. The Coder owns the code; the Director owns the plan.

**Division of responsibility:**
- **Director decides:** what to build, in what order, acceptance criteria, whether to proceed or fix
- **Coder decides:** how to implement, code structure, test strategy, tool usage
- **Human decides:** approval to commit, architectural questions the Director escalates

---

# Cestdone — Self-Build Spec

The first project built with cestdone is... cestdone itself. Below are the phases.

## Context

- Repo: `cestdone/` (new repo, TypeScript + Node.js)
- Test framework: Vitest
- Package manager: npm
- Target: CLI tool, publishable to npm
- Auth: `ANTHROPIC_API_KEY` env var

## House rules

See `house-rules.md` in repo root (copy from ITM Platform house-rules, adapted for this project).

## Phase 0: Project scaffold + Director loop

### Status: done

### Spec
_See Done summary below._

### Done
- Project scaffold complete: `package.json`, `tsconfig.json`, `vitest.config.ts`, source structure (`src/cli/`, `src/director/`, `src/coder/`, `src/shared/`)
- Director loop implements Steps 1–5 + Step 8: Analyze → Clarify → (context-only spec update) → Plan → Approve (with 3-rejection escalation) → Complete
- Steps 6–7 print "Coder integration not yet available — manual execution required" and wait for human confirmation
- CLI entry point with `run` (first pending phase, prompts on in-progress) and `resume` (first non-done phase, no prompt) commands via Commander
- 66 tests across 11 test files, all passing. Covers: spec parser, config, prompt builder, model selector, Director orchestration, spec writer, coder stub, CLI wiring, logger, and integration smoke tests
- File-based logging via pino + pino-roll (2 MB rotation, 3 files, debug-level traces of every API call and human interaction)
- Env config: `CESTDONE_CLAUDE_API_KEY ?? ANTHROPIC_API_KEY`, loaded via `--env-file=.env`
- Live acceptance test confirmed: CLI reads spec, calls Claude API, prints Director plan, prompts for approval, updates spec status — full wiring verified on Windows
- Known UX items deferred to medium priority: limit Director questions to 3 max, allow skip/empty-Enter in Step 2

## Phase 1: Agent SDK integration (Coder)

### Status: done

### Spec
_See Done summary below._

### Done
- Coder module wraps Agent SDK V1 `query()` async generator with per-step tool permissions, structured JSON output, and house-rules injection via `systemPrompt.append`
- Director Steps 6-7 rewritten: execute→review loop with fix instructions from Director API, max 3 retries with human escalation, cost accumulation and display
- Step 3 now calls Coder with spec-editing permissions after clarifications (instead of context-only note)
- Result parser extracts `structured_output` from SDK result messages, with JSON text fallback and raw text partial status
- Permission model: `bypassPermissions` + `allowDangerouslySkipPermissions`, with `allowedTools` varying per workflow step (read-only for analyze/plan, spec-edit for step 3, full edit+bash for execute)
- CLI wiring updated: `buildDeps()` connects `executeCoder` directly, config threads `maxTurns`/`maxBudgetUsd` through to Coder
- Integration test mocks both `@anthropic-ai/sdk` (Director) and `@anthropic-ai/claude-agent-sdk` (Coder), verifies full Director→Coder→Director flow and correct `allowedTools`
- 115 tests across 14 test files, all passing. Key new test files: `coder.test.ts` (15 tests), `permissions.test.ts` (8), `coder-prompt.test.ts` (7), `result-parser.test.ts` (8). Director tests expanded from 10 to 18
- Key files: `src/coder/coder.ts`, `src/coder/permissions.ts`, `src/coder/coder-prompt.ts`, `src/coder/result-parser.ts`, `src/director/director.ts`, `src/cli/index.ts`

## Phase 2: Git integration + session resilience

### Status: pending

### Spec

Add git commit/push on approval and make the system resumable from any point.

**Deliverables:**
- Git operations: commit with descriptive message after human approval, optional push
- Resume capability: `cestdone resume` reads spec.md status fields, skips done phases
- Partial progress: if a session is interrupted, state is preserved in spec.md
- Commit message format: `cestdone: Phase N — [phase name] [summary]`

**Acceptance criteria:**
- After approval, changes are committed with proper message
- `cestdone resume` correctly picks up from the last incomplete phase
- Interrupted sessions can be resumed without data loss

### Done
_(to be filled)_

## Phase 3: Visual verification

### Status: pending

### Spec

Add Playwright screenshot capability so the Director can visually verify what the Coder built.

**Deliverables:**
- Screenshot tool: Coder can take Playwright screenshots of URLs
- Vision review: Director receives screenshots as base64, uses Claude vision to analyze
- Comparison: Director can compare screenshot against a reference image or description
- Feedback loop: if visual issues found, Director sends fix instructions to Coder

**Acceptance criteria:**
- Coder can screenshot a running web app
- Director can see and reason about the screenshot
- Visual feedback loop works end-to-end

### Done
_(to be filled)_

## Phase 4: Notifications + async approval

### Status: pending

### Spec

Replace CLI prompts with email notifications for async workflows.

**Deliverables:**
- SendGrid integration: email human when approval needed
- Email contains: summary of what was done, approve/reject links
- Approval webhook: simple Express endpoint that receives approve/reject
- Polling mode: cestdone waits for approval response

**Acceptance criteria:**
- Human receives email with clear summary
- Approval/rejection works via email link
- Timeout handling: reminds after N hours, gives up after N days

### Done
_(to be filled)_

## Phase 5: Cron + marketing automation

### Status: pending

### Spec

Add scheduled task support for recurring workflows (editorial calendar, Reddit monitoring, SEO analysis).

**Deliverables:**
- Cron scheduler: `node-cron` based task runner
- Task definitions: YAML/JSON config for recurring jobs
- State persistence: SQLite for tracking what's been done across runs
- Reddit search: web search for relevant threads, suggest replies
- Blog generation: create posts based on editorial plan
- Google Search Console: API integration for weekly analysis

**Acceptance criteria:**
- Cron runs tasks on schedule
- Each run reads previous state and avoids duplicating work
- Human approval required before any public posting

### Done
_(to be filled)_
