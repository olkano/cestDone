# cestDone

AI-orchestrated development CLI. Write a plain-text spec, and cestDone turns it into working code — planning, implementing, reviewing, and committing autonomously.

## Why

The bottleneck in AI-assisted development isn't the AI — it's the human sitting between the planner and the worker. You paste context, copy instructions, re-explain what was already decided, and babysit every step.

**cestDone removes that bottleneck.** A Director AI reads your spec, explores the codebase, creates a phased plan, and either implements it directly or delegates to a Worker AI. The human intervenes only when explicitly opted in.

There's a second, subtler problem: **context window exhaustion.** When you drive an AI agent manually through a large project, the conversation fills up — the model forgets earlier decisions, loses track of files, and quality degrades. cestDone sidesteps this by keeping the Director thin — it orchestrates via markdown files and never does deep code analysis itself. Workers get fresh sessions per task with only the relevant context. All handoffs happen through `.plan.md` and `.cestdone/reports/` files, so nothing is lost and everything is traceable.

## How It Works

```
spec.md ──► DIRECTOR                                        .plan.md
             │                                                  │
             └─ Planning Worker ──────────────────────────────► │
                (explores codebase, writes .plan.md)            │
                                                                │
             For each phase:                                    │
             ┌──────────────────────────────────────────────┐   │
             │                                              │   │
             │  WORKER (fresh session per phase)             │   │
             │  ├─ Reads phase spec from plan               │   │
             │  ├─ Implements: edit files, run tests        │   │
             │  └─ Writes report to .cestdone/reports/       │   │
             │         │                                    │   │
             │         ▼                                    │   │
             │  DIRECTOR (review)                           │   │
             │  ├─ Reads report + code diff                 │   │
             │  ├─ fix ──► retry Worker (max 3, then human)  │   │
             │  ├─ continue ──► Worker keeps going           │   │
             │  └─ done ──► commit, update plan ───────────►│   │
             │                                              │   │
             └──────────────────────────────────────────────┘   │
```

**Planning** (once per spec):
1. **Planning Worker** — A Worker explores the codebase and writes a structured `.plan.md` with numbered phases
2. **Validation** — The plan format is validated; if invalid, a revision Worker fixes it
3. **Approval** — If `--with-human-validation`, the plan is shown for approval before execution

**Execution** (per phase):
1. **Execute** — Worker implements the phase (or the Director, in director-only mode)
2. **Review** — Director reads the Worker's report and code diff to verify
3. **Complete** — Director updates `.plan.md`, commits verified work, moves to next phase

### File-Based Communication

The Director and Workers communicate exclusively through markdown files in `.cestdone/reports/`:

```
.cestdone/reports/
  phase-0-prompt.md      ← Planning Worker's prompt (what the Director asked)
  phase-1-prompt.md      ← Phase 1 Worker's instructions
  phase-1-report.md      ← Phase 1 Worker's report (status, summary, files changed)
  phase-2-prompt.md      ← Phase 2 Worker's instructions
  phase-2-report.md      ← Phase 2 Worker's report
  ...
```

Additionally:
- `spec.plan.md` — the plan file (written by Planning Worker, read by Director)
- `.cestdone/cestdone-diff.txt` — git diff of changes (written by Worker, read by Director during review)

This gives full traceability of every Director↔Worker interaction. You can inspect these files to understand exactly what was asked and what was delivered.

### Two Modes

- **Two-agent mode** (default): Director delegates planning and implementation to Workers. The Director is a thin orchestrator — it never reads code directly, only reviews through report files and diffs.
- **Director-only mode** (`--no-with-worker`): The Director does everything. Simpler, but the Director's context carries more weight.

### Two Backends

- **Claude CLI** (default): Spawns `claude -p` under the hood. Uses your Claude Max or Pro subscription — no API key, no per-token billing. Authenticate with `claude auth login`.
- **Agent SDK** (`--backend agent-sdk`): Uses `@anthropic-ai/claude-agent-sdk` with per-token API billing. Requires `ANTHROPIC_API_KEY` in the environment.

