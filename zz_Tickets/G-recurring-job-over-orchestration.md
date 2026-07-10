# G. Recurring jobs duplicate pre-defined steps into expensive generated plans

**Status**: FIXED for the observed over-orchestration and overlap failures. Optional job-specific validation and runtime budgets remain open.
**Priority**: High. The current flow wastes subscription capacity, greatly increases runtime, and can turn an incomplete scan into a misleading zero-result run.
**Date**: 2026-07-10
**Reporter**: observed in the Olkano `internet-listening-scan` recurring job

---

## Summary

The recurring job specification already defines an ordered seven-step workflow, but cestDone first asks a Planning Worker to convert that workflow into a separate seven-phase plan. It then runs every generated phase through a Worker, a Director review, and a Director completion call.

For implementation specifications this planning layer can be useful because the model must discover how to decompose an open-ended change. For a recurring operational specification whose control flow is already explicit, it duplicates work and introduces additional failure modes.

The July 8 run took 59m 38s and made 23 sequential Claude calls. Only 4m 25s were spent in the search phase, and that phase stopped after 4 of the required 8 to 12 searches. Almost 30 additional minutes were then spent processing later phases using incomplete search data.

## What "the steps are already defined" means

The steps are defined in the input specification, which is included in the Planning Worker's prompt:

`C:/Users/dpire/Code/olkano/Marketing/zz_Specifications/recurring_cron_tasks/internet-listening-scan.md`

That file contains these headings under `## Steps`:

1. `Load context`
2. `Pick today's theme (rotate by weekday, UTC)`
3. `Search (8 to 12 web searches, then open candidate pages)`
4. `Quality bar (all five must hold)`
5. `Update the control list (always, even on zero-lead days)`
6. `Send the email (only when at least one lead was accepted)`
7. `Commit`

Each heading contains concrete requirements, inputs, commands, output formats, and branching rules. For example:

- The context files are named explicitly.
- The weekday-to-theme mapping is complete.
- The search count is fixed at 8 to 12.
- The five acceptance criteria are enumerated.
- The only writable files and their formats are specified.
- The email condition and command are specified.
- The exact files to commit and commit-message format are specified.

"Deterministic" refers to this control flow: the same ordered operations and checks apply on every run. It does not mean the web search results or accepted leads are predetermined. Those outcomes still require tools and model judgment.

The Planning Worker therefore does not discover a new decomposition. It mostly rewrites the seven existing `### N` sections as seven `## Phase N` sections in `.cestdone/internet-listening-scan.plan.md`.

## Evidence from the 2026-07-08 run

Run log:

`C:/Users/dpire/Code/olkano/.cestdone/internet-listening-scan_2026-07-08_040000/internet-listening-scan_2026-07-08_040000.log`

### Runtime by activity

| Activity | Duration | Worker turns | Tool calls |
|---|---:|---:|---:|
| Initial plan generation | 10m 10s | 47 | 20 |
| Plan correction | 1m 10s | 6 | 2 |
| Phase 1: load context | 11m 03s | 40 | 17 |
| Phase 2: choose theme | 1m 51s | 10 | 4 |
| Phase 3: search | 4m 25s | 24 | 10 |
| Phase 4: quality bar | 13m 42s | 39 | 15 |
| Phase 5: update control list | 9m 42s | 32 | 12 |
| Phase 6: conditional email | 4m 23s | 19 | 7 |
| Phase 7: commit | 1m 47s | 7 | 2 |
| Fourteen Director calls | 1m 25s | quota-blocked | 0 |
| **Total** | **59m 38s** | | |

The nine Worker calls consumed about 58 minutes. File reads and shell tools generally completed in under a second; most latency came from model round trips between tools, commonly 40 to 90 seconds each.

The run reported 2,509,300 Worker input/cache-read tokens and only 2,700 output tokens. The input figure is aggregate cache reading across many agent turns, not 2.5 million unique prompt tokens, but it still represents substantial repeated context processing and subscription usage.

This was not an isolated slow run. The successful July 7 06:49 run took 1h 38m 37s and reported 2,818,300 Worker input/cache-read tokens.

## Correctness failure during the run

Phase 3 was required to run 8 to 12 searches, open candidates, verify them, and filter them. It actually ran four `WebSearch` calls and returned:

```json
{
  "status": "partial",
  "summary": "Completed 4 of 8-12 WebSearch queries... Need to run 4+ more searches, verify with curl, filter exclusions..."
}
```

