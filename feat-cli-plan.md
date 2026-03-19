# Backend Abstraction: Agent SDK + Claude Code CLI

## Goal

Make cestdone configurable so it can use either of two backends:
1. **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — current, uses Anthropic API (paid per token)
2. **Claude Code CLI** (`claude -p`) — headless mode, uses Max/Pro subscription

Director and Worker can use **independent backends** (e.g., Director on `claude-cli`, Worker on `agent-sdk`).
Director and Worker can use **independent models** (e.g., Director with Opus, Worker with Sonnet).

Note: You can see a complementary and similar analysis in `feat-cli-plan-additional.md` that might add some value.
---

## 1. Current Architecture (Agent SDK)

### How cestdone invokes the SDK

Both Director and Worker call `query()` from `@anthropic-ai/claude-agent-sdk`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: "...",
  options: {
    model: "claude-sonnet-4-20250514",
    cwd: "/path/to/repo",
    maxTurns: 15,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools: ['Read', 'Glob', 'Grep'],           // Tool RESTRICTION
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: "custom instructions...",
    },
    outputFormat: {
      type: 'json_schema',
      schema: { /* JSON Schema */ },
    },
    env: { ...process.env },                    // CLAUDECODE stripped
    resume: "session-id",                       // Optional: continue session
    maxBudgetUsd: 5.0,                          // Optional: budget cap
  }
})

for await (const message of q) {
  // message.type: 'system' | 'assistant' | 'result'
  // system → capture session_id
  // assistant → log tool calls and text
  // result → extract structured_output, cost, turns, duration, usage
}
q.close()
```

### Features used by cestdone

| Feature | Director | Worker | Notes |
|---------|----------|-------|-------|
| System prompt (append) | Yes | Yes | Appended to `claude_code` preset |
| Tool restriction (`tools`) | Yes (per step) | Yes (per step) | Physical restriction, not auto-approval |
| Structured JSON output | Yes (`DirectorResponse`) | Yes (`WorkerReport`) | Via `outputFormat.schema` |
| Session resume | Yes (continuous) | No (fresh per phase) | Director threads sessionId across planning + all phases |
| Max turns | Yes (15-20) | Yes (from config) | Per `query()` call |
| Budget limit | No | Yes (optional) | `maxBudgetUsd` |
| Model selection | Yes | Yes | Full model ID |
| Working directory (`cwd`) | Yes | Yes | Target repo path |
| Env stripping | Yes | Yes | `CLAUDECODE` deleted |
| Cost tracking | Yes | Yes | `total_cost_usd` from result |
| Token usage | Yes | Yes | `usage` from result |
| Streaming messages | Yes (logged) | Yes (logged) | `assistant` messages logged during execution |

### Data extracted from SDK result

```typescript
interface SDKResult {
  type: 'result'
  subtype: 'success' | 'error_*'
  structured_output?: object       // JSON schema output
  result?: string                  // Fallback text
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
  session_id?: string              // From system message, not result
}
```

---

## 2. Claude Code CLI (`claude -p`)

### Invocation

```bash
claude -p "prompt text" [flags]
```

Runs non-interactively. Prints response and exits.

### Verified CLI Version: 1.0.102

### Feature Mapping (VERIFIED against v1.0.102)

| cestdone Feature | CLI Equivalent | Status | Verified |
|-----------------|----------------|--------|----------|
| System prompt (append) | `--append-system-prompt "text"` | **Full support** | In `--help` |
| System prompt (replace) | `--system-prompt "text"` | Available | In `--help` |
| Tool restriction (allowlist) | `--tools "Read,Glob,Grep"` | **NOT AVAILABLE in v1.0.102** | `unknown option` error |
| Tool removal (denylist) | `--disallowedTools "Edit" "Bash"` | **Full support** | In `--help`, tested |
| Tool auto-approval | `--allowedTools "Bash(git *)"` | Available | In `--help` |
| Structured JSON output | `--output-format json` | **Full support** | Tested, works |
| Structured JSON **with schema** | `--json-schema '{...}'` | **NOT AVAILABLE in v1.0.102** | `unknown option` error |
| Session resume | `--resume "session-id"` | **Full support** | Tested, confirmed working |
| Max turns | `--max-turns N` | **Accepted** (no error) | Flag accepted, not in `--help` |
| Budget limit | `--max-budget-usd N` | **NOT AVAILABLE in v1.0.102** | `unknown option` error |
| Model selection | `--model "claude-sonnet-4-6"` | **Full support** | In `--help` |
| Working directory | Spawn with `cwd` option | **Workaround** | No `--cwd` flag; use Node.js `spawn({cwd})` |
| Permission bypass | `--dangerously-skip-permissions` | **Full support** | In `--help` |
| Allow permission bypass | `--allow-dangerously-skip-permissions` | **NOT AVAILABLE in v1.0.102** | `unknown option` error |
| Cost tracking | `total_cost_usd` in JSON | **Full support** | Tested: returns dollar amount |
| Token usage | `usage` object in JSON | **Full support** | Tested: full token breakdown |
| Streaming | `--output-format stream-json` | Available | In `--help` |
| Env variables | Inherited from shell | **Full support** | — |
| Permission mode | `--permission-mode "bypassPermissions"` | Available | In `--help` |

### Critical findings

1. **No `--tools` flag**: Cannot whitelist tools. Must use `--disallowedTools` to remove unwanted tools instead.
2. **No `--json-schema` flag**: Cannot enforce structured output via schema. Must rely on prompt engineering + parse `result` field as JSON.
3. **No `--max-budget-usd` flag**: Cannot cap spending per invocation.
4. **No `--allow-dangerously-skip-permissions`**: Use `--permission-mode bypassPermissions` or just `--dangerously-skip-permissions` alone.
5. **`--max-turns` accepted but undocumented**: Not in `--help` but doesn't error. Behavior needs more testing.

### JSON output structure (VERIFIED)

Actual output from `claude -p "..." --output-format json`:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 1692,
  "duration_api_ms": 1633,
  "num_turns": 1,
  "result": "hello world",
  "session_id": "0419d34e-07e4-4478-889e-ea1d58030df1",
  "total_cost_usd": 0.11226225,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 4157,
    "cache_read_input_tokens": 22599,
    "output_tokens": 5,
    "server_tool_use": { "web_search_requests": 0 },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 4157,
      "ephemeral_5m_input_tokens": 0
    }
  },
  "permission_denials": [],
  "uuid": "1da0319d-6009-451e-aa89-17c0c062812e"
}
```

