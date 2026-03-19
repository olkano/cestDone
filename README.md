# cestDone

AI-orchestrated development CLI. Write a plain-text spec, and cestDone turns it into working code — planning, implementing, reviewing, and committing autonomously.

## Why

The bottleneck in AI-assisted development isn't the AI — it's the human sitting between the planner and the coder. You paste context, copy instructions, re-explain what was already decided, and babysit every step.

**cestDone removes that bottleneck.** A Director AI reads your spec, explores the codebase, creates a phased plan, and either implements it directly or delegates to a Coder AI. The human intervenes only when explicitly opted in.

There's a second, subtler problem: **context window exhaustion.** When you drive an AI agent manually through a large project, the conversation fills up — the model forgets earlier decisions, loses track of files, and quality degrades. cestDone sidesteps this by giving the Director a fresh, focused context per step (read-only tools during planning, scoped phase specs during execution) while maintaining continuity through a resumed session. The Coder gets an even cleaner deal: a fresh session per phase with only the relevant slice of the plan. Neither agent's context window fills up, even on large projects.

## How It Works

```
spec.md ──► DIRECTOR                                        .plan.md
             │                                                  │
             ├─ Analyze (read-only)                             │
             ├─ Clarify (asks you questions)                    │
             └─ Create Plan ──────────────────────────────────► │
                                                                │
             For each phase:                                    │
             ┌──────────────────────────────────────────────┐   │
             │                                              │   │
             │  CODER (fresh session per phase)             │   │
             │  ├─ Reads phase spec from plan               │   │
             │  ├─ Implements: edit files, run tests        │   │
             │  └─ Reports result                           │   │
             │         │                                    │   │
             │         ▼                                    │   │
             │  DIRECTOR (review)                           │   │
             │  ├─ Reads code, runs tests                   │   │
             │  ├─ fix ──► retry Coder (max 3, then human)  │   │
             │  ├─ continue ──► Coder keeps going           │   │
             │  └─ done ──► commit, update plan ───────────►│   │
             │                                              │   │
             └──────────────────────────────────────────────┘   │
```

**Planning** (once per spec):
1. **Analyze** — Director reads the spec, explores the target repo
2. **Clarify** — Director asks questions if needed, you answer in the terminal
3. **Create Plan** — Director writes a structured `.plan.md` with numbered phases

**Execution** (per phase):
1. **Execute** — Coder implements the phase (or the Director, in director-only mode)
2. **Review** — Director reads files and optionally runs tests to verify
3. **Complete** — Director updates `.plan.md`, commits verified work, moves to next phase

### Two Modes

- **Two-agent mode** (default): Director plans and reviews, Coder implements. The Coder gets a fresh session per phase — clean context, no cross-phase pollution.
- **Director-only mode** (`--no-with-coder`): The Director does everything. Simpler, but the Director's context carries more weight.

### Two Backends

- **Claude CLI** (default): Spawns `claude -p` under the hood. Uses your Claude Max or Pro subscription — no API key, no per-token billing. Authenticate with `claude auth login`.
- **Agent SDK** (`--backend agent-sdk`): Uses `@anthropic-ai/claude-agent-sdk` with per-token API billing. Requires `ANTHROPIC_API_KEY` in the environment.

You can mix backends per agent (e.g., Director on CLI, Coder on API) with `--director-backend` and `--coder-backend`.

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
  run [options]        Create a plan from a spec and execute all phases
  resume [options]     Resume execution from an existing .plan.md file
  daemon [options]     Start daemon with schedules and triggers from .cestdonerc.json
  daemon status        Show daemon status
  daemon stop          Stop running daemon