At that point the Director was over its usage limit. Claude CLI returned:

```text
Claude AI usage limit reached|0
```

The Claude CLI version used at the time labeled this result with a success subtype. The old cestDone backend accepted it as success, and the Director response fallback advanced the phase as `done`.

Consequences:

1. Phase 3 was marked complete despite failing its explicit search-count and verification requirements.
2. Phase 4 saw no completed shortlist and converted the incomplete scan into a zero-lead day.
3. Phase 4 performed work assigned to Phase 5, updated `scan-log.md`, and created commit `02cf66a`.
4. Phases 5 and 6 spent more time verifying and documenting the manufactured zero-lead state.
5. Phase 7 found a clean working tree and failed because the earlier phase had already committed.
6. Director completion summaries containing the quota message contaminated the "Previously Completed Phases" context supplied to later Workers.

The job therefore consumed almost an hour while failing to complete its primary purpose.

## Current status

### Already fixed or mitigated

1. **Usage-limit results now fail correctly.** `parseCliResult()` and `parseStreamResultEvent()` in `src/backends/claude-cli.ts` explicitly classify results beginning with `Claude AI usage limit reached` as failures even when Claude CLI reports a success subtype. Regression tests cover the pipe-suffixed and plain variants.

2. **Recent quota failures stop quickly.** The July 9 and July 10 scheduled runs failed in approximately 13 to 18 seconds instead of continuing through all phases.

3. **The scheduled job now selects Sonnet for both roles.** The current `.cestdonerc.json` sets `directorModel: "sonnet"` and `workerModel: "sonnet"` for `internet-listening-scan`. The July 8 run used Opus 4.7 for Workers.

4. **The daemon is pinned to the current user-scoped Claude CLI.** `.cestdonerc.json` now sets `claudeCliPath` to `C:/Users/dpire/AppData/Roaming/npm/claude.cmd`, avoiding the stale system-wide Claude Code 1.0.102 installation.

5. **Direct execution is implemented.** `cestdone run --skip-planning` sends the complete specification to one Worker without creating or reading a plan file. A successful Worker can receive one final Director review. `partial`, `failed`, or a non-`done` review fails the complete job.

6. **The Olkano scan opts into direct execution.** Its daemon schedule sets `skipPlanning: true`, so future runs use one Worker call and at most one Director call.

7. **Date and weekday are deterministic in direct mode.** cestDone injects an authoritative UTC date and weekday into the Worker instructions and explicitly tells the Worker not to recalculate them.

8. **Overlapping runs are rejected.** `handleRun` atomically acquires a per-target, per-spec lock under `.cestdone/locks`. Normal completion releases it; a lock older than six hours is treated as abandoned. A fresh lock is not discarded merely because a wrapper process disappeared, since its Claude child may still be running.

9. **Tool calls are counted by the backend.** Both Claude CLI and Agent SDK backends count streamed tool-use events by name. The counts propagate through `WorkerResult` and appear in the Worker log, so requirements such as the number of `WebSearch` calls can be audited without trusting model prose.

10. **The overlapping July 10 runs were reconciled.** The first manual invocation outlived its timed-out shell wrapper. A retry then ran concurrently, producing one valid lead in each run. Both leads and commits were preserved, and commit `c0b8ed4` added the missing second scan-log row: 14 searches/1 lead/email sent for the first run and 12 searches/1 lead/no second email for the overlapping retry.

11. **Claude CLI now enforces structured completion output.** Historical successful jobs returned JSON completion envelopes even when their work products were Markdown. The July 10 server-health validation instead returned only a Markdown report, so strict direct mode correctly classified it as `partial`. Schema-bearing CLI calls now use native `--json-schema`; schema-free calls are unchanged. The current Windows npm wrapper is resolved to `claude.exe` so JSON arguments bypass `cmd.exe` quote mangling.

### Validation run on 2026-07-10

The manual `--skip-planning` validation reduced orchestration to one Worker call. The monitored retry ran for 10m 37s, used 52 turns, and emitted 12 `WebSearch` calls before returning `partial`; strict direct mode correctly failed the job before the optional Director review. This confirmed the intended fail-closed behavior, while also exposing the wrong weekday calculation and overlapping-wrapper hazards now addressed above.

The first direct `daily-server-health` validation ran for 4m 10s and completed all operational checks with 12 Bash and 5 Read calls. The server was healthy and no alert was sent, but the run failed closed because its final Markdown report lacked the JSON completion envelope. This became the regression case for native CLI schema enforcement.

