# F. Job plans successfully but skips ALL phase execution ("All phases complete" with 0 phases run)

**Status**: OPEN, needs fix
**Priority**: High. Causes silent no-op "success": a scheduled job reports completion having done nothing, no error, no failure email.
**Date**: 2026-07-07
**Reporter**: observed while building the olkano `internet-listening-scan` job

---

## Symptom

A daemon/CLI run completes the planning stage, prints `All phases complete.`, and exits successfully, but **not a single phase was executed**. No search, no file writes, no commit, no email. Total worker output for the whole run was 112 tokens (just the planning summary), and wall time was entirely consumed by planning.

This is worse than a hard failure: `notifyJobFailure()` never fires (the run "succeeded"), so the operator gets no signal. For a daily job it looks like a normal zero-result day.

It is **intermittent**: an earlier run of the exact same spec executed all phases correctly. The trigger is the plan format the Planning/Revision Worker happens to emit (see Root Cause).

## Evidence

Two runs of the same spec (`olkano/Marketing/zz_Specifications/recurring_cron_tasks/internet-listening-scan.md`), same command:

```
cestdone run --spec <spec> --target C:/Users/dpire/Code/olkano --director-model sonnet --non-interactive
```

### Run A (BROKEN, 2026-07-07 09:41): planned, executed 0 phases

```
Director: Planning Worker completed (cost: $0.00)
Director: Plan format invalid (attempt 1/3): No "# Plan:" heading found in plan file. Spawning Revision Worker.
Worker: Call starting (step: 7, model: claude-opus-4-7, phase: 0)
CLI: Tool: Read(...\internet-listening-scan.plan.md)
CLI: Tool: Edit(...\internet-listening-scan.plan.md)
Worker: Call completed (cost: $0.00, turns: 5, duration: 1m 1s)
Director: Plan at ...\internet-listening-scan.plan.md with 7 phases
                                    <-- no "=== Phase 1 ===" ever printed
All phases complete.
Session: === Final Summary ===
Total time: 10m 37s
Worker    — $0.00 | tokens: 312.9K in, 112 out
```

The plan file left on disk after this run had all 7 phases in this shape:

```
## Phase 1: Load context
### Status
pending
### Spec
...
### Done
(pending)
```

### Run B (WORKED, 2026-07-07 06:49): same spec, executed all phases

```
Director: Plan format invalid (attempt 1/3): Invalid status "todo" in Phase 1. Must start with one of: pending, in-progress, done. Spawning Revision Worker.
...
=== Phase 1: Determine theme and load seeds ===
=== Phase 2: Run searches and fetch candidates ===
...
All phases complete.
```

In Run B the worker had emitted `### Status: todo` (inline), the parser recognized it as a status heading and threw a clear error, the Revision Worker changed `todo` to a valid value **in the same inline format**, and execution proceeded.

## Root Cause

Deterministic, in [src/shared/plan-parser.ts](src/shared/plan-parser.ts) `extractPhases()`, lines 102-117:

```typescript
const statusSub = subsections.find(s => s.heading.startsWith('Status:'))
let status: PhaseStatus
if (statusSub) {
  const rawStatus = statusSub.heading.replace('Status:', '').trim()
  const statusToken = rawStatus.match(/^(pending|in-progress|done)\b/)?.[1] as PhaseStatus | undefined
  if (!statusToken) {
    throw new Error(`Invalid status "${rawStatus}" in Phase ${phaseNum}. ...`)
  }
  status = statusToken
} else {
  const doneSub = subsections.find(s => s.heading === 'Done')
  const doneContent = doneSub ? doneSub.content.join('\n').trim() : ''
  status = doneContent && doneContent !== '_(to be filled)_' ? 'done' : 'pending'
}
```