**Key observation**: The JSON output is **identical in structure to the Agent SDK result message**. Fields match 1:1:
- `type`, `subtype`, `result`, `session_id`, `total_cost_usd`, `num_turns`, `duration_ms`, `usage`
- Additional CLI-only fields: `is_error`, `duration_api_ms`, `permission_denials`, `uuid`
- **No `structured_output` field** (since `--json-schema` is unavailable)

### Session resume (VERIFIED)

```
Session 1: "Remember BANANA42" → session_id: c69dadd3-...
Session 2: --resume c69dadd3-... "What was the secret?" → result: "BANANA42" ✅
```

**Important**: Resumed session returns a NEW session_id (`bd94c1dc-...`), not the original.
For Director's continuous session threading, each call returns a new ID to use for the next call.
This matches the Agent SDK behavior.

### Authentication for Max/Pro

Claude Code CLI authenticates via `claude auth login` (OAuth flow). Once authenticated, no API key is needed — it uses the subscription. This is the key cost advantage: **no per-token billing**.

---

## 3. Feature Parity: Agent SDK vs Claude CLI

| Feature | Agent SDK | Claude CLI (v1.0.102) |
|---------|-----------|----------------------|
| **Invocation method** | In-process JS | Child process |
| **System prompt (inline)** | Yes (append to preset) | Yes (`--append-system-prompt`) |
| **Per-tool whitelist** | Yes (`tools: string[]`) | **NO** (`--tools` not available) |
| **Per-tool denylist** | N/A | Yes (`--disallowedTools`) |
| **Schema-enforced output** | Yes (`outputFormat.schema`) | **NO** (`--json-schema` not available) |
| **JSON output** | Yes (structured_output) | Yes (`--output-format json`) |
| **Session resume** | Yes (`resume: sessionId`) | **Yes** (`--resume id`) VERIFIED |
| **Max turns** | Yes (`maxTurns`) | Accepted (undocumented) |
| **Budget limit** | Yes (`maxBudgetUsd`) | **NO** |
| **Model selection** | Yes (Anthropic IDs) | **Yes** (`--model`) |
| **Working directory** | Yes (`cwd`) | No flag (use spawn `cwd`) |
| **Cost in result** | Yes (`total_cost_usd`) | **Yes** (`total_cost_usd`) VERIFIED |
| **Token usage** | Yes (`usage` object) | **Yes** (full breakdown) VERIFIED |
| **Permission bypass** | Yes | **Yes** (`--dangerously-skip-permissions`) |
| **Streaming events** | Yes (async generator) | Yes (`stream-json`) |
| **Auth method** | `ANTHROPIC_API_KEY` | OAuth (subscription) |
| **Billing** | Per-token API | Subscription (Max/Pro) |

