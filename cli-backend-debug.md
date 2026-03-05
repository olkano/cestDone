# CLI Backend Debug Summary (2026-03-04)

## Goal
Spawn `claude` CLI as a child process from cestdone to use Max/Pro subscription billing.

## RESOLVED: Basic spawn works (all 4 modes ~3s)
- `node cli.js` + stdio=inherit: works (3s)
- `node cli.js` + pipe + close stdin: works (3.1s)
- `claude.cmd` + shell:true + stdio=inherit: works (3s)
- `claude.cmd` + shell:true + pipe: works (3.4s)

## User environment
- No ANTHROPIC_API_KEY — uses OAuth subscription auth
- No CLAUDECODE env var (running from PowerShell, not inside Claude Code)
- ANTHROPIC_MODEL=claude-opus-4-6
- claude version 1.0.102, auth working

## Still broken: cestdone's full invocation hangs
The spawn works with simple flags (`-p "hello" --output-format json --max-turns 1`).
It hangs when cestdone adds its full flag set. Suspect flags:
- `--dangerously-skip-permissions`
- `--strict-mcp-config --mcp-config <empty.json>`
- `--disallowedTools Write Edit MultiEdit Bash ...` (10 tools)
- `--append-system-prompt <very long multiline string with JSON schema>`
- `--model claude-opus-4-6` (slower model)

## Next step
Create test 5-8 in test-cli-spawn.cjs that add flags incrementally to find which one causes the hang. Start with `--dangerously-skip-permissions`, then add `--model`, then `--append-system-prompt`, then `--disallowedTools`, then `--strict-mcp-config`.

## Code state
- `src/backends/claude-cli.ts`: has resolveCmd() for .cmd bypass, spawn with heartbeat, buildEnv inherits process.env
- `tests/claude-cli-backend.test.ts`: 33 tests, all mocked spawn, all pass
- Full suite: 324 tests pass, tsc clean
- Key: buildEnv strips ANTHROPIC_API_KEY + CLAUDECODE, inherits process.env