You can mix backends per agent (e.g., Director on CLI, Worker on API) with `--director-backend` and `--worker-backend`.

## Quick Start

### Install globally

```bash
# From the cestdone repo
npm install
npm run build
npm link
```

This creates a global `cestdone` command you can call from anywhere. On Windows, it's case-insensitive (`cestDone`, `CESTDONE`, etc. all work).

After code changes, run `npm run build` to update the global command.

### Usage

Write a spec file:

```
Add POST /api/auth/login with JWT tokens. Use bcrypt for passwords.
Include tests.
```

Run it from the target project directory:

```bash
cd ~/Code/my-app
cestdone run --spec ~/specs/auth.md

# Or specify the target explicitly
cestdone run --spec spec.md --target ./my-app

# Execute an already-structured operational spec without generating a plan
cestdone run --spec recurring-job.md --target ./my-app --skip-planning
```

With Agent SDK backend (requires `ANTHROPIC_API_KEY`):

```bash
cestdone run --spec spec.md --target ./my-app --backend agent-sdk
```

Resume a partially completed plan:

```bash
cestdone resume --spec spec.md --target ./my-app
```

## CLI Reference

```
Usage: cestdone [commands]

Commands:
  run [options]        Execute a spec, with a generated plan by default
  resume [options]     Resume execution from an existing .plan.md file
  daemon [options]     Start daemon with schedules and triggers from .cestdonerc.json
  daemon status        Show daemon status
  daemon stop          Stop running daemon
  send-email           Send an email (used by Worker agent via Bash)
```

### `run` options

```
  --spec <path>              Path to spec file (required)
  --house-rules <path>       Path to house rules file
  --skip-planning            Execute the complete specification as one Worker task without creating a plan
  --target <path>            Target repository path (default: ".")
  --application <name>       Logical application label for usage accounting
  --director-model <model>   Director model: haiku | sonnet | opus (default: "opus")
  --worker-model <model>      Worker model: haiku | sonnet | opus (default: "opus")
  --with-worker               Two-agent mode: Director plans, Worker implements (default: true)
  --no-with-worker            Disable two-agent mode (director-only)
  --with-reviews             Director reviews after Worker execution (default: true)
  --no-with-reviews          Disable Director reviews
  --with-bash-reviews        Allow Bash in reviews, implies --with-reviews (default: true)
  --no-with-bash-reviews     Disable Bash in reviews
  --with-human-validation    Require human approval of plan (default: false)
  --non-interactive          Run without TTY — auto-approves plans, skips clarifications (default: false)
  --backend <type>           Backend for both agents: agent-sdk | claude-cli (default: "claude-cli")
  --director-backend <type>  Override Director backend: agent-sdk | claude-cli
  --worker-backend <type>     Override Worker backend: agent-sdk | claude-cli
  --claude-cli-path <path>   Path to claude binary (default: "claude")
```

`resume` accepts all the same options except `--house-rules`.

### Examples

```bash
# Default: two-agent mode, reviews enabled, Claude CLI backend
cestdone run --spec spec.md --target ./my-app

# Director-only mode (no Worker)
cestdone run --spec spec.md --target ./my-app --no-with-worker

# Require human approval of the plan before execution
cestdone run --spec spec.md --target ./my-app --with-human-validation

# Non-interactive (CI/CD, scripts, daemon — no TTY required)
cestdone run --spec spec.md --target ./my-app --non-interactive

# Structured recurring job: one Worker call and at most one Director review
cestdone run --spec recurring-job.md --target ./my-app --skip-planning

# Use API backend with custom models
cestdone run --spec spec.md --target ./my-app \
  --backend agent-sdk --director-model sonnet --worker-model haiku

# Repository agent rules as the worker instruction file
cestdone run --spec spec.md --target ./my-app --house-rules AGENTS.md
```

