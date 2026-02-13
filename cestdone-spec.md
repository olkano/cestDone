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
- When the Director asks to "show the diff," Coder runs `git diff` (or `git diff --cached` if staged) and includes the output. Never substitute prose for actual diff output.
- When the Director asks to commit, Coder runs: `git add -A`, then `git diff --cached --stat` (for Director review), then commits with the provided message. Coder does NOT push unless explicitly told.
- After any file modifications, Coder reports: files changed (list), lines added/removed (from diff stat), and any warnings from linters or tests.

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

### Status: pending

### Spec

Set up the project structure and implement the core Director loop — the part that reads a spec, plans phases, and communicates with a human operator (no Agent SDK yet, the human relays to Claude Code manually).

**Deliverables:**
- Project init: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Source structure: `src/cli/`, `src/director/`, `src/coder/`, `src/shared/`
- CLI entry point with `run` and `resume` commands (use `commander`)
- Spec parser: reads a spec MD file, extracts phases with status/spec/done sections
- Director module: takes a parsed spec, calls Claude API to create a phase plan
- Human interaction: CLI stdin prompts for approval/rejection/input
- Config: `.cestdonerc.json` for API key, default model, target repo path
- Tests: spec parser unit tests, director prompt construction tests

**What this phase does NOT include:**
- Agent SDK integration (Phase 1)
- Git operations (Phase 2)
- Screenshots/vision (Phase 3)
- Notifications (Phase 4)

**Acceptance criteria:**
- `npx cestdone run --spec ./example-spec.md` reads the spec, sends to Claude API, prints the Director's plan, prompts human for approval
- Spec parser correctly handles all status values and multi-phase files
- All tests pass: `npm run test`
- `npx tsc` clean
- Windows stdin works correctly (Node `readline` with explicit Windows testing)

**Clarifications:**

_Parser:_
- Enforce `## Phase N:` (H2) and `### Status/Spec/Done` (H3) exactly — no tolerance for malformed input. Error clearly and exit.
- Phase numbering: integers starting from 0, sequential. Gaps are valid (e.g., Phase 0, Phase 2). Non-numeric = parse error.
- Parser extracts `## Context` and `## House rules` as structured metadata, passed to Director alongside phase data.
- Multiple-spec files: parser looks for the LAST `# H1 heading` as start of the actual spec. Everything above is documentation.
- House rules path resolved relative to `--target`. If file doesn't exist, warn and continue (not required).

_Spec lifecycle:_
- When a phase completes, BOTH `### Spec` and `### Done` headings stay. Spec content is cleared to `_See Done summary below._` and Done is populated. Status is the source of truth.

_Director:_
- Prompt construction: Director receives (a) Context + House rules sections, (b) Done summaries of completed phases (concise), (c) Full spec of current phase. NOT the full file — focused prompt assembly to manage context window.
- Multi-turn conversation within a phase (each step appends to message history). New phase = new conversation.
- Implement `selectModel(step, complexity)` now. Even if Phase 0 only calls API for planning, the plumbing must exist.
- Use `tool_use` with structured response schema for Director intent. Natural language for plan content, but structured envelope: `action: "approve" | "ask_human" | "fix" | "complete"`.

_Phase 0 workflow scope:_
- Implements Steps 1–5 (up to plan approval) and Step 8 (status update).
- Steps 6–7 (execute/review) print "Coder integration not yet available — manual execution required" and wait for human to confirm completion.
- After approval: update spec status to `done` and stop.

_CLI:_
- `run` starts from the first `pending` phase. If a phase is `in-progress`, prompt: "Phase N is in-progress. Reset to pending or continue?"
- `resume` continues from the first non-`done` phase without prompting.
- On rejection: prompt for feedback text, Director re-plans. Three rejections in a row → escalate to human with "I'm stuck, here's what I've tried."
- Non-TTY: error with clear message in Phase 0.

_Config:_
- `ANTHROPIC_API_KEY` from env var ONLY. Never store API keys in config files.
- `.cestdonerc.json` holds: default model, target repo path, log level. CWD only, no hierarchical lookup.
- Config default model is fallback only. Director's per-step selection wins.

_Testing:_
- Mock the Anthropic SDK. Test prompt construction and response parsing, not the API itself.

### Done
_(to be filled by Director when phase completes)_

## Phase 1: Agent SDK integration (Coder)

### Status: pending

### Spec

Connect the Director to a real Coder via the Claude Agent SDK. The Director sends instructions, the Coder executes them in the target repo, and reports back results.

**Deliverables:**
- Coder module: wraps Agent SDK `query()` calls with proper tool permissions
- Director→Coder flow: Director formulates instructions, Coder executes, results stream back
- Session management: new Agent SDK session per phase, context tracking
- House-rules injection: Coder receives house-rules.md content at session start
- Result parsing: extract structured info from Coder's output (files changed, test results, questions)
- Human approval gate: after Coder reports, Director summarizes and asks human to approve
- Spec.md updater: Director writes `### Done` summaries and updates phase status

**Acceptance criteria:**
- Full loop works: Director reads spec → instructs Coder → Coder works on target repo → Director reviews → human approves → spec.md updated
- Coder respects house-rules (TDD, logging, tests pass)
- Session isolation: each phase starts fresh
- All tests pass

### Done
_(to be filled)_

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
