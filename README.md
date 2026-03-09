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

```bash
npm install
```

Write a spec file:

```
Add POST /api/auth/login with JWT tokens. Use bcrypt for passwords.
Include tests.
```

Run it:

```bash
# Using Claude CLI backend (default — uses Max/Pro subscription)
npx tsx src/cli/index.ts run --spec spec.md --target ./my-app

# Using Agent SDK backend (requires ANTHROPIC_API_KEY)
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app --backend agent-sdk
```

Resume a partially completed plan:

```bash
npx tsx src/cli/index.ts resume --spec spec.md --target ./my-app
```

## CLI Reference

```
Usage: cestdone [commands]

Commands:
  run [options]     Create a plan from a spec and execute all phases
  resume [options]  Resume execution from an existing .plan.md file
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
  --backend <type>           Backend for both agents: agent-sdk | claude-cli (default: "claude-cli")
  --director-backend <type>  Override Director backend: agent-sdk | claude-cli
  --coder-backend <type>     Override Coder backend: agent-sdk | claude-cli
  --claude-cli-path <path>   Path to claude binary (default: "claude")
```

`resume` accepts all the same options except `--house-rules`.

### Examples

```bash
# Default: two-agent mode, reviews enabled, Claude CLI backend
npx tsx src/cli/index.ts run --spec spec.md --target ./my-app

# Director-only mode (no Coder)
npx tsx src/cli/index.ts run --spec spec.md --target ./my-app --no-with-coder

# Require human approval of the plan before execution
npx tsx src/cli/index.ts run --spec spec.md --target ./my-app --with-human-validation

# Use API backend with custom models
npx tsx --env-file=.env src/cli/index.ts run --spec spec.md --target ./my-app \
  --backend agent-sdk --director-model sonnet --coder-model haiku

# House rules for coding standards
npx tsx src/cli/index.ts run --spec spec.md --target ./my-app --house-rules house-rules.md
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
  "directorBackend": "claude-cli",
  "coderBackend": "claude-cli",
  "claudeCliPath": "claude"
}
```

Model aliases `haiku`, `sonnet`, and `opus` resolve to full model IDs. You can also pass a full ID directly (e.g., `claude-sonnet-4-6`).

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