## Configuration

Optional `.cestdonerc.json` in the target repo. CLI flags take precedence.

```json
{
  "targetRepoPath": ".",
  "maxTurns": 100,
  "directorModel": "opus",
  "workerModel": "opus",
  "withWorker": true,
  "withReviews": true,
  "withBashReviews": true,
  "withHumanValidation": false,
  "skipPlanning": false,
  "nonInteractive": false,
  "autoCommit": true,
  "application": "my-app",
  "houseRules": "AGENTS.md",
  "directorBackend": "claude-cli",
  "workerBackend": "claude-cli",
  "claudeCliPath": "claude"
}
```

Model aliases `haiku`, `sonnet`, and `opus` resolve to full model IDs. You can also pass a full ID directly (e.g., `claude-sonnet-5`).

### Usage accounting

cestDone writes a versioned structured record for every run under
`~/.cestdone/usage/runs/YYYY/MM/`. The record is updated after each completed model
call, so usage already consumed remains available when a later call or the overall
run fails. Weekly analytical reports are saved under
`~/.cestdone/usage/reports/weekly/` and the configured daemon runs the report every
Friday at 20:00 `Europe/Madrid`.

Usage is attributed by:

- **application** — a stable logical label such as `sales` or `support`;
- **invocation type** — `direct`, `schedule`, `webhook`, or `poller`;
- Director/Worker role, workflow step, backend, and model.

Set `application` on daemon jobs that should roll up together. Direct calls may use
`--application <name>`; otherwise cestDone falls back to the target repository name
and logs a warning.

Token accounting preserves uncached input, cache creation, cache reads, and output
separately. `totalProcessedTokens` is the sum of all four categories and is an
activity measure, not a cost estimate. Agent SDK calls retain provider-reported USD
cost. Claude CLI subscription calls report cost as `n/a (subscription)`, never as
zero.

The usage ledger stores execution metadata only. It never stores prompts, model
responses, tool inputs or outputs, webhook payloads, credentials, or environment
variables. Reporting is scheduled and agent-assisted; there is intentionally no
public usage-reporting CLI or dashboard.

### Skip planning for structured jobs

Use `--skip-planning`, or set `"skipPlanning": true`, when the specification already defines the complete ordered workflow. cestDone sends the full specification to one Worker and does not create or read a `.plan.md` file. If reviews are enabled, one final Director review runs after the Worker succeeds.

Direct execution is strict: a `partial` or `failed` Worker result fails the complete run, and a final review must return `done`. It requires Worker mode and cannot be combined with `--no-with-worker`. Planning remains the default for open-ended implementation specifications.

For date-dependent jobs, direct mode prepends an authoritative UTC date and weekday to the Worker instructions. Each run also holds an atomic per-target, per-spec lock in `.cestdone/locks/`; a second invocation fails instead of overlapping. Locks are released after normal completion and expire after six hours to recover from abandoned wrapper processes.

Worker logs include authoritative counts of streamed tool calls, grouped by tool name (for example, `WebSearch:12`). These counts come from backend events rather than the model's self-report.

Claude CLI calls that declare an output schema pass it through the CLI's native `--json-schema` option. Human-facing files and reports may still use Markdown; only the internal Worker completion envelope and Director decision are JSON. Schema-free calls are unchanged.

Daemon schedules can enable it per job:

```json
{
  "options": {
    "skipPlanning": true,
    "workerModel": "sonnet",
    "directorModel": "sonnet"
  }
}
```

## Daemon Mode

The daemon is a long-running process that executes specs automatically based on schedules, webhooks, or polling triggers. It reuses the same `handleRun` execution engine — the daemon is just a "when to run" layer on top.

### Use Case: Auto-Fix GitHub Issues

You maintain an open-source library. When someone opens a bug report on GitHub, you want cestDone to automatically analyze the issue, find the root cause, write a fix, add tests, and push a branch — all without you touching the keyboard.