The parser expects the status **inline in the H3 heading**: `### Status: pending`. That is what `PLAN_FORMAT_TEMPLATE` mandates ([src/director/prompts.ts:253](src/director/prompts.ts#L253)).

In Run A the worker instead wrote the status as a **plain heading with the value on the next line**:

```
### Status
pending
```

Here `section.heading` is `"Status"`, not `"Status: pending"`, so `s.heading.startsWith('Status:')` is **false**. `statusSub` is `undefined`, so control falls to the `else` branch, which infers the status from the `### Done` content:

- The worker filled `### Done` with `(pending)` instead of the exact placeholder `_(to be filled)_`.
- `doneContent = "(pending)"` is non-empty AND not equal to `_(to be filled)_`.
- Therefore `status = 'done'`.

**Every phase is silently parsed as `done`.** The plan still parses without error and reports "7 phases" (the count comes from the `## Phase N:` headings), which is why the Director logs `Plan at ... with 7 phases`.

Then in [src/cli/index.ts:242-247](src/cli/index.ts#L242) `executeAllPhases()`:

```typescript
const next = plan.phases.find(p => p.status === 'pending' || p.status === 'in-progress')
if (!next) break                       // <-- all 7 are 'done', so break immediately
...
deps.display('\nAll phases complete.')  // <-- prints success, 0 phases run
```

`next` is `undefined`, the loop breaks on the first iteration, and it prints `All phases complete.` having done nothing.

### Why it is intermittent

The Planning/Revision Worker is an LLM and does not always follow `PLAN_FORMAT_TEMPLATE` exactly. Two observed deviations from the same spec:

- `### Status: todo` inline (Run B): parser catches it, throws a validation error, Revision Worker fixes it inline, execution proceeds. Safe failure.
- `### Status` + value on next line, plus `### Done: (pending)` (Run A): parser silently infers `done`, execution is skipped. Silent failure.

So plan-format drift by the worker is the trigger, and the parser's fallback turns one drift variant into a silent all-done plan.

### Secondary symptom (also in Run A)

The first validation error was `No "# Plan:" heading found in plan file` ([src/shared/plan-parser.ts:15-18](src/shared/plan-parser.ts#L15)), yet the Revision Worker reported the `# Plan:` heading was already present on line 1, and the subsequent parse found it. This looks like either a transient read (plan file parsed before the Planning Worker finished flushing it) or another heading-detection edge case. Lower priority than the status bug but worth a look while in this code.

## Suggested fixes (defense in depth)

1. **Harden the parser status detection** ([plan-parser.ts:102-117](src/shared/plan-parser.ts#L102)). Accept both `### Status: <value>` (inline) and a `### Status` heading whose first content line is the value. Only then fall back to Done-inference.

2. **Make the Done-inference fallback safe.** Inferring `done` from any non-empty `### Done` content is dangerous: `(pending)`, `TBD`, `n/a` all read as done. Treat a phase as `done` only on an explicit status token, or restrict the fallback to recognize placeholder-like values (`_(to be filled)_`, `(pending)`, empty, `TBD`) as NOT done. When status cannot be determined, default to `pending`, never `done`.

3. **Guard the executor against a zero-runnable-phase plan** ([cli/index.ts:242](src/cli/index.ts#L242)). If a freshly created plan has phases but none are `pending`/`in-progress` on the very first pass, that is almost certainly a parse problem, not a completed job. Fail loudly (or re-plan) instead of printing `All phases complete.` For a brand-new run, "0 phases executed" should never be reported as success.

4. **Validate the plan the Revision Worker returns**, not just the Planning Worker's. Re-run the same format validation after revision so a revision that fixes the heading but leaves a bad status format is rejected too.

## Reproduction

1. Create any multi-phase spec and run `cestdone run --spec <spec> --target <repo> --non-interactive`.
2. To force it deterministically, write `.cestdone/<spec>.plan.md` by hand with valid `# Plan:` + `## Phase N:` headings but format each status as:
   ```
   ### Status
   pending
   ### Done
   (pending)
   ```
   (no `### Spec`/`### Done` omissions, so it parses) and run. Every phase parses as `done`; the run prints `All phases complete.` and executes nothing.

## Workaround (operator side, already applied for the olkano job)

Delete any leftover `.cestdone/<spec>.plan.md` before a run so a half-written plan is not reused, and re-run. Recovery is not guaranteed because the trigger is worker plan-format drift, not the stale file.
