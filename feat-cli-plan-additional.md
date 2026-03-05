# cfeat-cli-plan-additional.md (by CODEX)

Generated: 2026-03-04
Updated: 2026-03-04 (Claude-first scope)
Status: Draft v3

## 1. Scope (Now)

Implement only one new backend now: `claude-cli`.

Current delivery target:

1. keep existing `anthropic-sdk` path working
2. add `claude-cli` backend
3. do not implement `codex-cli` yet (tracked in addendum)

## 2. Required Behavior

## 2.1 Independent model control per role

Must remain supported for Claude runs:

1. Director model configurable independently
2. Coder model configurable independently

Examples that must work:

1. `--director-model opus --coder-model sonnet`
2. full model IDs also accepted

Model resolution for Claude backend:

1. aliases (`haiku`, `sonnet`, `opus`) remain supported
2. full Claude model IDs pass through

## 2.2 Session behavior

1. Director keeps continuous session across planning + execution
2. Coder uses fresh session per phase

For `claude-cli` specifically:

1. resume with `-r`
2. always store latest returned `session_id` (rolling id behavior)

## 2.3 Tool restriction behavior

Match current logical tool profiles via Claude CLI deny-list strategy:

1. use strict empty MCP config by default
2. enforce step-specific `--disallowed-tools` lists

## 2.4 Cost display

When backend is `claude-cli`:

1. show cost as `N/A` (subscription-backed mode target)
2. keep token usage when present

## 3. Verified Claude CLI Constraints (v1.0.102)

1. `--output-format json` works
2. `--resume` works, but returned session id rolls
3. `--disallowedTools` / `--disallowed-tools` usable
4. `--json-schema` not available
5. `--max-budget-usd` not available
6. `--max-turns` accepted in practice, undocumented

Implication for structured outputs:

1. enforce JSON contract via prompt
2. parse `result` payload
3. retry on malformed JSON

## 4. Architecture (Claude-First)

Introduce backend abstraction, but implement only two backends now:

1. `AnthropicSdkBackend` (existing logic extracted)
2. `ClaudeCliBackend` (new)

Conceptual interface:

```ts
interface AgentBackend {
  runTurn(input: BackendTurnInput): Promise<BackendTurnResult>
}
```

`BackendTurnInput` must include:

1. role (`director` or `coder`)
2. step
3. prompt
4. system prompt text
5. model
6. cwd
7. tool profile
8. resume ref

`BackendTurnResult` must include:

1. parsed response text/object
2. latest resume ref
3. usage and timing
4. backend error details when failed

## 5. Configuration and CLI (Now)

To reduce current complexity, backend selection is shared for both roles in this phase.

Config keys:

```json
{
  "agentBackend": "anthropic-sdk | claude-cli",
  "claudeCliPath": "claude",
  "claudeStrictMcp": true
}
```

Environment keys:

1. `CESTDONE_AGENT_BACKEND`
2. `CESTDONE_CLAUDE_CLI_PATH`

CLI flags:

1. `--agent-backend <anthropic-sdk|claude-cli>`
2. `--claude-cli-path <path>`
3. existing `--director-model` and `--coder-model` unchanged

Precedence:

1. CLI flags
2. `.cestdonerc.json`
3. environment variables
4. defaults

## 6. Claude Backend Execution Rules

## 6.1 Command construction

Use `claude -p` with:

1. `--output-format json`
2. `--model <resolved-model>`
3. `--append-system-prompt <text>` for fresh sessions
4. `-r <session_id>` for resumed sessions
5. strict MCP empty config flags when enabled
6. step-specific `--disallowed-tools`

Spawn process with `cwd` set to target repo.

## 6.2 Environment sanitization

For `claude-cli` child process:

1. remove `ANTHROPIC_API_KEY`
2. remove `CLAUDECODE`

## 6.3 Structured output parsing

Because schema flag is unavailable:

1. instruct model to return JSON only
2. parse outer CLI JSON
3. parse inner `result` as JSON
4. on parse failure, retry with repair prompt (max 2 retries)

## 6.4 Error handling

Retry transient CLI failures with exponential backoff:

1. retries: 3
2. delays: 1s, 2s, 4s
3. persistent failures escalate immediately

## 7. Implementation Plan

## Iteration 1: backend extraction

1. extract current SDK calls into `AnthropicSdkBackend`
2. keep behavior unchanged
3. run full test suite

## Iteration 2: backend wiring + model guarantees

1. add shared `agentBackend` selection
2. preserve independent `directorModel` and `coderModel` handling
3. validate `--director-model opus --coder-model sonnet` path

## Iteration 3: Claude CLI backend

1. implement command runner and parsers
2. implement deny-list tool mapping by step
3. implement rolling session id handling
4. implement env sanitization and retry policy

## Iteration 4: tests + docs

1. unit tests for command assembly and parsing
2. integration tests with mocked process output
3. README updates for Claude CLI backend usage and limitations

## 8. Test Checklist (Now)

1. Director flow works end-to-end with `claude-cli`
2. Coder flow works end-to-end with `claude-cli`
3. model split works (`opus` director, `sonnet` coder)
4. malformed JSON from model triggers repair path
5. resume continuity works across multiple Director turns
6. tool restrictions by step are correctly enforced in command args

## 9. Risks (Now)

1. malformed structured JSON due no schema flag
   Mitigation: strict JSON prompt + repair retry

2. CLI version drift
   Mitigation: startup capability checks from `claude --help`

3. session-id handling mistakes
   Mitigation: always persist latest returned id after each call

## 10. Addendum: Codex Backend (Future Phase)

Deferred until Claude-first rollout is stable.

Future phase scope:

1. add `codex-cli` backend implementation
2. move backend selection from shared (`agentBackend`) to per-role (`directorBackend` / `coderBackend`) if needed
3. implement `thread_id` resume guard (invalid resume can silently start new thread)
4. parse structured results via `--output-schema` + `-o` file
5. apply platform sandbox policy (Windows write path via `danger-full-access`)

## 11. Source Links

1. https://code.claude.com/docs/en/headless
2. https://code.claude.com/docs/en/cli-reference
3. https://code.claude.com/docs/en/settings
4. https://developers.openai.com/codex/cli/
5. https://developers.openai.com/codex/noninteractive/
6. https://developers.openai.com/codex/cli/reference/
7. https://developers.openai.com/codex/config-reference/

---

End of draft v3.
