<!-- docs/prompt-too-long-analysis.md -->
# "Prompt is too long" Incident Analysis

Incident date: 2026-03-05
Log file: `logs/debuggins-specs_2026-03-05_132238.log`
Spec: `debuggins-specs.md` against ITM Platform codebase

## Timeline

1. **Step 1 (Analyze)** — 101 turns, ~55 files read. Director explored the ITM Platform codebase (Read, Glob, Grep). Completed at 13:24:24. Session context reached ~64K tokens (`cache-r:63619 cache-w:3858`). Response action: `analyze` (no questions → Clarify step skipped).

2. **Step 3 (CreatePlan)** — Resumed session `f6715442...` (64K+ cached context). Instead of returning a plan, the Director:
   - Called `ExitPlanMode` (a Claude Code internal tool — not ours)
   - Spawned 5 `Task` subagents for parallel deep research
   - Subagents collectively ran 200+ tool calls (Reads, Greps, Globs)
   - Attempted `Write` (blocked by denylist) to write DEBUGGING.md directly
   - After 234 turns total, returned DEBUGGING.md content in message instead of a plan

3. **Fix loop** — Response had no `# Plan:` heading → plan validation failed → asked Director to fix → same bloated session → "Prompt is too long" returned as `subtype: 'success'` → `extractDirectorResponse` treated it as `{ action: 'analyze', message: 'Prompt is too long' }` → plan validation failed again → loop repeated **30+ times** (turns 236→294+) until manually killed.

## Root Causes

### A. Internal Claude Code tools leaked through the denylist

`ALL_CLAUDE_CODE_TOOLS` only listed standard tools (Read, Write, Edit, etc.). Claude Code has internal tools (`ExitPlanMode`, `EnterPlanMode`, `Task`/`Agent`, `AskUserQuestion`, `TodoWrite`, `TodoRead`) that were not in the denylist. The Director used `ExitPlanMode` and `Task` as escape hatches to go off-script.

### B. Continuous session amplified context exhaustion

Each resumed call inherits ALL prior context. By CreatePlan: 101 turns of file contents from Analyze + 234 turns of rogue subagent exploration = 335 turns. Irrecoverable.

### C. "Prompt is too long" was treated as success

The CLI returned `subtype: 'success'` with `result: 'Prompt is too long'`. Our code treated it as valid output, passed it to plan parser, which couldn't find `# Plan:` heading.

### D. Plan fix loop had no retry cap

The `while (true)` validation loop in `runPlanningFlow` had no `MAX_PLAN_FIX_ATTEMPTS`. Each fix attempt resumed the bloated session, got "Prompt is too long" again, and looped forever.

### E. Director tried to do the Coder's job

The CreatePlan prompt said "create a plan" but the Director interpreted this as "do the work" — reading 200+ more files and trying to write DEBUGGING.md directly.

## Fixes Applied

| Fix | File | Status |
|-----|------|--------|
| MAX_PLAN_FIX_ATTEMPTS = 3 | `director.ts` | Done |
| "Prompt is too long" → `success: false` | `claude-cli.ts` | Done |
| Block internal tools (ExitPlanMode, Task, Agent, etc.) | `claude-cli.ts` | **This PR** |
| Strengthen CreatePlan prompt (no tools, no subagents) | `prompts.ts` | **This PR** |

## Follow-up Validation Run (same day)

Validation log: `logs/debuggins-specs_2026-03-05_152219.log`

### What improved

- Run completed end-to-end in **25m30s** (8 phases) with no infinite loop.
- No `"Prompt is too long"` terminal failure appeared.
- No internal Claude Code tools (`Task`, `Agent`, `ExitPlanMode`, etc.) were invoked.
- CreatePlan behaved as intended (returned a plan and execution proceeded normally).

### What is still weak

1. **Review contract is not enforced hard enough**
   - All review calls returned `action=analyze` instead of `fix|continue|done`.
   - Runtime accepted this anyway via: `Review returned 'analyze' — treating as done`.
   - Result: phases advanced even when review text explicitly said issues were still present.

2. **Review can still mutate files through Bash**
   - During review, Director executed:
     - `git checkout -- debuggins-specs.md`
     - `echo. >> DEBUGGING.md`
     - `printf '\n' >> DEBUGGING.md`
   - This bypasses "read-only review intent" and risks destructive/unexpected changes.

3. **"Done" does not enforce a commit or clean state**
   - Prompts ask reviewer to commit when correct, but flow does not hard-check for a commit.
   - In practice, work can be marked done while staying uncommitted.

4. **Quality gate allowed known incorrect guidance through**
   - Review flagged a wrong query field (`time`) for `logapismateritems`, but pipeline still closed phases.
   - Final `DEBUGGING.md` still contains `db.logapismateritems.find({time:{$gt:5000}})...`.

5. **`analyze_run.py` is fragile for zero-cost Claude CLI runs**
   - Script crashes with `ZeroDivisionError` when total cost is `$0.00`.
   - This blocks analysis for subscription-backed runs where cost may be zero in logs.

## Recommended Fixes (for remaining weak points)

| Weak point | Suggested fix | Why this is recommended |
|---|---|---|
| Review action drift (`analyze` accepted) | In `executeTwoAgentPhase`, accept only `fix`, `continue`, `done` for review. If action is anything else, issue one "format-repair" retry; if still invalid, force `fix` and loop back to Coder. | Prevents silent false positives where unresolved issues are marked complete. |
| Review side effects via Bash | Default `withBashReviews` to `false`. If Bash is needed, enforce a read-only command allowlist (`git diff`, `cat`, `ls`, `rg`, etc.) and block write/destructive commands (`checkout`, redirection, `rm`, etc.). | Keeps review non-destructive and aligned with "verification only". |
| No commit enforcement | Add a completion gate: capture `HEAD` before phase, require `HEAD` to change (or explicit "no-commit mode"), and require clean working tree for phase-touched files before setting phase `done`. | Aligns actual state with declared workflow guarantees ("done and committed"). |
| Incorrect facts can pass review | Extend review schema with structured findings (`blockingIssues[]`). Require `done` only when `blockingIssues.length === 0`; otherwise reject with `fix`. | Converts qualitative review text into enforceable control flow. |
| Analyzer crash on zero-cost totals | In `analyze_run.py`, guard all `%` and ratio divisions by `total > 0`, and make phase-count calculations dynamic instead of hardcoded `/4`. | Makes run analysis reliable across CLI modes and different phase counts. |

## Future Considerations

- **Break session for CreatePlan**: Start fresh session, pass only Analyze summary. Eliminates context bloat. Bigger architectural change — deferred.
- **Cap Analyze turns**: Investigate why 101 turns ran when `maxTurns: 50` was set (subagent turns may inflate count). Consider separate `analyzeMaxTurns` config.
- **Use allowlist instead of denylist**: If CLI supports `--allowedTools Read Glob Grep`, that's more robust than blocking tools one by one.
