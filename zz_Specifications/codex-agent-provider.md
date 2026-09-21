# Codex agent provider for cestDone

Status: In progress. The provider, selection, orchestration, usage V2, daemon snapshots, offline tests, documentation, and opt-in E2E harness are implemented. Offline acceptance and the live E1-E10 gate must be recorded separately before this specification moves to `done/`.

Reviewed: 2026-09-20. SDK compatibility target: `@openai/codex-sdk@0.155.1` and its matching `@openai/codex@0.155.1` runtime.

Authentication: Saved ChatGPT client login only. No OpenAI API-key execution, Responses API implementation, or automatic provider fallback.

The implementation request authorizes the code, offline tests, and isolated test harness described here. Running the live test harness consumes the selected account's Codex allowance. Production jobs, service credentials, live daemon configuration, PM2 restart, global CLI updates, commits, and pushes remain separate operational actions.

Implementation evidence on 2026-09-20: the bundled `codex-cli 0.155.1` resolved and the invoking user's ordinary home reported `Logged in using ChatGPT`. The live harness may use that home as configured; it does not suppress its plugins, notifications, hooks, skills, or MCP servers. Live E1-E10 results are recorded separately from offline acceptance.

Offline evidence on 2026-09-20: `npm test` passed 50 files and 720 tests, `npm run lint` passed, and `npm run build` passed. The real-SDK transport test uses the pinned SDK with only its child-process launch intercepted.

Live evidence on 2026-09-20 with the invoking user's normal, unsuppressed Codex home and `gpt-5.6-sol`: E1-E9 passed through the pinned ChatGPT-authenticated client. E10 is blocked by `Prerequisite SANDBOX_HELPER`; the pinned client's `doctor --json` reports `sandbox.helpers` failed because elevated Windows sandbox provisioning recorded `helper_unknown_error`, with repair/reinstall of the approved Codex distribution as remediation. The local sandbox command and model tool attempt both failed at helper process creation, so absence of the sentinel is not misreported as a read-only enforcement pass. Mixed Claude/Codex cases were NOT RUN because `--include-claude` was not requested. Sanitized evidence is retained in `codex-e2e-2026-09-20.json`.

## Contents

