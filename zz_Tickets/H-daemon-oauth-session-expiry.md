# H. Daemon jobs fail when the Claude CLI OAuth session cannot be refreshed

**Status**: DEFERRED (2026-09-03). Diagnosis complete, options researched, connector audit done. No change implemented. Daniel declined option A for now because it removes claude.ai connectors from daemon runs and he wants to keep that capability available for future jobs. To be resumed another day; see "Decision log" and "When this is resumed".
**Priority**: High. Any expiry silently blocks every unattended job until a human logs in again. Last night it cost one daily sales report and three other runs.
**Date**: 2026-09-03
**Reporter**: failure emails for `daily-sales-report` and `helpscout-ticket-research`, 2026-09-03 01:00 and 01:10 Europe/Madrid

---

## Summary

cestDone runs every Director and Worker call through the official `claude -p` CLI on Daniel's Claude Max 20x subscription. That login is an OAuth pair (short-lived access token plus a single-use, 30-day refresh token) stored in `C:\Users\dpire\.claude\.credentials.json`. Interactive Claude Code sessions and the daemon's headless `claude -p` processes all share that one file.

When the refresh token in the file is no longer accepted by the server, a headless process has no browser and no recovery path. It exits 0 and prints the failure as its result:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

The daemon sees a Worker result with zero tokens and the message above, marks the job failed, and sends the failure email. Nothing retries. Every later job fails the same way until an interactive session refreshes the pair or Daniel runs `/login`. This is the same mechanism behind "every now and then Claude asks me to log in": the interactive session hits the dead refresh token and prompts, the daemon hits it and dies.

This is not related to OpenAI. cestDone has no OpenAI dependency (`grep -ril openai src .env` returns nothing).

## Evidence from 2026-09-02/03

All times UTC, Europe/Madrid in brackets.

| Time | Event | Source |
|---|---|---|
| 2026-09-02 14:22 [16:22] | Last successful job before the outage | `cestdone-daemon-out__2026-09-03_00-00-03.log` |
| 2026-09-02 19:21 [21:21] | Two interactive sessions active at the same minute in `ITMPlatform` (`41e4d537`, `4a5a5e51`) | `~/.claude/projects/*/*.jsonl` mtimes |
| 2026-09-02 21:00 [23:00] | `daily-server-health` fails, OAuth refresh | daemon log line 512 |
| 2026-09-02 21:10 [23:10] | `helpscout-ticket-research` fails | daemon log line 526 |
| 2026-09-02 23:00 [01:00] | `daily-sales-report` fails | `cestdone-daemon-error.log` |
| 2026-09-02 23:10 [01:10] | `helpscout-ticket-research` fails | `cestdone-daemon-error.log` |
| 2026-09-03 06:17 to 06:46 [08:17 to 08:46] | Token pair restored. Access token now expires 14:17:35Z; an interactive `ITM-Helpcenter` session was active in this window | `.credentials.json` metadata, session mtimes |
| 2026-09-03 08:00 [10:00] | `weekly-blog-update` authenticates normally, 28 turns | `cestdone-daemon-out.log` |
| 2026-09-03 08:10 [10:10] | Poller re-enqueues `helpscout-ticket-research` (hash map reset by the 08:00 config reload) | `cestdone-daemon-out.log` line 220 |

Four jobs failed in total. No earlier occurrence exists in any daemon log back to 2026-08-20.

Credential file metadata at 08:14Z on 2026-09-03 (values not recorded here):

- `subscriptionType: max`, `rateLimitTier: default_claude_max_20x`
- access token `expiresAt` 2026-09-03T14:17:35Z (about 8 hours after issue)
- `refreshTokenExpiresAt` 2026-10-03T00:14:04Z (30 days, rotated on each refresh)