After the fix, the complete Worker-plus-Director cycle passed in 5m 09s. The Worker used native `StructuredOutput` and returned `success`; the Director independently used `StructuredOutput` and returned `done`. The CLI exited 0, the run lock was released, PM2 remained healthy, no alert was sent, and no pre-existing repository changes were committed.

### Still open

1. Planned mode still uses one Worker, one Director review, and one Director completion call per generated phase. This remains appropriate for open-ended implementation specs but expensive for jobs that do not opt into direct execution.
2. The default Worker limit is 100 turns. Direct jobs can override it with `maxTurns`, but no separate direct-mode default is enforced.
3. Tool calls are now measured authoritatively, but there is no configurable machine check for job-specific requirements such as `WebSearch` calls between 8 and 12.
4. Duration and call-count budgets are not implemented.

## Suggested changes

### 1. Add a direct execution mode for structured recurring jobs

Implemented as a CLI flag and configuration option:

```json
{
  "skipPlanning": true
}
```

With `--skip-planning`, cestDone skips plan generation and gives one Worker the full operational specification. The Worker executes the fixed workflow and returns one structured report.

Planning should remain the default for open-ended development specifications. Direct mode should be opt-in initially rather than inferred solely from numbered headings.

### 2. Reduce the recurring scan to one Worker and at most one Director call

Recommended flow:

```text
full recurring spec
  -> Worker: load context, search, verify, filter, update, conditionally email, commit
  -> Director: one final compliance review
  -> success or failure
```

If one Worker call is too large, use two coarse phases rather than seven:

1. Research: load context, select theme, run searches, verify candidates, apply quality bar.
2. Finalize: update files, conditionally email, commit, and validate artifacts.

### 3. Treat `partial` as unfinished by construction

A Worker result with `status: "partial"` must never advance to the next phase. It should either:

- resume the same Worker session until success,
- retry the same phase within a configured bound, or
- fail the complete job.

This rule should not depend on a Director interpreting free-form content correctly.

### 4. Add machine-verifiable phase completion checks

For recurring tasks, allow the specification or schedule to declare measurable invariants, for example:

```json
{
  "requiredMetrics": {
    "searchesRun": { "min": 8, "max": 12 }
  }
}
```

At minimum, the Worker report schema could include `searchesRun`, `pagesOpened`, `leadsAccepted`, `emailSent`, and `commitCreated`. The orchestrator should reject internally inconsistent outcomes, such as `status: success` with fewer than eight searches.

### 5. Lower turn limits for operational jobs

Use a Worker turn limit around 20 to 30 for this job, with a bounded resume only when the report is legitimately partial. Planning and context-loading calls should not be allowed to consume 40 to 47 turns.

### 6. Remove redundant artifacts and completion calls

For direct recurring jobs:

- write one run report instead of one report per phase,
- avoid rewriting `cestdone-diff.txt` in every phase,
- remove the separate Director completion-summary call after every review,
- preserve one final summary at the end.

### 7. Add timing and usage budgets

Support optional job budgets such as:

```json
{
  "maxDurationMinutes": 20,
  "maxCalls": 4
}
```

On budget exhaustion, stop and notify with the incomplete phase and measured progress. Do not synthesize a zero-result outcome.

## Expected outcome

For `internet-listening-scan`, a reasonable target is approximately 5 to 15 minutes depending on search and page-fetch latency, with one or two Worker calls and at most one Director review. A zero-lead result is valid only after the required searches and verification steps actually complete.

## Acceptance criteria

- [x] A structured recurring job can opt out of plan generation.
- [x] The Olkano scan uses one direct Worker call and at most one Director review.
- [x] A `partial` Worker result fails direct execution and cannot advance.
- [x] A quota/backend failure terminates the run and sends a failure notification.
- The run verifies that 8 to 12 searches completed before accepting a zero-lead result.
- [x] Per-run logs report tool-call counts, duration, model, turns, and aggregate token usage.
- A representative zero-lead scan completes within 20 minutes under normal service conditions.

## Related ticket

- `zz_Tickets/done/F-plan-status-parse-skips-execution.md`: a separate plan-parser failure in which generated plan-format drift caused all phases to be silently treated as done. Together, the tickets show that generated plans add both latency and correctness risk for workflows whose steps are already explicit.