**Step 1 — Write a spec template** (`specs/fix-issue.md`):

```markdown
A user reported the following issue in our repository:

**Title**: {{payload.issue.title}}
**Description**: {{payload.issue.body}}
**Reporter**: {{payload.issue.user.login}}

Analyze the codebase, reproduce the bug, implement a fix, and add a regression test.
Create a new branch named fix/issue-{{payload.issue.number}} and commit the changes.
Do not modify unrelated code.
```

**Step 2 — Configure the daemon** (`.cestdonerc.json`):

```json
{
  "targetRepoPath": "./my-library",
  "daemon": {
    "webhooks": [
      {
        "name": "github-issues",
        "port": 9876,
        "path": "/github/issues",
        "spec": "specs/fix-issue.md",
        "target": "./my-library",
        "secret": "whsec_your_github_webhook_secret"
      }
    ]
  }
}
```

**Step 3 — Point GitHub at your daemon.** In your repo's Settings > Webhooks, add:
- **URL**: `http://your-server:9876/github/issues`
- **Content type**: `application/json`
- **Secret**: `whsec_your_github_webhook_secret`
- **Events**: "Issues" (opened)

**Step 4 — Start the daemon:**

```bash
cestdone daemon
```

Now, when someone opens an issue, GitHub POSTs the event to your daemon. The daemon injects the issue title, body, and number into the spec template, then runs the full Director + Worker flow — analyzing the codebase, writing a fix, running tests, and committing to a new branch. You wake up to a ready-to-review PR branch.

**Other examples of what you can automate:**

| Trigger | Use case |
|---|---|
| **Schedule** `0 9 * * 1` | Every Monday at 9am, scan for outdated dependencies and open upgrade PRs |
| **Schedule** `0 2 * * *` | Nightly: scrape industry articles, generate a summary, commit to a knowledge repo |
| **Webhook** GitHub PR review | When a PR gets "changes requested", auto-address the review comments |
| **Webhook** Linear/Jira ticket | When a ticket is moved to "Ready for Dev", auto-implement it |
| **Poller** `npm audit --json` | Every 6 hours, check for new vulnerabilities — if any appear, patch them |
| **Poller** curl an API | Monitor an endpoint; when the response changes, update internal documentation |

### How It Works

```
.cestdonerc.json
      │
      ├── schedules[]  ──► cron fires ──────────────────────┐
      ├── webhooks[]   ──► POST /path arrives ──────────────┤──► Job Queue (FIFO)
      └── pollers[]    ──► output changes ──────────────────┘        │
                                                                     ▼
                                                              handleRun()
                                                           (non-interactive)
                                                                     │
                                                              Director + Worker
                                                              plan → execute
```

1. **You configure triggers** in the `daemon` section of `.cestdonerc.json`
2. **You start the daemon**: `cestdone daemon` — it runs in the foreground, listening for events
3. **When a trigger fires**, it creates a job in an in-memory FIFO queue
4. **The run loop** processes jobs one at a time, calling `handleRun` with `--non-interactive` (auto-approves plans, skips clarifications)
5. **Results are logged** to `logs/daemon/` — one daemon log + one log per job

The daemon stays running until you stop it (`cestdone daemon stop` or Ctrl+C). It is not a background service by itself -- use systemd, pm2, or similar to daemonize it if needed.

### Hot Reload

The daemon watches `.cestdonerc.json` for changes. When you save the file, it automatically validates the new config and reloads all triggers (schedules, webhooks, pollers) without restarting. No rebuild, no `pm2 restart` -- just edit and save.

- **What reloads**: schedules, webhooks, pollers (all trigger sources are torn down and recreated)
- **What persists**: the job queue and any currently running job continue uninterrupted
- **Invalid config**: if the new config has errors (bad JSON, invalid cron, missing fields), the reload is skipped and a warning is logged. The daemon continues with the previous config
- **Debounce**: changes are debounced (500ms) to handle editors that write to temp files then rename