```

### `run` options

```
  --spec <path>              Path to spec file (required)
  --house-rules <path>       Path to house rules file
  --target <path>            Target repository path (default: ".")
  --director-model <model>   Director model: haiku | sonnet | opus (default: "opus")
  --coder-model <model>      Coder model: haiku | sonnet | opus (default: "opus")
  --with-coder               Two-agent mode: Director plans, Coder implements (default: true)
  --no-with-coder            Disable two-agent mode (director-only)
  --with-reviews             Director reviews after Coder execution (default: true)
  --no-with-reviews          Disable Director reviews
  --with-bash-reviews        Allow Bash in reviews, implies --with-reviews (default: true)
  --no-with-bash-reviews     Disable Bash in reviews
  --with-human-validation    Require human approval of plan (default: false)
  --non-interactive          Run without TTY — auto-approves plans, skips clarifications (default: false)
  --backend <type>           Backend for both agents: agent-sdk | claude-cli (default: "claude-cli")
  --director-backend <type>  Override Director backend: agent-sdk | claude-cli
  --coder-backend <type>     Override Coder backend: agent-sdk | claude-cli
  --claude-cli-path <path>   Path to claude binary (default: "claude")
```

`resume` accepts all the same options except `--house-rules`.

### Examples

```bash
# Default: two-agent mode, reviews enabled, Claude CLI backend
cestdone run --spec spec.md --target ./my-app

# Director-only mode (no Coder)
cestdone run --spec spec.md --target ./my-app --no-with-coder

# Require human approval of the plan before execution
cestdone run --spec spec.md --target ./my-app --with-human-validation

# Non-interactive (CI/CD, scripts, daemon — no TTY required)
cestdone run --spec spec.md --target ./my-app --non-interactive

# Use API backend with custom models
cestdone run --spec spec.md --target ./my-app \
  --backend agent-sdk --director-model sonnet --coder-model haiku

# House rules for coding standards
cestdone run --spec spec.md --target ./my-app --house-rules house-rules.md
```

## Configuration

Optional `.cestdonerc.json` in the target repo. CLI flags take precedence.

```json
{
  "targetRepoPath": ".",
  "maxTurns": 100,
  "directorModel": "opus",
  "coderModel": "opus",
  "withCoder": true,
  "withReviews": true,
  "withBashReviews": true,
  "withHumanValidation": false,
  "nonInteractive": false,
  "directorBackend": "claude-cli",
  "coderBackend": "claude-cli",
  "claudeCliPath": "claude"
}
```

Model aliases `haiku`, `sonnet`, and `opus` resolve to full model IDs. You can also pass a full ID directly (e.g., `claude-sonnet-4-6`).

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

Now, when someone opens an issue, GitHub POSTs the event to your daemon. The daemon injects the issue title, body, and number into the spec template, then runs the full Director + Coder flow — analyzing the codebase, writing a fix, running tests, and committing to a new branch. You wake up to a ready-to-review PR branch.

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
                                                              Director + Coder
                                                              plan → execute
```

1. **You configure triggers** in the `daemon` section of `.cestdonerc.json`
2. **You start the daemon**: `cestdone daemon` — it runs in the foreground, listening for events
3. **When a trigger fires**, it creates a job in an in-memory FIFO queue
4. **The run loop** processes jobs one at a time, calling `handleRun` with `--non-interactive` (auto-approves plans, skips clarifications)
5. **Results are logged** to `.cestdone/daemon/` — one daemon log + one log per job

The daemon stays running until you stop it (`cestdone daemon stop` or Ctrl+C). It is not a background service by itself — use systemd, pm2, or similar to daemonize it if needed.

### Daemon Configuration

Add a `daemon` section to `.cestdonerc.json`:

```json
{
  "targetRepoPath": "./my-app",
  "daemon": {
    "logDir": ".cestdone/daemon",
    "pidFile": ".cestdone/daemon.pid",
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

## Spec File Format

Just plain text. Describe what you want:

```
Build a dashboard that shows project metrics.
Scrape data from ITM Platform and render charts with Chart.js.
Add a refresh button and auto-update every 5 minutes.
```

The Director turns this into a structured `.plan.md` with phases, which becomes the source of truth for tracking progress. The original spec is never modified.

Optionally provide a `--house-rules` file with coding standards, conventions, or constraints that apply across all phases.

## Made by

If you find cestDone useful, check out [Olkano](https://www.olkano.com) — a daily check-in app for people who live or spend time alone. One tap to say you're OK; your trusted contacts only hear from us if you don't. Because the best safety net is the one you never notice until you need it.

## License

ISC