Why a LocalSystem service reads Daniel's credentials: the PM2 dump (`C:\ProgramData\pm2\home\dump.pm2`) stores the environment captured at `pm2 save`, including `USERPROFILE=C:\Users\dpire`, `APPDATA=C:\Users\dpire\AppData\Roaming` and `USERNAME=dpire`. `buildEnv` in `src/backends/claude-cli.ts:463` passes `process.env` to the child, so `claude.exe` resolves `%USERPROFILE%\.claude\.credentials.json` to Daniel's file. A `pm2 save` from a differently configured shell would change this silently.

Daniel confirmed (2026-09-03) that Claude Code demanded a manual `/login` that morning. So the refresh token in the file was dead for every consumer, and the daemon outage and the interactive login prompt were one and the same event.

## Mechanism

1. `/login` stores an access token (hours) and a refresh token (30 days) in `.credentials.json`.
2. Any Claude Code process that needs a fresh access token exchanges the refresh token, receives a new pair, and rewrites the file. The old refresh token is invalidated (rotation).
3. Long-lived interactive sessions keep the newest pair in memory. Each daemon `claude -p` process is short-lived and reads the file cold.
4. When two processes refresh close together, or a session writes a stale pair back, the file can hold a refresh token the server has already rotated. The next cold process fails with the message above. The interactive session either keeps working from memory or prompts `/login`.
5. Anthropic hardened the file-based refresh path in v2.1.133 and v2.1.136, but the headless case is still reported open on v2.1.216 to v2.1.220 (issues #79685 and #81937; the related Keychain issue #76905 was closed as not planned). We run v2.1.258. The official error reference lists only one recovery: run `/login`.

The CLI exits 0 in this case. cestDone catches it only because the Worker summary text is surfaced; there is no explicit `authentication_failed` classification in `parseStreamResultEvent` (`src/backends/claude-cli.ts:114`).

## Constraints that shape the options

- **Policy.** Anthropic's Help Center (article 15036540, updated 2026-06-16) states that Agent SDK, `claude -p`, and third-party app usage still draw from the subscription's usage limits. The planned move to a separate paid credit pool (Pro $20, Max 5x $100, Max 20x $200 per month, billed at API rates) was paused on 2026-06-15 with advance notice promised before any change. The subscription path is supported today but under review.
- **MCP: local servers versus claude.ai connectors.** A `claude setup-token` token "can only make model requests": it cannot fetch claude.ai connectors (the `mcp__claude_ai_*` tools: Gmail, HubSpot, Google Drive, Calendar, Zoho Books, ITM Platform via claude.ai). Local MCP servers configured in `~/.claude.json` (`playwright`, `itm-platform`, `zoho-books`, `figma`, `figma-bridge`, `analytics-mcp`) keep working. Audit of every daemon log on disk (2026-08-05 to 2026-09-03) against the active specs:

  | Job | MCP actually used | Spec requirement | Effect of losing connectors |
  |---|---|---|---|
  | `weekly-blog-update` | `playwright` (267 calls, local) | Playwright for staging checks | none |
  | `weekly-accounting-update` | `zoho-books` (local) and `claude_ai_HubSpot` (6 calls in the 2026-08-17 run: search, get, one `manage_crm_objects` update, read-back for Step 4.8 renewals) | Zoho: local MCP "if available, otherwise direct API with curl". Drive: rclone in daemon runs. HubSpot: "If no HubSpot write channel is available in the session, list the exact pending updates in the report and email instead" | graceful degradation: renewal updates become a manual list for Daniel, unless Step 4.8 is repointed to `hubspot-report/tools/hs.ps1`, which already supports `-Patch`, `-Post`, `-Put` with the token in `hubspot-report/.env` |
  | `daily-server-health` | `claude_ai_Gmail` (2 calls, log of 2026-08-10) | none; email only through `cestdone send-email` | none, the calls were opportunistic |
  | `sales-feedback` webhook | `claude_ai_Gmail` (2 calls, log of 2026-08-06) | none in `process-feedback.md` | none |
  | `accounting-feedback` webhook | `claude_ai_Gmail` (1 call, log of 2026-08-18) | none; Zoho via local MCP or API, Drive via rclone | none |
  | `daily-sales-report`, `weekly-sales-review` | none | raw API via `hs.ps1` mandated; "unattended cestdone runs do NOT have the connector" (hubspot-report README) | none |
  | `helpscout-ticket-research`, `weekly-support-review` | none | Help Scout REST via curl | none |
  | `monthly-invoices`, `weekly-usage-report` | none | none | none |
  | `internet-listening-scan` (paused) | `claude_ai_Gmail` (4 calls) | to check before unpausing | unknown |

  Conclusion: no active job needs a claude.ai connector in unattended mode. The interactive-only connector tools were reachable in daemon runs by accident of the shared login, and the specs were written not to rely on them. Option A does not break any active job.
- **Cost of API billing.** The week ending 2026-08-28 processed 350.3M tokens: 7K uncached input, 18.1M cache writes, 329.5M cache reads, 2.76M output, 93% on `claude-opus-5`. At list prices (Opus 5: $5 input, $25 output, $6.25 cache write at 5-minute TTL or $10 at 1-hour TTL, $0.50 cache read per million) that is roughly $330 to $400 per week, about $1,400 to $1,700 per month, against $200 per month for Max 20x. Full API billing is not economical as the primary path.
- **Local dependencies.** Jobs need local repositories, Windows tools, PowerShell scripts and G: drive access, so cloud-hosted alternatives (Claude Code routines via `/schedule`, Managed Agents) do not fit.

## Options

### A. Long-lived subscription token for the daemon (recommended first step)

`claude setup-token` runs the browser login once and prints a one-year OAuth token (`sk-ant-oat01-...`). It is not saved anywhere by the CLI. Set it as `CLAUDE_CODE_OAUTH_TOKEN` for the daemon only.

Mechanics in this repo: add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `C:\Users\dpire\Code\cestdone\.env` (gitignored, loaded at process start by `src/cli/index.ts:10`, which the PM2 wrapper imports), then restart the daemon from an elevated PM2 shell. `buildEnv` forwards it to every spawned `claude`. Precedence: the env token (rank 5) beats the `/login` file (rank 7), so the daemon stops reading or writing `.credentials.json` at all. Interactive sessions are untouched because the variable lives only in the daemon's `.env`.

Pros: removes the shared-file race entirely; no refresh, so no refresh failure; same subscription billing; 15 minutes of work; no code change.
Cons: one-year expiry with no automatic renewal (record the date, add a reminder and a preflight check, see D2); no claude.ai connectors in daemon jobs (see the connector list above; each affected spec must use API or curl paths, as `daily-sales-report` already does); the token is equivalent to the subscription password, keep it out of `ecosystem.config.cjs`, `.cestdonerc.json`, PM2 dump and docs; not read in `--bare` mode (cestDone does not use `--bare`).

### B. Isolated credential store for the daemon

Set `CLAUDE_CONFIG_DIR=C:\Users\dpire\.claude-daemon` in the daemon's `.env`, run `claude login` once with that variable set, and let the daemon keep its own refresh cycle.

Pros: keeps normal `/login` behaviour and claude.ai connectors; no shared file with interactive sessions, so the rotation race disappears.
Cons: the whole config moves with it (settings, plugins, skills, memory, and the user-scope MCP servers in `~/.claude.json` such as `playwright`, `itm-platform`, `zoho-books` would have to be re-added in the daemon profile); refresh can still fail for other reasons (network, server) and then the daemon is stuck until a manual login, the same symptom at lower frequency; the 30-day refresh token needs at least one run per month (fine with daily jobs, a risk during a paused daemon).

### C. API key: as failover, or as the primary path

`ANTHROPIC_API_KEY` from the Console, either with the CLI backend (the CLI uses the key in `-p` mode when present) or the `agent-sdk` backend. cestDone currently strips `ANTHROPIC_API_KEY` from the child env on purpose (`src/backends/claude-cli.ts:476`) to keep subscription billing.

As primary path: most robust (no OAuth at all), but $1,400 to $1,700 per month at current volume. Only sensible if the paused billing change lands and forces it, or if volume drops a lot.
As failover: on an `authentication_failed` result, retry the call once through an API-key backend. Costs nothing on normal days and turns an outage into a small bill. Needs a code change (backend fallback in the Director/Worker invoke path) and a spend cap on the Console key (issue #37686 documents a $1,800 surprise from an unintended `claude -p` on API billing).

### D. cestDone hardening (worth doing under any option)

1. **Explicit auth failure classification.** In `parseStreamResultEvent`, treat a result text starting with `Failed to authenticate` as `success=false` with a distinct `authentication_failed` message, the same way `Prompt is too long` and `Claude AI usage limit reached` are handled. Today the Worker reports `partial`, which in a multi-phase run would trigger fix and continue loops instead of a clean stop.
2. **Preflight credential check before each job, with early warning.** With option A: store the token issue date and alert 14 days before the one-year expiry. With the file login: read `expiresAt` and `refreshTokenExpiresAt` and alert when the refresh token is within 3 days of expiry (Claude Code itself only warns interactively). Send a distinct email subject (`Claude login expired, run claude login`) so it is not read as a job bug.
3. **Retries.** `retries` and `retryDelayMs` per schedule, webhook and poller already exist (`src/daemon/types.ts:5`, `src/daemon/daemon.ts:126`) but are undocumented and unused in `.cestdonerc.json`. A retry after 30 to 60 minutes covers network blips. It would not have covered last night's 9-hour gap.
4. **Poller hash rollback on failure.** `src/daemon/poller.ts:34` commits the new hash before dispatch and never reverts it. Last night's payload was only recovered because the 08:00 config reload rebuilt the poller. Commit the hash after the job succeeds, or revert it on failure.
5. **Missed-schedule catch-up.** `daily-sales-report` has no second chance until the next day. Consider a bounded retry window (for example hourly until 06:00) or a documented manual re-run command.

### E. Considered and rejected

- Claude Code routines (`/schedule`) and Managed Agents: cloud execution, no access to local repositories, Windows tooling or the G: drive.
- Amazon Bedrock, Vertex AI, Microsoft Foundry: API-rate billing plus provider setup, no advantage over option C.
- `--bare` mode for `-p`: never reads OAuth credentials, so it requires an API key; it also drops hooks, skills and MCP servers the jobs rely on.

## Decision log

- 2026-09-03: Daniel confirmed the manual `/login` that morning and reviewed the connector audit. Decision: do not adopt option A now. Reason: a setup-token cannot fetch claude.ai connectors, and although no active job needs them unattended today, Daniel wants that capability to stay possible for future jobs. Option A is reversible (remove the variable and restart), but the preference is not to introduce a credential path without connectors at all. Work paused; nothing changed in `.env`, `.cestdonerc.json`, PM2 or code.

## Recommendation (revised for the connector constraint)

The requirement that claude.ai connectors stay available in unattended runs rules out option A and the `--bare` route, and leaves the login-file mechanism in place. The remaining levers reduce how often it breaks and how fast it is noticed:

1. **Option B, isolated login for the daemon.** `CLAUDE_CONFIG_DIR` in cestDone's `.env`, one-time `claude login` under that directory as Daniel, re-add the user-scope MCP servers (`playwright`, `zoho-books`, `itm-platform`) to the daemon profile. This removes the rotation race with interactive sessions, which is the trigger observed here, while keeping a normal subscription login and its connectors. It does not remove the residual risk of a refresh failing for other reasons, or of the 30-day refresh token lapsing if the daemon is paused.
2. **Hardening D1, D2, D4** regardless of B. D2 should read `refreshTokenExpiresAt` from the daemon's credentials file before each job and email a distinct warning at 3 days, and a distinct "login expired, run claude login" email on `authentication_failed`, so a dead login is noticed as a login problem, not as a job bug.
3. **Option C as failover** once a Console spend cap is agreed: on `authentication_failed`, retry once through an API-key backend so a dead login degrades to a small bill instead of a missed run.
4. **Watch upstream.** Issue #79685 asks Anthropic for a supported long-lived headless credential with connector parity. If that ships, it replaces B and makes A acceptable.

## When this is resumed

1. Decide between B (isolated login, keeps connectors) and living with the shared file plus hardening only.
2. If B: create the directory, log in once with `CLAUDE_CONFIG_DIR` set, copy the MCP server entries from `~/.claude.json`, set the variable in `.env`, restart the daemon via elevated PM2, and verify with one scheduled job that the log shows real token counts and that connector tools appear in the tool list.
3. Implement D1, D2 and D4 with tests (`npm test`, `npm run build`), document `retries` and `retryDelayMs` in the README daemon section, then `npm link` only if the global command is meant to change.
4. Decide on the API failover and its spend cap.
5. Re-check `internet-listening-scan` for connector needs before it is ever unpaused.

## Verification once implemented

- Daemon log for the next scheduled job shows real token counts and `success=true` with no `Failed to authenticate` line.
- `claude -p "reply ok" --max-turns 1` run from an elevated shell with the daemon's `.env` loaded succeeds without touching `.credentials.json` (compare the file mtime before and after).
- Interactive `claude` `/status` still shows the subscription login, not the token.
- `git status` in cestDone shows `.env` untouched by version control; `dump.pm2` contains no `CLAUDE_CODE_OAUTH_TOKEN`.
- Automated tests cover the `Failed to authenticate` classification and the poller hash rollback.

## Documentation to update at implementation time

- `README.md`, "Two Backends" and "Running as a Background Service": describe `CLAUDE_CODE_OAUTH_TOKEN`, its one-year lifetime and the connector limitation; document `retries` and `retryDelayMs`.
- `AGENTS.md`, PM2 section: note that the saved PM2 environment carries `USERPROFILE=C:\Users\dpire`, which is what lets a LocalSystem service reach Daniel's Claude credentials, and that `pm2 save` from another shell can change it.
- Memory: replace the standing note that "Max/Pro subscriptions cannot be used" for the SDK with the current Help Center position.

## Open questions

- Resolved 2026-09-03: Daniel had to run `/login` that morning; no active spec depends on a claude.ai connector unattended (audit table in Constraints); option A declined to preserve connectors for future jobs.
- Under option B, does a `/login` performed with `CLAUDE_CONFIG_DIR` set expose the claude.ai connectors to `-p` runs from that profile? Expected yes (same account grants), to be verified with a test job before relying on it.
- Is a Console API key with a spend cap acceptable as a failover, and at what monthly cap?

## References

- Claude Code authentication (credential storage, precedence, `setup-token`): https://code.claude.com/docs/en/authentication
- Claude Code non-interactive mode (`-p`, `--bare`, exit codes): https://code.claude.com/docs/en/headless
- Claude Code error reference ("Login expired", "OAuth session expired and could not be refreshed"): https://code.claude.com/docs/en/errors
- Help Center, "Use the Claude Agent SDK with your Claude plan" (June 15 pause notice): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Issue #79685, headless `claude -p` fails while interactive session works: https://github.com/anthropics/claude-code/issues/79685
- Issue #81937, `claude -p` fails with OAuth session expired: https://github.com/anthropics/claude-code/issues/81937
- Issue #76905, refresh token rotation race between concurrent sessions: https://github.com/anthropics/claude-code/issues/76905
- Issue #37686, unintended API billing from `claude -p`: https://github.com/anthropics/claude-code/issues/37686