---

## 4. Gap Analysis & Workarounds

### 4.1 No `--tools` whitelist (VERIFIED)

**Workaround**: Use `--disallowedTools` to remove unwanted tools (denylist instead of allowlist).

The backend receives the tool whitelist from cestdone and computes the denylist:

```typescript
// All known Claude Code tools
const ALL_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', ...]

// Convert whitelist → denylist
function toDenylist(allowedTools: string[]): string[] {
  return ALL_TOOLS.filter(t => !allowedTools.includes(t))
}
```

Examples:
- **Director read-only**: `--disallowedTools Write Edit MultiEdit Bash`
- **Director review+bash**: `--disallowedTools Write Edit MultiEdit`
- **Worker full**: No restrictions (all tools available by default)

**Impact**: Functionally equivalent. Need to maintain a list of all tool names.

### 4.2 No `--json-schema` (VERIFIED) — HIGHEST RISK

**Workaround**: Instruct the model via prompt to respond with JSON in a specific format. Parse the `result` field.

```typescript
const cliOutput = JSON.parse(stdout)   // Parse CLI JSON envelope
const response = JSON.parse(cliOutput.result)  // Parse inner structured response
```

**Impact**: **Medium-High**. Without schema enforcement, the model may occasionally produce malformed JSON or include preamble text.

**Mitigation strategy**:
1. Strong prompt engineering: "Respond with ONLY valid JSON, no other text"
2. JSON extraction regex as fallback: find first `{` to last `}` in result
3. Retry on parse failure (up to 2 retries)
4. Log warning when extraction regex was needed (indicates prompt drift)

### 4.3 No `--max-budget-usd` (VERIFIED)

**Workaround**: Monitor `total_cost_usd` from each call's result and stop if cumulative cost exceeds threshold.

**Impact**: Acceptable — Max/Pro subscriptions have their own rate limits. Per-call budget isn't critical.

### 4.4 No `--cwd` flag

**Workaround**: Spawn the child process with `cwd` option in Node.js `child_process.spawn()`.

**Impact**: None — Node.js `spawn` supports `cwd` natively.

### 4.5 Strict MCP config to prevent tool leakage

**Problem**: Claude Code may have ambient MCP servers configured by the user (Figma, Playwright, etc.). These inject extra tools into the agent's context, breaking tool restriction assumptions.

**Solution**: Use `--strict-mcp-config` with an empty MCP config:

```bash
echo '{}' > /tmp/empty-mcp.json
claude -p "..." --strict-mcp-config --mcp-config /tmp/empty-mcp.json --disallowedTools Write Edit MultiEdit Bash
```

**Impact**: Critical for deterministic behavior.

### 4.6 Auth guardrail — strip ANTHROPIC_API_KEY

**Problem**: When `claude-cli` backend is selected (for subscription billing), the `ANTHROPIC_API_KEY` env var might cause the CLI to use API billing instead.

**Solution**: When spawning `claude -p`, strip `ANTHROPIC_API_KEY` from the child process environment:

```typescript
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY  // Force subscription billing
delete env.CLAUDECODE         // Existing: prevent Agent SDK conflict
```

Log a warning: "Using claude-cli backend; ANTHROPIC_API_KEY ignored to ensure subscription billing."

---

## 5. Abstraction Layer Design

### Backend interface