On Windows, an atomic temp-file rename can still emit only an `fs.watch` `rename` event, which the current watcher ignores. After editing `.cestdonerc.json`, verify the daemon log shows the new trigger counts. If it retained stale configuration, rewrite the same validated JSON in place to produce a `change` event and verify again.

### Daemon Configuration

Add a `daemon` section to `.cestdonerc.json`:

```json
{
  "targetRepoPath": "./my-app",
  "daemon": {
    "logDir": "logs/daemon",
    "pidFile": "logs/daemon/daemon.pid",
    "schedules": [
      {
        "name": "nightly-report",
        "cron": "0 2 * * *",
        "spec": "specs/generate-report.md",
        "target": "./my-app"
      }
    ],
    "webhooks": [
      {
        "name": "github-issues",
        "port": 9876,
        "path": "/github/issues",
        "spec": "specs/triage-issue.md",
        "target": "./my-app",
        "secret": "whsec_your_secret_here"
      }
    ],
    "pollers": [
      {
        "name": "check-deps",
        "cron": "0 */6 * * *",
        "command": "npm outdated --json",
        "spec": "specs/update-deps.md",
        "target": "./my-app"
      }
    ]
  }
}
```

### Schedules

Run a spec on a cron schedule. **Always triggers** — every time the cron fires, a run is enqueued regardless of external state. Use for periodic tasks that should happen no matter what (reports, cleanups, recurring scans). Uses standard cron syntax (5-field).

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique name for this schedule |
| `cron` | yes | Cron expression (e.g. `0 2 * * *` = daily at 2am) |
| `spec` | yes | Path to spec file |
| `target` | no | Target repository path |
| `application` | no | Logical application label for usage accounting |
| `houseRules` | no | Path to house rules file |
| `options` | no | Any `run` options to override |

### Webhooks

Listen for HTTP POST requests and trigger a spec run with the payload injected via templates.

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique name for this webhook |
| `port` | yes | HTTP port to listen on |
| `path` | no | URL path to match (default: `/`) |
| `spec` | yes | Path to spec file (may contain `{{variables}}`) |
| `secret` | no | HMAC secret for `X-Hub-Signature-256` validation |
| `target` | no | Target repository path |
| `application` | no | Logical application label for usage accounting |
| `options` | no | Any `run` options to override |

Multiple webhooks can share the same port if they have different paths.

### Pollers

Like a schedule, but with a **"only if changed" gate**. Periodically runs a command or fetches a URL, and **only triggers a run when the output changes** compared to the previous poll (first poll always triggers). Use when you want to react to changes rather than run blindly — e.g., "check `npm audit` every 6 hours, but only trigger a fix if new vulnerabilities appeared." If you used a schedule for this, cestDone would re-run every 6 hours even when nothing changed, wasting tokens and creating duplicate work.

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique name for this poller |
| `cron` | yes | How often to poll (cron expression) |
| `command` | one of | Shell command to run |
| `url` | one of | URL to fetch |
| `spec` | yes | Path to spec file (may contain `{{variables}}`) |
| `target` | no | Target repository path |
| `application` | no | Logical application label for usage accounting |
| `options` | no | Any `run` options to override |

### Spec Templating

Webhook payloads and poller outputs can be injected into spec files using `{{variable}}` syntax. The template context provides:

- `{{trigger.name}}` — name of the trigger that fired
- `{{trigger.type}}` — `webhook` or `poller`
- `{{timestamp}}` — ISO 8601 timestamp
- `{{payload.*}}` — webhook JSON body or `{{payload.output}}` for pollers

Example spec template for a GitHub issue webhook:

```markdown
Triage and fix the following issue:

**Title**: {{payload.issue.title}}
**Body**: {{payload.issue.body}}
**Labels**: {{payload.issue.labels}}

Analyze the issue, find the root cause, implement a fix, and add tests.
```

### Daemon Commands