1. [Outcome and fixed decisions](#1-outcome-and-fixed-decisions)
2. [Verified facts and corrections](#2-verified-facts-and-corrections)
3. [Configuration and resolution](#3-configuration-and-resolution)
4. [Run preparation and daemon snapshots](#4-run-preparation-and-daemon-snapshots)
5. [Runtime and authentication](#5-runtime-and-authentication)
6. [Invocation, permissions, and streaming](#6-invocation-permissions-and-streaming)
7. [Structured results and orchestration](#7-structured-results-and-orchestration)
8. [Usage, billing, and failures](#8-usage-billing-and-failures)
9. [Implementation sequence](#9-implementation-sequence)
10. [Offline test contract](#10-offline-test-contract)
11. [Real-client E2E harness](#11-real-client-e2e-harness)
12. [Production rollout](#12-production-rollout)
13. [Acceptance and handoff](#13-acceptance-and-handoff)
14. [Evidence and references](#14-evidence-and-references)

This is one implementation specification because selection, execution, queueing, and accounting share contracts. The sections below are normative; examples marked as examples are not production configuration.

## 1. Outcome and fixed decisions

Each job can select Claude or Codex through a named agent profile. A root `defaultAgent` supplies the choice for jobs without an explicit assignment. Direct `run`, `resume`, schedules, webhooks, and pollers use the same resolver. Optional Director and Worker selectors allow mixed-provider jobs.

Use the official TypeScript Codex SDK. It drives the local Codex client and can reuse saved ChatGPT authentication. SDK use does not imply API billing. Using the same account and workspace consumes that account's Codex allowance, subject to its limits and any account-level credit settings. It does not share this interactive conversation's history, tools, plugins, or permissions. Do not describe this as unlimited or guaranteed free: ChatGPT credits can also fund usage. [Authentication](https://learn.chatgpt.com/docs/auth), [pricing and credits](https://learn.chatgpt.com/docs/pricing).

Keep Claude as the built-in compatibility default. Defining a Codex profile alone must not change any job. Change the configured default only when deliberately requested.

Keep the existing backend identifier `agent-sdk` for the optional Anthropic implementation. Add `codex-sdk`; add a separate provider field. Renaming `agent-sdk` to `claude-agent-sdk` is unnecessary for this feature and would create avoidable compatibility work in configuration, tests, and historical records.

Preserve current orchestration: fresh Workers, a resumable Director within a planned run, existing reviewer gates, retries, run locks, plan files, and usage records. The SDK must not introduce its own orchestration or subagents.

The first implementation supports Codex shell execution and native Codex tools. Existing Claude `mcpConfig` JSON is not portable. Existing Codex-home MCP configuration can be used, but its account connections and availability must be tested independently. Do not imply that Claude's MCP set or the tools in this interactive session transfer automatically.

## 2. Verified facts and corrections

| Verified evidence | Implementation consequence |
|---|---|
| `Backend` in `src/shared/types.ts` already provides `invoke` and `preflight`. | Add the adapter at this seam; keep SDK details out of Director and Worker logic. |
| `handleRun()` and `handleResume()` call `loadConfig()` without a directory argument. Configuration comes from process cwd, even when `--target` points elsewhere. | Preserve this lookup rule. Do not silently start loading the target repository's config. Document it correctly and test different cwd/target paths. |
| `applyFlags()` merges explicit options into config; model resolution occurs later in multiple Director/Worker paths. | Resolve role selections once while option provenance is still available. Remove late Claude alias resolution from every planning, revision, execution, review, and completion path. |
| `buildReviewPrompt()` asks the Director to commit when `autoCommit` is true. Claude reviews with Bash are not OS-enforced read-only. | An always-read-only Codex review would break the default workflow. Follow the permission table in section 6. |
| `executeDirector()` can interpret malformed/plain-text output as `done`; planned review treats other actions as done too. | Close these success fallbacks for shared orchestration as specified in section 7. This is an intentional correctness change. |
| Planning and plan-revision Workers receive `rawPrompt` and no output schema. Some manually constructed Worker options omit MCP/budget propagation. | Preserve schema-free planning and consolidate Worker option construction so provider settings reach every Worker path. |
| Existing backend preflights are never called by the run flow. | Add preflight before target mutation or model work, with mocks in existing tests. |
| `handleRun()` rereads root config for every daemon attempt; the watcher passes only `parsed.daemon`. | Pass a prepared execution snapshot through an internal argument. Queue retries must not reread profiles. |
| `cestdone-pm2.cjs` starts the daemon and watcher independently of Commander. | Update and test both entry points when changing reload or execution signatures. |
| Published SDK 0.155.1 depends exactly on CLI 0.155.1, uses native binaries from optional platform packages, and exposes `runStreamed(...).events`. | Pin the SDK, retain optional dependencies, consume the async generator fully, and use the same native binary for preflight. |
| This workstation's globally installed CLI was 0.144.4 during this review. | Global `codex --version` or `login status` cannot validate the pinned runtime contract. Do not upgrade it as part of this feature. |
| SDK `env` replaces inheritance; `apiKey` would set `CODEX_API_KEY`; `codexPathOverride` bypasses the SDK's helper-PATH injection. | Build the child environment deliberately and preserve platform helper paths for explicit native overrides. |
| Runtime 0.155.1's JSONL processor emits `usage.total` on `turn.completed`. | Treat usage as cumulative for a resumed thread; subtract the previous observed total before recording another call. |
| SDK errors expose messages, not a stable typed HTTP error/status contract. | Classification is best effort. Do not invent exact HTTP codes or retry-after values. |
| Filesystem sandboxing does not constrain all MCP/App side effects. | A read-only sandbox is a local filesystem boundary, not proof that every tool is read-only. |
| `ensureGitRepo()` can initialize and commit a new repository; the CLI loads the installation's `.env` on import. | E2E fixtures must have a Git repository already, and the harness must override installation-env loading. |

Package implementation evidence is identified in section 14. No real model calls, package installation, daemon changes, or credential provisioning were performed during this specification review.

## 3. Configuration and resolution

### 3.1 Public types

Add these types without changing the meaning of existing backend strings:

```typescript
type AgentProvider = 'claude' | 'codex'
type BackendType = 'claude-cli' | 'agent-sdk' | 'codex-sdk'
type CodexReasoningEffort =
  | 'minimal' | 'low' | 'medium' | 'high'
  | 'xhigh' | 'max' | 'ultra' | 'persistent'

interface AgentProfile {
  provider: AgentProvider
  backend: BackendType
  directorBackend?: BackendType
  workerBackend?: BackendType
  directorModel: string
  workerModel: string
  directorReasoningEffort?: CodexReasoningEffort
  workerReasoningEffort?: CodexReasoningEffort
  callTimeoutMs?: number
  webSearchMode?: 'disabled' | 'cached' | 'live'
  codexCliPath?: string
}

interface AgentSelectionOptions {
  agent?: string
  directorAgent?: string
  workerAgent?: string
}
```

Extend `Config` with `defaultAgent?: string` and `agentProfiles?: Record<string, AgentProfile>`. Extend both `RunOptions` and `ResumeOptions` with `AgentSelectionOptions`. Trigger `options` already use `Partial<RunOptions>`.

Profile names must match `^[a-z][a-z0-9-]*$`. Names such as `claude` and `codex` are ordinary configured names, not automatically created profiles. An explicit `--agent codex` without a defined profile fails with an actionable configuration error.

Claude profile backends may be `claude-cli` or `agent-sdk`, including role-specific combinations. Codex profile backends must all be `codex-sdk`. Models must be nonempty strings. Reject Claude aliases and `claude-*` IDs on Codex; do not maintain a fragile hard-coded allowlist of Codex model IDs. Account availability is proved by a real call, not by local validation.

Codex reasoning enum values match the pinned SDK type, but an individual model may support only a subset. No automatic downgrade of an unsupported reasoning setting.

Codex-only fields on Claude profiles fail validation. For Codex, omitted `callTimeoutMs` means 3,600,000 ms; allow positive integers up to 86,400,000 ms. Omitted `webSearchMode` means `cached`; the E2E profile uses `disabled`. `codexCliPath`, when provided, is an absolute native executable path, not a shell command, `.cmd`, `.ps1`, or arguments embedded in a string.

Example configuration, with an example model ID to replace if unavailable to the intended account:

```json
{
  "defaultAgent": "claude",
  "agentProfiles": {
    "claude": {
      "provider": "claude",
      "backend": "claude-cli",
      "directorModel": "sonnet",
      "workerModel": "opus"
    },
    "codex": {
      "provider": "codex",
      "backend": "codex-sdk",
      "directorModel": "gpt-5.6-terra",
      "workerModel": "gpt-5.6-terra",
      "directorReasoningEffort": "medium",
      "workerReasoningEffort": "medium",
      "callTimeoutMs": 3600000,
      "webSearchMode": "cached"
    }
  },
  "daemon": {
    "schedules": [
      {
        "name": "example-codex-job",
        "cron": "0 2 * * *",
        "spec": "specs/example.md",
        "options": {
          "agent": "codex",
          "skipPlanning": true,
          "autoCommit": false
        }
      }
    ]
  }
}
```

The model above is an example from official SDK documentation, not a recommendation to migrate current jobs or a guarantee of account access.

### 3.2 CLI wiring

Add `--agent <profile>`, `--director-agent <profile>`, and `--worker-agent <profile>` in `addCommonOptions()`. Forward them through both Commander actions; adding help text alone is insufficient. Reuse the option interfaces instead of maintaining separate handwritten action-property lists. Also preserve the existing `mcpConfig` option in the resume action, which currently drops it.

Keep legacy `--backend`, `--director-backend`, and `--worker-backend` for Claude. Require a profile to select Codex: reject raw `--backend codex-sdk` with guidance to define/select a Codex profile. This guarantees explicit models and coherent provider settings.

Do not give Commander actual default values for new selectors or model flags. Defaults belong in the resolver so omission is distinguishable from an explicit override.

### 3.3 Exact precedence

Implement one pure `resolveRunAgents(root, explicitOptions, env)` function. Resolve each role independently, in this order:

1. Explicit role selector: `directorAgent` or `workerAgent`.
2. Explicit shared selector: `agent`.
3. Explicit legacy role backend, then explicit shared `backend`.
4. Root `defaultAgent`.
5. Root legacy role backend.
6. Built-in `claude-cli`.

An explicit selector in items 1 or 2 and any explicit legacy backend applying to that same role is an error. A root default is a fallback, so an explicit legacy backend overrides it without an error. Root legacy backend/model fields are ignored for a role selected through a profile; their presence in an old config must not make profile adoption fail.

For profile-selected roles, resolve model as explicit role model option, otherwise the profile's role model. Ignore root legacy model fields and `CESTDONE_DIRECTOR_MODEL`/`CESTDONE_WORKER_MODEL` for these roles, including Claude profiles. For legacy roles, preserve existing precedence: explicit role model, root role model, legacy role environment variable, built-in `opus`. Apply aliases only after deciding that the provider is Claude.

| Root / explicit options | Director | Worker |
|---|---|---|
| No new fields / no options | Legacy Claude | Legacy Claude |
| Default `codex` / no options | Codex profile | Codex profile |
| Default `claude` / `agent: codex` | Codex profile | Codex profile |
| Default `claude` / `workerAgent: codex` | Claude profile | Codex profile |
| Default `codex` / `backend: claude-cli` | Legacy Claude | Legacy Claude |
| Default `codex` / `directorBackend: claude-cli` | Legacy Claude | Codex profile |
| Any / `agent: codex, workerBackend: claude-cli` | Configuration error | Configuration error |
| Any / `directorAgent: codex, workerBackend: claude-cli` | Codex profile | Legacy Claude |

Validate the whole root configuration's new fields and each active trigger's effective selection at startup and reload. Preserve unrelated existing root fields; do not broaden this change into rejecting previously accepted operator metadata. Validate unselected profiles structurally, but do not preflight their credentials or require installed native runtimes. A configured but unused Codex profile must not block Claude jobs.

### 3.4 Resolved selections

```typescript
interface ResolvedAgentSelection {
  profileName: string | null // null means legacy selection
  provider: AgentProvider
  backend: BackendType
  model: string
  reasoningEffort?: CodexReasoningEffort
  callTimeoutMs?: number
  webSearchMode?: 'disabled' | 'cached' | 'live'
  codexCliPath?: string
}

interface ResolvedRunAgents {
  director: Readonly<ResolvedAgentSelection>
  worker: Readonly<ResolvedAgentSelection>
}
```

Determine which roles will actually execute. A planned run always uses a planning Worker, even with `withWorker: false`; phase completion still calls the Director with reviews disabled. A direct `skipPlanning` run without reviews needs only the Worker. Reject incompatible settings and preflight only active roles. Validate explicit selector syntax/references even when the role is inactive.

All option precedence and provider resolution must finish before model calls. Persist profile/provider/backend/requested model/reasoning in usage metadata. The SDK does not report a reliable actual-model field in these events: `model` means requested model, not independently verified server routing.

## 4. Run preparation and daemon snapshots

Create a shared preparation function used by direct run, resume, and daemon enqueue. Its result contains the effective run config with absolute paths, resolved roles, and provenance needed for diagnostics. It must not contain the `daemon` subtree, webhook secrets, arbitrary environment variables, or provider credentials.

Add a separate internal third parameter to `handleRun` and `handleResume`, for example `prepared?: PreparedRun`. Do not expose it as a CLI or JSON option. With a prepared run, do not call `loadConfig()`, reapply profile selection, or read legacy model environment overrides.

For direct commands, use cwd config and existing path resolution. For daemon jobs, resolve relative paths against the daemon's startup config directory, not a rendered webhook-spec directory. Preserve schedule `target`/`houseRules` precedence over its options only when those fields are defined; spreading `target: undefined` must not erase a supplied option.

At enqueue, copy the effective execution settings and resolved roles into a job snapshot using `structuredClone` plus an appropriate readonly/deep-freeze boundary. Include model, reasoning, runtime override, time limit, web-search setting, MCP path, review/commit options, target, house rules, and usage/log directories. Capture the effective Codex-home path; do not snapshot credential contents. Environment credentials can rotate normally between attempts.

Generated run directory, attempt number, timestamps, and usage run ID are fresh per attempt. The original source spec path stays in invocation metadata even when webhook/poller template rendering uses a temporary spec. Existing template payload storage remains private; never log a whole `Job` or config object.

Change watcher callback and `DaemonProcess.reload()` to receive full validated root config. Update both `src/cli/index.ts` and `cestdone-pm2.cjs`. Keep config containing webhook secrets private; call it a validated config, not a nonsecret snapshot.

Validate a reload before stopping active triggers. Serialize reloads so two file events cannot interleave teardown/startup. After successful reload, new enqueue callbacks read the new config; queued/running jobs and retries use their old snapshots. Invalid config leaves existing triggers untouched. If installing otherwise-valid triggers fails, report failure and restore the prior configuration/triggers as far as possible; do not announce a successful reload.

Use the existing watch mechanism; fixing atomic-rename detection is outside scope. Retain the documented in-place write and log read-back procedure for operations. Poller restart can enqueue an unchanged first observation: snapshotting does not solve poller deduplication.

For each attempt: prepare/validate, preflight active backends, then use existing Git/run-lock/run-directory/usage setup and execute. In particular, a missing login must fail before `ensureGitRepo()` can create a commit. If a usage record has been initialized before a later failure, finalize it as failed in `finally`; release acquired locks on every exit. Configuration/preflight failure before a run record exists is not a model call.

Log only an explicit selection projection, for example role, profile or `legacy`, provider, backend, requested model, reasoning, access mode, and runtime version. Do not log environment maps or complete resolved configuration.

## 5. Runtime and authentication

### 5.1 Pin and resolve the runtime

Add `@openai/codex-sdk` at exact version `0.155.1` and update the lockfile during implementation. Do not use a caret or silently substitute the global CLI. If that version is unavailable at implementation time, revise the compatibility evidence and tests before choosing a different pin.

The SDK does not export its native-runtime resolver. Add a small `src/backends/codex-runtime.ts` helper based on the published package layout, with unit tests:

1. Resolve the SDK entry via `createRequire(import.meta.url)`; create a require relative to that entry to resolve its `@openai/codex/package.json`.
2. Resolve the platform package relative to that Codex package. Supported pairs are win32/linux/darwin with x64/arm64.
3. Map to the SDK's target triples: Windows `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc`; Linux `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`; macOS `x86_64-apple-darwin` / `aarch64-apple-darwin`.
4. Under platform package `vendor/<triple>`, prefer `bin/codex[.exe]` with `codex-package.json`; support the SDK's legacy `codex/codex[.exe]` layout. Use corresponding `codex-path` or legacy `path` helper directory when present.
5. Return executable path, helper paths, and expected version. Spawn with an argument array and `shell: false`; never route a native Windows path through cmd or PowerShell.
6. Use the resolved native path for both preflight and SDK `codexPathOverride`, prepending helper paths yourself. This is an explicit override to the SDK-bundled binary, not selection of a global installation.
7. An explicit profile override follows the same native-path rule and must report exactly the supported CLI version. No unsupported-version bypass in production.

Keep this helper limited to locating/executing the client; it must not parse the model's JSONL protocol. A package resolver/layout test is required after every SDK upgrade.

### 5.2 Effective environment

Compute effective home as `CESTDONE_CODEX_HOME`, otherwise inherited `CODEX_HOME`, otherwise `path.join(os.homedir(), '.codex')`. An explicit home must be absolute, exist, and be outside the target repository. Do not create or provision it implicitly.

Use one helper for preflight and invocation environments. Merge the parent environment with invocation overrides, omit undefined values, and treat environment variable names case-insensitively on Windows. Normalize PATH to a single key. Do not mutate `process.env`.

Reject a nonempty `CODEX_API_KEY` in either environment input before constructing the SDK. Remove `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_BASE_URL`, and `CESTDONE_CODEX_HOME` from the child environment. Preserve ordinary PATH, TEMP, SystemRoot, proxy/CA settings, and application variables needed by approved jobs. Map the selected home to child `CODEX_HOME`.

Never pass SDK `apiKey` or `baseUrl`, and do not force `model_provider` or `openai_base_url`. In the failed live attempt, passing the `model_provider: 'openai'` plus `openai_base_url: 'https://api.openai.com/v1'` override pair made the pinned client query the API model endpoint and produced `403 Missing scopes: api.model.read` under a ChatGPT login. The normal ChatGPT-authenticated client may still report its internal provider name as `openai`; that label alone does not mean API billing. Force the ChatGPT login method and ChatGPT endpoint listed in section 6.3 while allowing the authenticated client to retain its normal provider route. Machine/workspace policy can restrict runtime settings; an incompatible enforced policy is a configuration error.

Add shell-environment exclusions for provider authentication variables using the pinned runtime's `shell_environment_policy.filters`. Do not blanket-strip application API keys needed by operational jobs. Do not promise secrecy from an unrestricted agent: it may read local credential files even when environment variables are excluded.

### 5.3 Preflight

Define `PreflightResult` with `ok`, optional sanitized `error` and `errorCategory`, and optional `billingMode`/`runtimeVersion`. Extend backend preflight to accept a context containing cwd and the prepared environment/home, so preflight and invocation cannot disagree about identity.

Run the same native executable with `--version`, then `login status`. Bound each process to 10 seconds with a 64 KiB captured-output limit, consume stdout and stderr, and never print their raw contents. Require exit 0 and an unambiguous `Logged in using ChatGPT` status. API-key, access-token, unauthenticated, unknown, and malformed statuses fail closed. Tests use synthetic outputs, never real tokens.

Check login mode before applying a forced-login restriction to an execution. Official documentation warns that a mismatched forced login method can log the user out; a preflight must not deliberately log out or rewrite a human's cache to reject an unsupported login. Do not read or print `auth.json`, run `logout`, or initiate login automatically.

Check the active backend before the first model call in each attempt. Deduplicate identical runtime/home/environment preflights within an attempt. Recheck the prohibited override variables at invocation. A successful preflight proves local runtime and saved-login mode, not remote account access, remaining allowance, sandbox viability, or MCP availability.

All active preflights must finish successfully before any active role invokes a model. Legacy Claude preflights remain their existing binary/API-key checks; tests must mock them rather than requiring developer credentials.

### 5.4 Service authentication

Direct runs may use their normal saved client login. PM2 runs as Local System and needs an explicit persistent home, such as `C:\ProgramData\cestdone\codex`, supplied through `CESTDONE_CODEX_HOME`. Provision an independent login through the official browser/device flow for the intended ChatGPT account/workspace. Follow workspace credential rules; do not copy the user's desktop auth cache into the service.

Restrict the home ACL to the service identity and provisioning administrator. File credentials must be writable by that identity because Codex refreshes them during normal use. A user keyring entry is not evidence of Local System access. Verify with the exact pinned binary, home, and OS identity. Do not store tokens in PM2 environment or dump files.

The service home should include `forced_login_method = "chatgpt"`; optionally pin `forced_chatgpt_workspace_id` after the operator identifies the intended workspace. The CLI login-status text alone does not prove the same workspace as this session.

Never delete a provisioned auth cache during test cleanup. Session retention is an operational decision, separate from existing `.cestdone` run cleanup. Expired/revoked authentication fails the job; it must never activate API billing. [Saved authentication in CI](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

## 6. Invocation, permissions, and streaming

### 6.1 Backend contract

Extend `Backend` with readonly `provider` and `capabilities`, and forward both through `UsageTrackingBackend`. Keep `name` equal to the existing/new `BackendType`.

```typescript
interface BackendCapabilities {
  resume: boolean
  structuredOutput: boolean
  exactToolAllowlist: boolean
  maxTurns: boolean
  maxBudgetUsd: boolean
  perInvocationMcpConfig: boolean
}

type AccessMode = 'read-only' | 'workspace-write' | 'unrestricted'

// Add to BackendInvocation:
interface InvocationAdditions {
  accessMode: AccessMode
  reasoningEffort?: CodexReasoningEffort
  timeoutMs?: number
}
```

Codex capabilities are true for resume and structuredOutput; false for the other four. Describe existing Claude capabilities from their actual implementations: a denylist is not proof that all inherited MCP tools are excluded.

Keep `tools` as the legacy Claude instruction/restriction field. The Codex adapter does not translate Claude tool names. It obeys the explicit access mode and rejects requirements it cannot enforce.

The factory takes a resolved selection plus prepared runtime context. Instantiate only active backends, lazily importing Codex when selected so missing optional Codex binaries cannot break an unrelated Claude invocation.

### 6.2 Access policy and auto-commit

Use the following mapping for Codex. Every row uses `approvalPolicy: 'never'`; do not fall back to a less restrictive mode after a denial.

| Invocation | AccessMode / SDK sandbox |
|---|---|
| Planning or plan-revision Worker | `unrestricted` / `danger-full-access` |
| Execution Worker | `unrestricted` / `danger-full-access` |
| Analyze Worker | `read-only` / `read-only` |
| Director-only Execute | `unrestricted` / `danger-full-access` |
| Director Review with `autoCommit: true` | `unrestricted` / `danger-full-access` |
| Director Review with `autoCommit: false` | `read-only` / `read-only` |
| Director Complete and other non-execution steps | `read-only` / `read-only` |

This preserves the existing default where the reviewer can commit. `workspace-write` is not sufficient to assume Git commits will work: Codex protects `.git` in its standard workspace sandbox. The implementation must not tell a read-only reviewer to commit. Keep orchestration's existing ownership of plan completion writes. [Sandbox behavior](https://learn.chatgpt.com/docs/agent-approvals-security).

When reviews are active and the Director is Codex, reject `withBashReviews: false` before any model call. The current SDK contract cannot reproduce Claude's Read/Glob/Grep-only restriction. The error should recommend a Claude Director for jobs requiring that exact restriction. Do not reject this combination when a direct job has reviews disabled.

A no-auto-commit Codex review can inspect files, existing test evidence, and diffs; it may be unable to rerun tests that create caches, start services, or need network access. Adjust the review prompt for that access mode: request execution by a Worker using `fix`/`continue` when more evidence is needed. Do not claim a test ran when the sandbox prevented it. This restriction is a deliberate difference from Claude's Bash-enabled no-auto-commit review.

The unrestricted Worker/commit-review mode is chosen for parity with current autonomous jobs, including authorized operations outside the target repository. It grants technical capability, not authorization beyond the job specification. CLI help and README must state it.

Read-only refers to model-executed local filesystem operations. MCP/App servers can have independent side effects; their approval policies are separate and `approvalPolicy: never` can cause those tools to be denied. Do not assert exact tool parity or silently override an administrator's policy to make a job pass.

### 6.3 Runtime configuration

For every Codex invocation, explicitly set:

```typescript
{
  forced_login_method: 'chatgpt',
  chatgpt_base_url: 'https://chatgpt.com/backend-api/',
}
```

A saved ChatGPT login uses the ChatGPT route. Do not pin the API provider or API endpoint: that changes routing rather than merely constraining authentication. Do not expose arbitrary SDK `config` or `configOverrides` through an agent profile.

Use an explicit shell-environment policy with provider-auth filters. Override the complete policy, including an empty `set` map, so inherited `set` values cannot reintroduce excluded keys. Preserve application variables using `inherit: 'all'` and `ignore_default_excludes: true`, then explicitly exclude `CODEX_API_KEY`, `OPENAI_API_KEY`, and `CODEX_ACCESS_TOKEN`. In Codex 0.155.1, `filters` is a TOML map whose pattern keys have `"include"` or `"exclude"` values, not a string array. Set the complete table through one constant raw `configOverrides` entry, `shell_environment_policy={inherit="all",ignore_default_excludes=true,filters={"CODEX_API_KEY"="exclude","OPENAI_API_KEY"="exclude","CODEX_ACCESS_TOKEN"="exclude"},set={}}`, because flattened leaf overrides do not reliably remove inherited sibling fields. Do not interpolate user text into that raw entry. Keep the constant policy in one helper and verify the generated CLI overrides through the real SDK transport test. Do not combine new `filters` with legacy `exclude`/`include_only` in the same policy.

Do not override the selected Codex home's plugins, hooks, notifications, skills, MCP servers, multi-agent settings, or shell-snapshot setting. They remain governed by the user's Codex configuration. This is not a sandbox against a malicious specification, repository, configured integration, or unrestricted shell command.

Pass `BackendInvocation.systemPrompt` as `developer_instructions`; do not replace Codex base instructions or suppress repository rules. Build a Codex client per invocation when configuration differs. Keep the original developer instruction text in private per-thread adapter state and supply the same value on resume; do not append it again to the user prompt or concatenate another copy. Omitted instructions on resume must not accidentally restore different user-home developer instructions.

The adapter's session state belongs to one prepared run, not a global singleton. Key state by thread ID and retain provider, model, cwd, home, original instructions, and last observed usage. Reject an unknown or mismatched resume ID before launching a process. CestDone's `resume` command resumes the plan file and starts new provider sessions; it does not resume an arbitrary old Codex conversation.

### 6.4 Start, resume, and collect

Construct thread options with explicit `model`, `workingDirectory`, `sandboxMode`, `approvalPolicy`, reasoning effort when supplied, and profile web-search mode. Set `threadSource: 'cestdone'` for new threads. Leave `skipGitRepoCheck` false. Pass sandbox options again on resume so a Director execution thread can transition to read-only completion.

Call `startThread(options)` for a fresh invocation or `resumeThread(id, options)` for an in-run continuation. Then:

```typescript
const { events } = await thread.runStreamed(params.prompt, {
  outputSchema: params.outputSchema,
  signal: abortController.signal,
})
for await (const event of events) {
  // Collect state; do not return success before the generator finishes.
}
```

A successful result requires a completed turn, a clean generator exit, and valid final output when a schema is requested. A completed event followed by a child exit error is still a failure. EOF without a completed turn fails. Preserve emitted usage on failures. Distinguish fatal top-level `error` from `item.type === 'error'`, which is documented as nonfatal; do not fail a recovered run because a tool attempt failed.

Capture session ID from `thread.started`, falling back to the known resumed ID only for an already registered thread. Keep the latest completed `agent_message.text` as final output, matching SDK behavior. Reasoning and todo items never replace it.

Deduplicate tool counts by item ID within each invocation, across started/updated/completed events. Count only `command_execution`, `file_change`, `web_search`, and `mcp_tool_call`; map the last to `mcp:<server>/<tool>`. Count one file-change item once, not once per changed file. Reset deduplication for each invocation because item IDs can repeat across resumed processes.

Do not log raw events, stderr, MCP arguments/results, reasoning summaries, or environment maps. Routine logs record type/count/status and safe identifiers. Bound/redact diagnostic messages before sending them to any logger, failure notification, exception, or usage record. Synthetic secret-marker tests must cover verbose output too. Existing prompt/report trace files remain part of cestDone's behavior and can contain job data; they are not a credential store.

### 6.5 Timeouts and unsupported controls

A Codex call uses one AbortController deadline covering generator consumption; clear timers in `finally`. Record actual elapsed wall time. Do not use `Promise.race` to return an ordinary timeout result while a still-running SDK generator is abandoned. Abort, close the iterator, and wait for the SDK process to settle before returning. Add a 10-second cleanup watchdog; only that watchdog may stop waiting and return `cancellation_incomplete`, with the still-running operation explicitly tracked until it settles. A failure to settle is never permission to proceed with an overlapping retry.

The SDK uses a signal to terminate its direct child and does not publicly guarantee that arbitrary detached grandchildren are killed. Do not implement broad process-name killing. Tests must track and clean only their own process tree. If the implementation cannot ensure the Codex execution has stopped, stop processing further jobs in that daemon instance and report the condition rather than launch another attempt. This does not provide rollback of completed external writes.

Codex has no Claude internal `maxTurns` cap. Continue honoring it on Claude roles; log one run-level compatibility message for active Codex roles explaining that their limit is elapsed time. Keep cestDone's existing Worker-review retry/sub-phase caps.

Reject `maxBudgetUsd` for any active Codex role before the first model call. It cannot be enforced by this SDK. `callTimeoutMs` is not a dollar or token budget.

Reject `mcpConfig` for an active Codex Worker before any role invokes a model. Do not ignore it or translate it into TOML. Propagate `mcpConfig` consistently to all Claude planning/revision/execution Workers. An active Claude `agent-sdk` Worker with `mcpConfig` must also report unsupported usage instead of promising Claude CLI's strict server set.

Required native Codex MCP servers must be configured with `required = true` in the appropriate Codex configuration. Optional-server startup failure does not prove the whole job failed; tools required by a specification must be checked during that job's acceptance.

## 7. Structured results and orchestration

### 7.1 Shared schemas and validation

Move shared Director/Worker schemas into `src/shared/output-schemas.ts` to avoid adapter-to-orchestrator import cycles. Use one schema per contract for both providers. Add `ajv@8.17.1` at an exact version for JSON Schema validation rather than treating `JSON.parse` or a TypeScript cast as validation. Its package version was verified in the registry during this review. Do not install the OpenAI API SDK.

Director schema: object, no additional properties, required `action`, `message`, `questions`. `action` retains the existing enum; `message` is string; `questions` is an array of strings or null.

Worker schema: object, no additional properties, required `status`, `summary`, `filesChanged`, `testsRun`, `issues`. Status retains success/partial/failed. Files and issues are arrays of strings or null. `testsRun` is null or an object with no additional properties and required integer, nonnegative `passed`, `failed`, `skipped`.

Example valid wire results:

```json
{
  "action": "done",
  "message": "The requested change and tests are verified.",
  "questions": null
}
```

```json
{
  "status": "success",
  "summary": "Implemented and verified the fixture change.",
  "filesChanged": ["sum.mjs", "sum.test.mjs"],
  "testsRun": {"passed": 2, "failed": 0, "skipped": 0},
  "issues": null
}
```

Normalize nullable fields to existing optional domain fields after validation. Both providers receive the strict schema for new calls. For legacy Claude objects/tests with omitted optional fields, a compatibility normalizer may fill those fields with null before validation; it must not coerce wrong types or invalid enums. Codex responses must satisfy the wire schema directly.

When `outputSchema` exists, validate JSON output against it in the Codex adapter. Invalid JSON, fenced JSON, a refusal without the required object, missing fields, wrong types, or a fabricated enum return `schema_violation`, not successful text. Never search arbitrary prose for a JSON substring.

Schema-free planning remains schema-free. A completed plain-text planning response can be accepted by the existing planning path, which then reads and parses the actual plan file. Do not require a Worker completion envelope for `rawPrompt` calls or accidentally pass the Worker schema to planning.

The schema rules are grounded in the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). Schema compatibility alone is not proof of semantic job completion.

### 7.2 Required orchestration fixes

Replace the Director's raw-text/no-output success fallback with an explicit error. At review, allow only `done`, `fix`, or `continue`; reject other valid schema actions instead of treating them as done. At Complete, require `done` before `writePhaseCompletion()`. Preserve valid legacy Claude behavior; update tests that specifically encoded an unsafe success fallback with an explanatory regression test.

A failed Worker must not advance a planned phase, even when reviews are disabled. A partial execution result is not completion; when reviews are disabled it fails, and when reviews are enabled it can enter the existing review/fix path but cannot itself mark the phase done. Keep schema-free planning's existing acceptance based on a valid plan file.

Consolidate all Worker options through one helper, including initial planning, format revision, human-feedback revision, and escalation revision. Pass selected model/backend, reasoning, timeout, correct access mode, MCP, budget, usage context, and house rules consistently. Count revision calls in the session cost summary as well as the durable ledger.

For planned flows, review and Complete share the Director thread across phases as currently intended. Workers and Worker retries use fresh threads. Direct execution reviews currently start fresh and have no Complete step: preserve this behavior; do not promise a resumed completion call in the direct E2E case.

Director-only planned execution still uses a planning Worker. Test the Execute-to-Complete permission transition on the same Director thread. A later CLI `resume` resolves the current requested profile for remaining plan phases; profile/session snapshots are not persisted into the plan file.

## 8. Usage, billing, and failures

### 8.1 Result metadata

Add the following to `BackendResult` and propagate it through `WorkerResult`, `DirectorCallResult`, cost tracking, and the usage wrapper:

```typescript
type BillingMode = 'subscription' | 'metered' | 'unknown'
type UsageStatus = 'reported' | 'unavailable'

interface UsageMetadata {
  billingMode: BillingMode
  usageStatus: UsageStatus
  reasoningOutputTokens?: number
  errorCategory?: BackendErrorCategory
}
```

Use `subscription` for a Codex call whose saved ChatGPT auth passed preflight. This label describes the access path, not a promise that extra credits are free. `costUsd` remains null; never estimate dollar cost from model names.

Preserve the repository's current Claude CLI subscription convention and Agent SDK metered convention. Do not claim that its existing Claude version-only preflight proves the live account's authentication method. Historical version 1 records lack that evidence too.

Cost displays must distinguish subscription, metered-with-unknown-cost, and unknown billing. Propagate billing mode rather than inferring it from `costUsd === null`. Track known dollar subtotals separately from unknown/subscription calls; never render missing cost as $0.00. Existing numeric `WorkerResult.cost` may remain a compatibility subtotal but must not determine the displayed billing mode.

### 8.2 Cumulative usage and normalization

Keep the five raw Codex counters privately per thread. For a new thread, the baseline is zero. For a resumed thread, subtract the last observed cumulative counters field by field before normalizing the current call. Update the baseline even when output validation fails after usage arrived. Never record the same completed event twice.

Example required fixture:

| Counter | First cumulative result | Second cumulative result | Second call delta |
|---|---:|---:|---:|
| input_tokens | 100 | 160 | 60 |
| cached_input_tokens | 40 | 60 | 20 |
| cache_write_input_tokens | 10 | 20 | 10 |
| output_tokens | 30 | 45 | 15 |
| reasoning_output_tokens | 5 | 8 | 3 |

Normalize the delta into cestDone's mutually exclusive buckets:

```text
cacheReadInputTokens = cached_input_tokens
cacheCreationInputTokens = cache_write_input_tokens
inputTokens = input_tokens - cached_input_tokens - cache_write_input_tokens
outputTokens = output_tokens
reasoningOutputTokens = reasoning_output_tokens
totalProcessedTokens = input_tokens + output_tokens  // raw delta totals
```

The example's second call has 30 uncached input, 20 cache reads, 10 cache writes, 15 output, 3 reasoning output, and 75 processed tokens. Reasoning output is a subset of output; do not add it again. The tagged upstream response-usage fixture has total input 100, cached 40, cache writes 60, output 10, reasoning 5, total 110, confirming these categories belong within input/output totals.

Reject malformed/negative/non-finite counters or a decreasing cumulative baseline as unavailable telemetry; do not clamp them into apparently valid zero usage. Require cached plus cache writes to be at most total input, and reasoning to be at most output. Missing `cache_write_input_tokens` can normalize to zero because the pinned SDK explicitly does this for older event payloads; do not invent other missing required counters.

If a failure has no completed usage event, use zero numeric placeholders with `usageStatus: 'unavailable'`; those zeros are not measured consumption. Mark that thread's baseline unusable and refuse further in-run resume, so later usage is not incorrectly assigned across an unmeasured failure. Fresh job retries create fresh threads.

If a completed event has valid usage but malformed output, record a failed call with reported usage. If usage alone is malformed, preserve the execution result, mark telemetry unavailable, emit a bounded diagnostic, and invalidate further resume for that thread. Do not discard successful prior calls.

Codex `numTurns` means one completed outer SDK turn, not internal model/tool iterations: 1 when a completed event arrived, otherwise 0. Preserve that distinction in report documentation.

### 8.3 Version 2 ledger

Keep the version 1 types and reader intact for old files. Introduce version 2 run/call/snapshot types rather than redefining a type named V1 to mean both. Write new records with `schemaVersion: 2`.

Keep existing call fields and add `provider`, `profile: string | null`, `billingMode`, `usageStatus`, optional `reasoningEffort`, optional `reasoningOutputTokens`, and optional bounded `errorCategory`. Store only known counters/metadata, not raw event objects. Run-level configuration/preflight failures are distinct from call failures.

Normalize V1 in memory as provider Claude, profile null, unchanged backend, unknown billing evidence, and legacy usage quality. Give the aggregator's internal normalized-call type `usageEvidence: 'reported' | 'unavailable' | 'legacy'`: V1 maps to legacy and V2 maps from its `usageStatus`. This internal compatibility field is not an extra value in the V2 backend `UsageStatus` union. Historical nonnegative counts remain usable, but do not claim that a zero on an old failed call proves zero usage. No rewrite or migration of files on disk.

Retain current period attribution: calls by completion time, run counts by start time, end-exclusive intervals. V2 aggregation adds `byProvider`, `byProfile`, `byBillingMode`, and counts for reported, unavailable, and legacy calls. Use a stable `legacy` bucket for null profiles. Keep existing application/invocation/role/backend/model breakdowns.

Only reported/legacy available counters contribute to token sums; expose unavailable-call counts so totals are understood as observed usage. Keep a known-cost subtotal and unknown-cost counts. Update `summarize-cli.ts` types/output and weekly-report specification expectations if they depend on schema version, without running or rescheduling the live report.

The usage wrapper must record a failed/unavailable call if an invoked backend unexpectedly throws. Do not fabricate a call for preflight failure. Ensure a returned failure and a thrown failure cannot cause duplicate recording.

### 8.4 Failure classification and retries

Define a typed `BackendErrorCategory` and a shared error class carrying only sanitized category/message. The SDK's error text is not a guaranteed structured HTTP error. Use conservative message matching with a `process_failed` fallback; do not include full stderr or raw protocol lines in errors.

| Category | Expected handling |
|---|---|
| configuration_error, runtime_missing | Fail before work; no provider fallback. |
| authentication_failed | Fail; no interactive login or API-key fallback. |
| model_unavailable | Fail; preserve the requested model. |
| rate_limited | Fail with a concise message; never switch provider or buy credits. |
| timeout | Abort and settle; usage unavailable unless emitted. |
| schema_violation | Fail the call; no implicit done decision. |
| sandbox_denied | Report the enforced mode; no automatic permission escalation. |
| mcp_initialization_failed | Use only when a required server failure is established. |
| process_failed | Nonzero exit, malformed stream, incomplete turn, unknown SDK error. |
| cancellation_incomplete | Stop this daemon's job dispatch until execution is known to have stopped. |

Do not add automatic replay inside the adapter: a failed call may already have committed or sent an external message. Keep the existing explicitly configured daemon attempt count/delay for settled failures; every retry keeps its job snapshot and reruns preflight. Authentication/model/configuration errors can therefore repeat under an existing retry policy, but the adapter must not claim to have a smarter selective retry mechanism. `cancellation_incomplete` is the exception: do not start the next attempt or job.

Preserve existing failure notifications and queue continuation for ordinary settled failures. Notification tests use a stubbed sender; test success must not depend on real email delivery.

## 9. Implementation sequence

Implement in these stages. Add failing behavior tests before each stage's core changes, then keep the focused suite green. Do not implement production rollout as an implicit final stage.

| Stage | Files and concrete work | Gate |
|---|---|---|
| A. Selection | `src/shared/types.ts`, new `src/shared/agent-selection.ts`, new root validator, `src/shared/config.ts`, CLI option interfaces/actions. | Resolver/validation/CLI forwarding cases in section 10; legacy Claude defaults preserved. |
| B. Runtime adapter | Pin SDK and schema-validator dependencies; new `src/backends/codex-runtime.ts`, `codex-sdk.ts`, environment/auth helpers, factory registration. | Runtime resolution, preflight, real-SDK transport, streaming, schema, timeout, and usage-delta tests. |
| C. Orchestration | `director.ts`, `prompts.ts`, `worker.ts`, `result-parser.ts`, shared schemas, preflight placement, all Worker construction paths. | Mixed-provider flows, autoCommit access policy, strict review/Complete results, planning/revision propagation. |
| D. Daemon | `daemon/types.ts`, `job-queue.ts`, `daemon.ts`, `config-watcher.ts`, `webhook-server.ts`, validator, both CLI and PM2 startup callbacks. | Immutable enqueue/attempt snapshot tests; invalid reload keeps old triggers; callbacks installed for every source; fixture listeners bind only to loopback. |
| E. Accounting | `usage/types.ts`, recorder/wrapper, aggregate, summarize CLI, cost tracker, call/result propagation. | V1+V2 aggregation, cumulative resume, unknown usage/cost, thrown-backend failures. |
| F. Verification and docs | Isolated E2E harness, fixture files, package scripts, README, tracked config example. | Full offline suite/lint/build, then separately identified live fixture evidence. |

Add a narrow environment-file override to the existing CLI bootstrap: `CESTDONE_ENV_FILE` is an absolute replacement path for the installation's `.env`. If set, load only that file and fail clearly if it cannot be read; if unset, preserve the current optional installation-file behavior. This enables an isolated built-CLI test without changing live credentials. Do not add a general-purpose secret loader or vault integration.

Keep imports and configuration resolution testable without starting Commander or PM2. The existing `VITEST` entry-point guard remains; a real child CLI test must omit `VITEST` from its environment.

Use exact dependency versions in the implementation compatibility record. SDK upgrades are separate from global CLI upgrades. Update README with actual cwd lookup, profile examples, precedence, subscription auth, permission limitations, and test commands. Update only relevant tracked example fields; do not copy secret-bearing live config over the mirror.

## 10. Offline test contract

All normal `npm test` tests must run without Codex/Claude login, internet, API keys, or delivery providers. Mock preflight and provider streams at explicit boundaries. Use temporary directories, fake timers where appropriate, and existing Vitest patterns.

### 10.1 Configuration and preparation

Add `tests/agent-selection.test.ts` and root-validator tests covering every row of section 3.3 plus:

- Model selection precedence for each role, including root `opus` plus selected Codex, legacy env plus selected profile, explicit override, and unchanged legacy alias behavior.
- Empty/unknown profile, provider/backend mismatch, invalid reasoning, invalid timeout, malformed profile objects/arrays, and explicit Codex backend without profile.
- New fields round-trip through both real Commander actions. Include `resume --mcp-config` forwarding.
- Config is loaded from cwd when cwd differs from `--target`. All prepared paths resolve predictably and require no process-wide chdir during daemon work.
- Preflight executes before Git initialization, plan mutation, or model work; all active roles pass before any invoke.
- Unused Codex profiles do not load the native runtime. Direct no-review jobs do not require a Director login. Director-only planning does require the Worker.
- Unsupported budget/MCP/no-Bash combinations fail before both provider invocations.
- Explicit `CESTDONE_ENV_FILE` prevents loading installation `.env`; missing explicit file fails; absent override keeps legacy behavior.

### 10.2 Adapter and transport

Add `tests/codex-sdk-backend.test.ts` using synthetic SDK streams for:

- New and resumed calls, role options, developer instructions, schema propagation, and unchanged session identity.
- Last agent message selected; reasoning/todo ignored; tool items counted once; repeated item IDs across separate invocations counted separately.
- Nonfatal item errors versus fatal stream errors; EOF without completion; valid completion followed by process failure; invalid JSON and valid JSON of the wrong schema.
- All five usage counters, cumulative second turn, malformed/decreasing totals, unavailable failure, schema failure with measured usage.
- Timeout during an active generator, iterator cleanup, timer cleanup, cancellation watchdog, no early successful return.
- API override detection before client construction, API-key login rejected, unknown login method rejected, stdout/stderr variants, preflight timeout, bounded output, and redaction.
- Windows mixed-case environment overrides, undefined overlay deletion, PATH/helper injection, spaces and Unicode in paths, explicit native override, version mismatch, unsupported platform, missing optional package.
- No `apiKey`/`baseUrl`, API provider, or API endpoint passed; ChatGPT login routing is forced, configured Codex-home integrations are preserved, and all credential filters are present.

Add a separate transport test importing the real pinned SDK, not a fake `Codex` class. Intercept its `child_process.spawn` import with Vitest and delegate to a real Node fixture process that reads stdin and emits canned JSONL. Intercept only the process launch boundary, leaving SDK serialization, temporary output-schema creation, generator parsing, and AbortSignal handling intact.

The fixture records a safe projection of argv and selected nonsecret environment values; it checks that the schema file exists and contains the expected schema while the SDK process is running. Assert fresh and resume argument ordering, helper PATH, prompt stdin, output-schema cleanup on success/error, nonzero-exit handling, and cancellation. Do not log whole environments or prompts. This catches SDK-wrapper mistakes that mocked `startThread` tests cannot. Derive platform helper-path expectations from the resolver separately: passing an explicit `codexPathOverride` intentionally turns off the SDK's own helper injection.

Resolve/native-layout tests use fixture directory structures and an injected resolver; no global CLI is required in offline tests. A real bundled-runtime/auth/model test belongs to section 11.

### 10.3 Orchestration and daemon

Extend existing integration/direct-execution/director/worker tests. Verify planned flow call order is Planning Worker, Execution Worker, Director Review, Director Complete for a one-phase fixture. Review and Complete share the Director ID; Workers do not. Verify direct skip-planning order is Worker, Review with no plan/Complete. Test Claude/Codex, Codex/Claude, and Codex/Codex.

Exercise planning format revision, human-feedback revision, and Worker fixes. Assert every call has the selected model, role, access policy, timeout, and usage context. Verify `autoCommit: true` review is unrestricted, false review is read-only, and Complete is read-only even after an unrestricted same-thread call.

Add regressions for malformed Director output, invalid review action, failed/partial Worker with no reviews, and Complete action other than done. No case may mark a phase done merely because the model process exited 0.

Daemon tests must enqueue A under config V1, hold its execution, enqueue B, reload to V2, then enqueue C. Verify A and B, including a retry of A, retain V1 model/provider/options while C uses V2. Modify/delete a V1 profile after enqueue to prove the snapshot does not retain a live reference or reread the file.

Exercise schedule, webhook, and poller callbacks individually. Validate bad reload before any stop method is called. Test serialized reload, trigger-start failure reporting/rollback, and the PM2 wrapper's full-config callback without launching a real PM2 daemon. Never import the production wrapper in a way that starts real triggers; use a fixture child with replaced imports or extract shared startup wiring for direct testing.

Add an isolated daemon integration with real temporary file watcher, loopback webhook server, queue, and `handleRun`, using mocked model processes and a stubbed notification sender. Use an ephemeral/free port, a fake webhook secret, empty schedule/poller lists, and private temp PID/log/usage paths. The existing server has no host setting: add an optional webhook `host` field, defaulting to the current bind behavior for compatibility, and set it to `127.0.0.1` in fixtures. Group listeners by host and port and validate both; do not assume POSTing to localhost makes a wildcard listener local-only. Validate profile selection through an actual HTTP request, failed-job notification once, subsequent job completion, and a root default change via in-place config write. Stop the watcher/server/daemon in `finally`.

### 10.4 Usage and regression gates

Add mixed V1/V2 fixtures, separate reported/unavailable/legacy counts, schema rejection cases, and two resumed cumulative usage events whose combined processed total equals the latest thread total. Cover unknown billing, known-cost subtotals, fresh job retry identity, failed invocation with reported tokens, and unexpected thrown backend errors.

Run:

```powershell
npm test
npm run lint
npm run build
```

Inspect failures rather than changing expected values merely to fit Codex. Tests for deliberate changes, such as rejecting malformed Director decisions, must explain that change. Do not run `npm link`, restart PM2, or run a configured production spec to satisfy these gates.

## 11. Real-client E2E harness

### 11.1 Deliverables and launch contract

Implement `scripts/codex-e2e.mjs` and reusable fixtures under `tests/fixtures/codex-e2e/`. Add `npm run test:e2e:codex` to invoke the script. It is opt-in and is not executed by `npm test`.

The harness accepts required `--model <exact-id>` and `--codex-home <absolute-existing-test-home>`, optional `--reasoning <supported-effort>` (default medium), and `--include-claude`. It uses the SDK pin from the built installation, never `npx codex` or the global command. Explicit model/home selection is intentional; do not guess a model from this specification.

Example, after building and provisioning the chosen test home with saved ChatGPT login:

```powershell
npm run test:e2e:codex -- --model <account-supported-model-id> --codex-home <absolute-test-codex-home>
npm run test:e2e:codex -- --model <account-supported-model-id> --codex-home <absolute-test-codex-home> --include-claude
```

Placeholders must be replaced before execution. The first command proves Codex integration; the second additionally proves both real mixed-provider directions. If the optional Claude check is omitted/unavailable, report it as NOT RUN, not passed.

The supplied home is a persistent ChatGPT-authenticated Codex home owned by the invoking OS identity and may be the user's normal interactive home. Preserve its application MCP servers, plugins, hooks, notifications, skills, and other configuration. Preflight must require its ChatGPT login. Do not create an API key, copy desktop credentials, rewrite the home, or delete it in cleanup. If login/account/model/sandbox prerequisites are unavailable, fail the requested live test with a named prerequisite and retain offline results separately.

### 11.2 Isolation and fixture

Use `fs.mkdtemp` under the OS temp directory for each harness run. Create a marker containing a unique test run ID, a fixture Git repo, a separate cwd/config directory, a separate source-spec directory, and private usage/log/output directories. Include spaces and a non-ASCII character in at least one path.

Initialize Git before cestDone runs, with fixture-local author configuration, no remote, and a baseline commit. The fixture includes `.gitignore` for `.cestdone/`, logs, and dependencies. Use only Node built-ins: `sum.mjs`, `sum.test.mjs`, and `node --test`; no network package installation inside model jobs.

Baseline `sum(a, b)` deliberately returns `a - b`. Tests demand 2 + 3 = 5 and -2 + 2 = 0. The operational fixture spec asks the Worker to fix only `sum.mjs`, run tests, write `result.json` in the fixture, and report accurately. The artifact contains the rule marker, house-rules marker, and test outcome; the harness parses it and checks exact marker values. It explicitly forbids external requests, email, pushes, cloud changes, and executing any real configured job.

Put fixture `AGENTS.md` in the fixture repo. Require the result artifact to contain a unique rule marker that is not repeated in the job prompt, proving repository instruction loading. Add a different marker through house rules/developer instructions and assert both. Use unique per-case values so stale artifacts cannot pass.

Use fixture-only `.cestdonerc.json` with all paths absolute, `application: 'codex-e2e'`, `webSearchMode: 'disabled'`, a 180,000 ms call timeout, `nonInteractive: true`, and `autoCommit: false` except the explicit commit case. No production schedules, pollers, notifications, or endpoints are copied.

Spawn the built absolute `dist/cli/index.js` with cwd set to the fixture config directory. Supply `CESTDONE_ENV_FILE` pointing to an empty fixture file, `CESTDONE_CODEX_HOME` pointing to the selected test home, and a minimal child environment that preserves native runtime/OS/user-profile/CA prerequisites without passing production application secrets. Remove `VITEST`, legacy model overrides, and ambient API-key variables. The parent environment is unchanged.

### 11.3 Required live cases

Run cases serially with a 10-minute cap per case and a 45-minute cap for the complete invocation, no automatic rerun of successful side effects, and fresh fixture state per independent case. These caps include child cleanup and also apply when mixed cases are requested. The harness must not pass until it reads back artifacts and usage.

Support `--resume-evidence <failed-report-path>` for a matching model and reasoning effort. Reuse only cases recorded as PASS, identify the source run ID in the combined evidence, and execute the failed and remaining cases. This prevents successful subscription-backed cases from being repeated while still producing one final E1-E10 report.

| ID | Scenario / invocation | Required assertions |
|---|---|---|
| E1 | Both roles Codex: `run --spec <direct-spec> --target <repo> --agent codex --skip-planning --no-auto-commit --non-interactive` | Exit 0; host `node --test` passes; artifact includes both rule markers; no plan file; HEAD unchanged; V2 record has successful Codex Worker and Review, subscription billing, null dollar cost. |
| E2 | Same job with reviews disabled, explicit `--no-with-reviews --no-with-bash-reviews` | Only a Worker model call; no Director preflight/model use; host tests/artifacts correct. Both negated flags are necessary because current Bash-review behavior otherwise implies reviews. |
| E3 | Codex planned run; fixture spec requests exactly two numbered phases | A valid plan exists with both phases done; required output from both phases exists; Planning Worker is schema-free; execution reports and Director results are structured; Director Review/Complete and later phase calls resume correctly; host tests pass. |
| E4 | CestDone `resume` with Codex | Seed a valid plan whose phase 1 is done and phase 2 is pending; invoke the real resume CLI; phase 1 artifact/hash remains unchanged; phase 2 completes; no new planning Worker; requested profile is used. |
| E5 | Codex Director-only planned run | Planning Worker still executes; Director Execute modifies fixture under unrestricted mode; same-thread Complete is read-only; all phases/artifacts/tests pass. |
| E6 | Codex auto-commit review, fixture-only `--auto-commit` | Review can create a commit; inspect HEAD parent, author scope, changed paths, and content; no unrelated fixture sentinel is staged or committed; no push/remote exists. |
| E7 | Default selection | Run without `--agent` against fixture root `defaultAgent: codex`; usage proves Codex. Change default to a second named Codex profile with a different marker/setting and prove the new profile wins; explicit selector still overrides it. |
| E8 | Loopback daemon Codex job | Start an isolated foreground daemon using only fixture webhook configuration; POST once; wait for correlated completed usage/artifact, not just HTTP acceptance; HEAD unchanged; stop daemon and verify PID/listener cleanup. |
| E9 | Auth/control negative cases | API override uses a fake string; missing-login case uses a separate empty temporary home; unsupported MCP/budget cases fail before any artifact/model usage. Do not switch a real auth cache into API mode to test rejection. |
| E10 | Runtime sandbox probe | Through the pinned runtime's local sandbox command or a bounded adapter call, prove a write is denied under read-only. A model merely choosing not to write is insufficient. If a local sandbox probe is unavailable, use a harmless model command that actually attempts the write and inspect denial/tool evidence plus absence of the sentinel. A Windows `helper_unknown_error` or failed sandbox provisioning is `Prerequisite SANDBOX_HELPER`, not a pass; confirm it with `codex doctor --json` and repair the approved client before retrying. |

For E6, the existing generic `git add -A` prompt is unsafe with unrelated dirty files. Update the shared review commit instructions to stage only verified task files and leave pre-existing/unrelated changes untouched. Add an offline prompt regression and a tracked, pre-modified unrelated sentinel in this live fixture. No new host-side auto-commit subsystem is required.

E8 uses an available loopback port, synthetic HMAC secret, private PID/log/usage paths, no live failure recipients, and no schedules/pollers. Send the request to localhost only. Use `host: '127.0.0.1'` on that fixture webhook so the listener is also local-only. A failed job followed by a successful one is mandatory in the offline daemon integration; live fault injection may use a deliberately unavailable model and must be explicitly reported rather than charged repeatedly.

With `--include-claude`, add both Claude Director/Codex Worker and Codex Director/Claude Worker direct fixtures, using `claude-cli` saved subscription login, no Agent SDK/API key. Keep the Claude model explicit in the fixture, sourced from an optional `--claude-model` argument with existing `sonnet` alias default. Assert provider/model attribution per role, host test success, and subscription/null-cost reporting. Failure of an explicitly requested mixed case fails the harness.

### 11.4 Evidence, timeout, and cleanup

Write a machine-readable harness result containing case IDs, pass/fail/NOT RUN status, requested model/reasoning, runtime version, nonsecret auth method, role/profile/backend assertions, artifact hashes, host test exit codes, plan states, fixture commit IDs, and usage totals/data-quality counts. Do not include raw provider output, secrets, full environment, or transcripts.

Do not assert exact token counts in live tests. Assert sane nonnegative counts, no reasoning double-counting, no duplicate ledger calls, and cumulative-delta behavior against two observations from the same live adapter thread. Use the adapter's public normalized results and a safe test-only observer of numeric usage, not session-file scraping. Record that consumption comes from the chosen Codex account allowance.

Set per-case and overall limits, report progress at least every 30 seconds, and terminate only the harness-owned process tree when a case times out. On Windows use verified fixture child PIDs, not image-name matching. A background process that outlives its case is a failed cleanup check.

Stop listeners, watchers, timers, and owned child processes in `finally`. Delete only paths under the exact marker-verified temporary root. On failure, preserve that root for diagnosis and print its path; on success, retain only the small sanitized evidence report at an explicit output path. Never delete a user home, auth file, actual repository, or a supplied Codex home. Do not use global Git config, production usage directories, production PID files, or live daemon cleanup settings.

On Windows, terminating a Node child with `SIGTERM` does not reliably run JavaScript signal handlers. After terminating and verifying the exact harness-owned PID, the harness may remove only that fixture daemon's stale PID file before asserting that its loopback listener is unreachable. It must never remove a production or unverified PID file.

The harness's successful result proves the fixture workflow under its invoking identity. It does not prove PM2 Local System authentication, every production MCP integration, or live job completion.

## 12. Production rollout

Production rollout is a separate authorized task. The implementer should deliver code and test evidence without editing live `.cestdonerc.json`, `.env`, PM2 state, or globally linked CLI state.

For an authorized rollout:

1. Choose exact Codex models/reasoning, intended account/workspace, persistent service home, session retention, and a low-risk canary job. Retain Claude as the default.
2. Provision the dedicated home and verify pinned-runtime auth/version under Local System. Test required sandbox/MCP behavior under that identity. An elevated administrator shell alone is not Local System.
3. Inspect current daemon activity and wait until no job is running. Build and restart using the repository's elevated PM2 procedure with `PM2_HOME=C:\ProgramData\pm2\home`. A rebuild alone does not update the running process.
4. Run only the approved harmless canary under the service identity. Verify output artifact, final job state, profile/model log projection, and usage record.
5. Apply an explicitly selected trigger's `options.agent` to both live config and the tracked mirror. Inspect the full trigger before changing it. Verify expected trigger counts and new selection in daemon logs; use the documented in-place rewrite if the watcher missed an atomic rename.
6. Observe an actual scheduled execution and read back its result. Only then consider an independently requested default change.
7. If reverting the assignment, restore that trigger's prior selection in both files and verify reload. Queued jobs retain their snapshots; changing a default does not retroactively convert queued Codex jobs to Claude.

If queue cancellation or credential provisioning is needed, name it as operational work instead of silently doing it. Never run unrelated configured jobs to demonstrate provider parity.

## 13. Acceptance and handoff

The implementation handoff must report these gates separately:

| Gate | Required evidence |
|---|---|
| Offline implementation complete | Full test suite, lint, and build pass; new unit/integration cases cover selection, transport, snapshot, strict results, permissions, and usage; pre-existing failures identified separately. |
| Codex E2E verified | E1-E10 pass with the real pinned client and saved ChatGPT login; sanitized report retained; fixture cleanup verified. |
| Mixed-provider E2E verified | Both explicitly requested real Claude/Codex directions pass, or are labelled NOT RUN with a concrete reason. |
| Service-ready | Local System runtime/auth/sandbox/MCP checks and approved service canary pass. This gate requires separate rollout scope. |
| Production enabled | Live/tracked config agree, daemon reload/restart read-back succeeds, and the selected real job completes. |

Do not call the feature fully E2E verified when only mocked streams passed. Do not call it deployed when only `dist/` was rebuilt. Keep this specification Proposed/In progress until its implementation acceptance is demonstrated; move it to `zz_Specifications/done/` only according to repository completion policy, with the remaining production status stated explicitly.

The implementation must satisfy configurable default and per-job assignment on all trigger types, unchanged valid legacy Claude behavior, subscription-only Codex authentication, no silent capability downgrades, safe session continuation, correct cumulative usage, and deterministic enqueue snapshots.

Non-goals: Codex cloud jobs, direct OpenAI API orchestration, API-key Codex auth, automatic provider/model failover, automatic Claude MCP translation, Codex subagents, a model-pricing table, changing current real jobs during development, or a new public usage dashboard.

## 14. Evidence and references

Current-state repository evidence was read from `README.md`, `src/shared/{types,config,git,cost-tracker}.ts`, `src/cli/index.ts`, `src/director/{director,prompts,model-selector}.ts`, `src/worker/{worker,permissions,result-parser}.ts`, `src/backends/`, `src/daemon/`, `src/usage/`, `cestdone-pm2.cjs`, and corresponding test files.

Version-specific package evidence inspected during this review:

- Published `@openai/codex-sdk@0.155.1/package.json`: exact `@openai/codex: 0.155.1` dependency.
- Published `dist/index.d.ts`: public constructor/thread/turn/event/usage types.
- Published `dist/index.js`: environment replacement, override ordering, runtime resolution/helper PATH, stdout JSONL iteration, stderr error construction, AbortSignal, and schema-file cleanup. These are version-specific implementation facts, not guaranteed future public APIs.
- Official Codex source tag `rust-v0.155.1`, `codex-rs/exec/src/event_processor_with_jsonl_output.rs`, function `usage_from_last_total()`: `turn.completed` uses thread `usage.total`.
- Same tag, `codex-rs/codex-api/src/sse/responses.rs`, test `parses_cache_write_token_usage`: raw input 100 includes 40 cached and 60 cache writes; total is 110 with 10 output.
- Same tag, `codex-rs/core/src/config/mod.rs`: default ChatGPT backend base URL.
- Global CLI `--version` during review: 0.144.4. This is an audit observation, not the supported feature runtime.

Official documentation:

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk): local thread integration and SDK source links.
- [Authentication](https://learn.chatgpt.com/docs/auth): ChatGPT versus API-key access, cached login, login method/workspace restrictions, and headless login.
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): saved auth, JSONL, schemas, and resume.
- [Account authentication in CI](https://learn.chatgpt.com/docs/auth/ci-cd-auth): persistent auth and runtime-managed refresh.
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): SDK-passed configuration keys, feature switches, shell environment policy, MCP, and routing.
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security): sandbox scope, protected Git paths, approval behavior, and independent tool/network boundaries.
- [Pricing and credits](https://learn.chatgpt.com/docs/pricing): shared allowance and credits; saved login is not a universal zero-cost guarantee.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): required fields, nullable optionals, and closed object schemas.