```typescript
type BackendType = 'agent-sdk' | 'claude-cli'

interface BackendInvocation {
  prompt: string
  systemPrompt?: string                // Appended to default
  model: string                        // Full model ID or alias
  tools?: string[]                     // Tool restriction (whitelist for SDK, computed to denylist for CLI)
  outputSchema?: object                // JSON Schema for structured output
  cwd: string                          // Working directory
  maxTurns?: number
  maxBudgetUsd?: number                // SDK only; ignored by CLI
  resumeSessionId?: string             // Session to resume
  env?: Record<string, string>         // Environment variables
  logger: SessionLogger
}

interface BackendResult {
  output: unknown                      // Parsed structured output (or raw text)
  rawText?: string                     // Raw text result
  sessionId?: string                   // For session resume
  costUsd: number | null               // null for CLI backends (subscription)
  numTurns: number
  durationMs: number
  usage: TokenUsage
  success: boolean
  errorMessage?: string
}

interface Backend {
  invoke(params: BackendInvocation): Promise<BackendResult>
  preflight(): Promise<{ ok: boolean; error?: string }>
  name: BackendType
}
```

### Backend implementations

1. **AgentSdkBackend**: Wraps current `query()` logic. In-process. Uses `outputFormat.schema` and `tools` whitelist.
2. **ClaudeCliBackend**: Spawns `claude -p` with appropriate flags. Converts tool whitelist to `--disallowedTools` denylist. Parses `result` field as JSON (prompt-engineered structured output). Strips `ANTHROPIC_API_KEY`.

### Config changes

```typescript
interface Config {
  // ... existing fields ...
  directorBackend?: BackendType          // default: 'agent-sdk'
  workerBackend?: BackendType             // default: 'agent-sdk'
  claudeCliPath?: string                 // default: 'claude'
}
```

### CLI flags

```
--backend <type>              # Set both Director and Worker backend (agent-sdk | claude-cli)
--director-backend <type>     # Override Director backend only
--worker-backend <type>        # Override Worker backend only
--claude-cli-path <path>      # Path to claude binary (default: 'claude')
```

Precedence: `--director-backend` / `--worker-backend` override `--backend`.

---

## 6. Independent Model Selection

Director and Worker already support independent model selection via `--director-model` and `--worker-model` flags. This remains unchanged.

### Model aliases for Anthropic backends

Both `agent-sdk` and `claude-cli` use Anthropic model IDs, so the existing alias system works for both:

| Alias | Resolves to |
|-------|-------------|
| `haiku` | `claude-haiku-4-5-20251001` |
| `sonnet` | `claude-sonnet-4-6` |
| `opus` | `claude-opus-4-6` |

Full model IDs are always accepted (e.g., `--director-model claude-opus-4-6`).

### Combined backend + model examples

```bash
# Director with Opus on subscription, Worker with Sonnet on API
cestdone run --spec spec.md \
  --director-backend claude-cli --director-model opus \
  --worker-backend agent-sdk --worker-model sonnet

# Both on subscription, different models
cestdone run --spec spec.md \
  --backend claude-cli \
  --director-model opus --worker-model sonnet

# Default: both on agent-sdk, existing model defaults
cestdone run --spec spec.md
```

---

## 7. Invocation Details: ClaudeCliBackend

### Director invocation (read-only steps)

```bash
claude -p "<prompt with JSON instructions>" \
  --model "claude-opus-4-6" \
  --append-system-prompt "You are a Director AI. Always respond with valid JSON." \
  --disallowedTools Write Edit MultiEdit Bash \
  --output-format json \
  --dangerously-skip-permissions \
  --strict-mcp-config --mcp-config /tmp/empty-mcp.json
```

### Director invocation (review step with bash)

```bash
claude -p "<prompt>" \
  --model "claude-opus-4-6" \
  --append-system-prompt "..." \
  --disallowedTools Write Edit MultiEdit \
  --output-format json \
  --dangerously-skip-permissions \
  --resume "<session-id>" \
  --strict-mcp-config --mcp-config /tmp/empty-mcp.json
```

### Worker invocation (full access)

```bash
claude -p "<prompt with JSON instructions>" \
  --model "claude-sonnet-4-6" \
  --append-system-prompt "You are a Worker AI. Always respond with valid JSON." \
  --output-format json \
  --dangerously-skip-permissions \
  --strict-mcp-config --mcp-config /tmp/empty-mcp.json
```

### Session resume

```bash
# First call — capture session_id from JSON output
result=$(claude -p "Analyze the spec..." --output-format json ...)
session_id=$(echo "$result" | jq -r '.session_id')

# Subsequent call — resume with new session_id
claude -p "Now create the plan..." --resume "$session_id" --output-format json ...
```

Each resumed call returns a **new** session_id. Thread the latest ID to the next call.