```bash
# Start the daemon (foreground — Ctrl+C to stop)
cestdone daemon

# Check if daemon is running
cestdone daemon status

# Stop a running daemon
cestdone daemon stop
```

### Running as a Background Service

The daemon runs in the foreground by default. To run it as a persistent background service:

**With pm2:**
```bash
pm2 start "cestdone daemon" --name cestdone-daemon
```

**With systemd (Linux):**
```ini
[Unit]
Description=cestDone Daemon

[Service]
WorkingDirectory=/path/to/project
ExecStart=cestdone daemon
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Error Handling

| Scenario | Behavior |
|---|---|
| Spec run fails | Logged, marked as failed, queue continues |
| Invalid webhook JSON | Returns 400, not enqueued |
| HMAC validation fails | Returns 403, not enqueued |
| Poll command fails | Logged, skipped, keeps polling next interval |
| Escalation needed | `NonInteractiveEscalationError` caught, job marked failed |
| Daemon already running | Prints error with PID, exits |

## Email Notifications

cestDone can send emails via the `send-email` CLI command. This is designed for the Worker agent to invoke via Bash when a spec says "send an email when finished."

### Configuration

Set these environment variables (or add to `.env`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAIL_PROVIDER` | No | `smtp` | Mail provider (`smtp` or `sendgrid`) |
| `MAIL_FROM` | Yes | — | Sender email address |
| `SENDGRID_API_KEY` | For SendGrid | n/a | Dedicated Mail Send-only credential |
| `SENDGRID_SANDBOX_MODE` | No | `true` outside Production | Adds SendGrid sandbox mode so the provider validates without delivery |
| `SENDGRID_ALLOW_LIVE_SEND` | For non-Production live SendGrid | `false` | Explicit approval guard for unattended or controlled real delivery |
| `SMTP_HOST` | Yes | — | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP port (587 for STARTTLS, 465 for SSL) |
| `SMTP_USER` | Yes | — | SMTP username |
| `SMTP_PASS` | Yes | — | SMTP password or app password |
| `SMTP_SECURE` | No | auto | `true` for SSL (port 465), `false` for STARTTLS |

The Windows daemon uses a dedicated automation key stored in the
`ITM-SendGrid-cestdone-send` item in the operational 1Password vault. Its
ignored `.env` sets sandbox mode to false and the live-send approval flag to
true. Ordinary interactive testing keeps sandbox mode enabled.

### Example: Zoho Mail

```bash
MAIL_FROM=you@yourdomain.com
SMTP_HOST=smtp.zoho.com
SMTP_PORT=587
SMTP_USER=you@yourdomain.com
SMTP_PASS=your-app-password
```

### Usage

```bash
cestdone send-email \
  --to recipient@example.com \
  --subject "Build complete" \
  --body "All phases finished successfully."
```

In a spec file, you can instruct the Worker to send an email:

```markdown
When all tasks are complete, send a notification email:
cestdone send-email --to team@example.com --subject "Deploy done" --body "All phases completed."
```

The provider abstraction supports adding new providers (SendGrid, SES, etc.) by implementing the `MailProvider` interface.

## Spec File Format

Just plain text. Describe what you want:

```
Build a dashboard that shows project metrics.
Scrape data from ITM Platform and render charts with Chart.js.
Add a refresh button and auto-update every 5 minutes.
```

By default, the Director turns this into a structured `.plan.md` with phases, which becomes the source of truth for tracking progress. The original spec is never modified. For an operational specification that already contains its complete workflow, `--skip-planning` executes it directly as one Worker task.

Optionally provide a `--house-rules` file with coding standards, conventions, or constraints that apply across all phases.

## Made by

If you find cestDone useful, check out [Olkano](https://www.olkano.com) — a daily check-in app for people who live or spend time alone. One tap to say you're OK; your trusted contacts only hear from us if you don't. Because the best safety net is the one you never notice until you need it.

## License

ISC