### Result parsing

```typescript
function parseCliResult(stdout: string, outputSchema?: object): BackendResult {
  const cliOutput = JSON.parse(stdout)

  let output: unknown = cliOutput.result
  if (outputSchema) {
    // Attempt to parse result as structured JSON
    try {
      output = JSON.parse(cliOutput.result)
    } catch {
      // Fallback: extract JSON from text (find first { to last })
      const match = cliOutput.result.match(/\{[\s\S]*\}/)
      if (match) {
        output = JSON.parse(match[0])
      } else {
        throw new Error(`Failed to parse structured output from CLI result`)
      }
    }
  }

  return {
    output,
    rawText: cliOutput.result,
    sessionId: cliOutput.session_id,
    costUsd: null,  // Subscription-based, no meaningful cost
    numTurns: cliOutput.num_turns ?? 1,
    durationMs: cliOutput.duration_ms ?? 0,
    usage: {
      input_tokens: cliOutput.usage?.input_tokens ?? 0,
      output_tokens: cliOutput.usage?.output_tokens ?? 0,
      cache_read_input_tokens: cliOutput.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: cliOutput.usage?.cache_creation_input_tokens ?? 0,
    },
    success: cliOutput.subtype === 'success',
    errorMessage: cliOutput.subtype !== 'success' ? cliOutput.result : undefined,
  }
}
```

---

## 8. Preflight Checks

Before running, validate the selected backend:

```typescript
// agent-sdk
async preflight(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set' }
  }
  return { ok: true }
}

// claude-cli
async preflight(): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec(`${this.cliPath} --version`)
  } catch {
    return { ok: false, error: `Claude CLI not found at '${this.cliPath}'. Install or set --claude-cli-path` }
  }
  // Optionally check auth status
  return { ok: true }
}
```

---

## 9. Retry Policy

| Class | Examples | Behavior |
|-------|----------|----------|
| Transient | Timeout, rate limit, network error, CLI crash | Retry with backoff: 1s, 2s, 4s (max 3 retries) |
| JSON parse failure | Malformed structured output from CLI | Retry with backoff (up to 2 retries) |
| Persistent | Invalid flags, missing binary, auth failure | Fail immediately with clear error |

---

## 10. Cost Display

- **agent-sdk**: Show dollar cost + tokens (current behavior)
- **claude-cli**: Show tokens only, cost displayed as `N/A (subscription)` — since Max/Pro billing doesn't map to per-call cost

---

## 11. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| No `--json-schema` → unreliable structured output | **High** | Prompt engineering + JSON extraction regex + retry. **Biggest gap.** |
| No `--tools` whitelist | Low | `--disallowedTools` denylist achieves same result |
| Session resume with `--append-system-prompt` behavior | Medium | Needs testing: does resumed session keep original system prompt? |
| `total_cost_usd` on Max/Pro may not reflect real cost | Low | Still reports a value. Show as informational, not billing. |
| `claude` binary not installed or wrong version | Low | Preflight check with clear error message |
| Ambient MCP servers inject unwanted tools | Medium | `--strict-mcp-config --mcp-config '{}'` |

---

## 12. Verification Results (2026-03-04)

### Claude Code CLI (v1.0.102)

| Test | Result | Details |
|------|--------|---------|
| JSON output structure | **PASS** | All fields documented above. Matches Agent SDK exactly. |
| `--json-schema` | **NOT AVAILABLE** | `error: unknown option '--json-schema'` |
| `--tools` | **NOT AVAILABLE** | `error: unknown option '--tools'` |
| `--max-budget-usd` | **NOT AVAILABLE** | `error: unknown option '--max-budget-usd'` |
| `--allow-dangerously-skip-permissions` | **NOT AVAILABLE** | `error: unknown option` |
| `--max-turns` | **ACCEPTED** | No error, but not in `--help`. Behavior unclear. |
| `--disallowedTools` | **PASS** | In `--help`, accepted. Model didn't attempt disallowed tools. |
| Session resume (`--resume`) | **PASS** | Memory preserved. Returns new session_id. |
| `total_cost_usd` in output | **PASS** | Reports dollar amount (e.g., $0.112). |
| `usage` in output | **PASS** | Full breakdown: input/output/cache tokens. |
| `--dangerously-skip-permissions` | **PASS** | In `--help`, works. |
| `--append-system-prompt` | **IN HELP** | Not directly tested but documented. |

### Remaining tests needed before implementation

- [ ] Does `--resume` preserve `--append-system-prompt` from the original session?
- [ ] Can `--disallowedTools` be changed when resuming a session?
- [ ] Does `--max-turns` actually enforce a turn limit?
- [ ] What exit code does Claude CLI return on failure?

---

## 13. Implementation Plan

### Phase 1: Backend interface + AgentSdkBackend (refactor)

1. Define `Backend`, `BackendInvocation`, `BackendResult` types in `src/shared/types.ts`
2. Create `src/backends/agent-sdk.ts` — extract current `query()` logic from `director.ts` and `worker.ts`
3. Create `src/backends/index.ts` — factory function: `createBackend(type, config)`
4. Refactor `director.ts` to use `Backend.invoke()` instead of direct `query()`
5. Refactor `worker.ts` to use `Backend.invoke()` instead of direct `query()`
6. All existing tests must pass unchanged (AgentSdkBackend preserves exact behavior)

### Phase 2: ClaudeCliBackend

1. Create `src/backends/claude-cli.ts`
2. Implement `invoke()`: spawn `claude -p`, map flags, parse JSON output
3. Implement tool whitelist → denylist conversion
4. Implement JSON extraction from `result` field (prompt-engineered structured output)
5. Implement `preflight()`: check binary + auth
6. Strip `ANTHROPIC_API_KEY` and `CLAUDECODE` from env
7. Add `--strict-mcp-config --mcp-config` handling
8. Handle session resume (`--resume`)

### Phase 3: Config + CLI integration

1. Add `directorBackend`, `workerBackend`, `claudeCliPath` to Config type
2. Add CLI flags: `--backend`, `--director-backend`, `--worker-backend`, `--claude-cli-path`
3. Wire backend selection into `director.ts` and `worker.ts`
4. Update `.cestdonerc.json` schema

### Phase 4: Testing

1. Unit tests for ClaudeCliBackend (mock `child_process.spawn`)
2. Integration tests for backend selection
3. Test tool denylist computation
4. Test JSON extraction fallback
5. Test preflight checks
6. Test session resume through CLI backend

### Phase 5: Documentation

1. Update README with backend configuration
2. Document CLI flags and config options

---

## Addendum: Codex CLI (Future)

> This section is deferred. Adding Codex CLI as a third backend is planned for a future iteration.

### Summary

Codex CLI (`codex exec`) enables OpenAI model usage (GPT-4.1, o3, codex-mini) via Plus/Pro subscription. It was verified against v0.107.0 and is feasible but adds significant complexity.

### Key findings (verified 2026-03-04)

- **Structured output**: `--output-schema file.json -o result.json` — PASS (clean JSON in `-o` file)
- **Session resume**: `codex exec resume <thread_id>` — PASS (reuses same thread_id, unlike Claude CLI)
- **Sandbox**: `--sandbox read-only` — PASS (blocks writes). `workspace-write` — **BROKEN on Windows** (behaves as read-only; need `--dangerously-bypass-approvals-and-sandbox`)
- **Invalid resume ID**: Silently creates new thread with exit 0 — **DANGEROUS**, need thread-id equality guard
- **No system prompt flag**: Must embed in prompt string
- **No max turns / budget limit**: Must monitor JSONL events and kill process
- **No dollar cost**: Token counts only; must calculate from pricing
- **Different tool ecosystem**: Shell commands, not Claude Code tool names
- **JSONL streaming**: Must parse event stream for session ID and usage data

### What the Backend interface needs for Codex

The current `Backend` interface is designed to be extensible. Adding Codex would require:

```typescript
type BackendType = 'agent-sdk' | 'claude-cli' | 'codex-cli'  // Add codex-cli

interface Config {
  // ... add ...
  codexCliPath?: string     // default: 'codex'
}
```

Plus a new `CodexCliBackend` implementation handling JSONL parsing, temp file management for schemas, platform-aware sandbox selection, and thread-id equality guards.

### Estimated additional effort

| Component | Effort |
|-----------|--------|
| CodexCliBackend implementation | Medium-Large |
| JSONL parser for Codex events | Medium |
| Platform-aware sandbox logic | Small |
| Thread-id equality guard | Small |
| Codex-specific prompt adaptation | Medium (if universal prompts don't work) |
| Tests | Large |
