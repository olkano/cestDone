# cestdone Orchestrator v1 — Post-Mortem Analysis

**Run date:** 2026-02-14
**Task:** Build a web dashboard scraping itmplatform.com metrics (Express + TypeScript)
**Spec:** ~3 sentences, one-shot build from empty repo

---

## 1. Run Summary

| Metric | Value |
|--------|-------|
| Total time | 59.9 min |
| Total cost | $6.81 |
| Phases | 4 (all completed successfully) |
| Files created | 26 (7,216 lines) |
| Tests | 35 passing |
| Director calls | 12 (182 turns) |
| Coder calls | 4 (237 turns) |
| Total tool invocations | 410 |

## 2. Where the Time Went

```
Coder (actual coding):     37.6 min  (63%)
Director overhead:         22.2 min  (37%)
  - Planning flow:          3.4 min  ( 6%)
  - Reviews:              ~14   min  (23%)
  - Completion summaries:  ~5   min  ( 8%)
```

### Per-Phase Breakdown

| Phase | Coder Time | Coder Cost | Review Cost | Total Phase Time |
|-------|-----------|------------|-------------|-----------------|
| 1. Project Setup | 6m 9s | $0.64 | $0.33 | 10.2 min |
| 2. Metrics Service | 11m 58s | $1.86 | $0.51 | 16.1 min |
| 3. Dashboard Frontend | 7m 9s | $0.60 | $0.52 | 11.5 min |
| 4. Integration Tests | 12m 23s | $1.62 | $0.55 | 16.5 min |

## 3. What Went Wrong (Waste Analysis)

### 3.1 Director Reviews: The #1 Cost Center

Each Director review (step 5) is a **full independent `query()` session** that must:
1. Re-read every file the Coder touched (no memory from prior calls)
2. Run `npm test` again (Coder already verified)
3. Run `tsc --noEmit` again (Coder already verified)
4. Start a server and curl endpoints (functional verification)
5. Fight port conflicts, kill zombie processes
6. Commit the changes
7. Produce a structured output response

**Result:** 4 reviews consumed $1.76 and ~14 minutes — nearly as much as 2 Coder phases.

Phase 2 review hit `error_max_turns` (31 turns exhausted) without producing structured output, defaulting to "done" — meaning the review was **wasted entirely**.

### 3.2 Port Conflict Chaos

Both Coder and Director try to start dev servers on port 3333:
- **7 port conflict incidents** throughout the run
- **17 process kill attempts** (mix of `taskkill`, `pkill`, `kill`)
- **20 server start attempts** total (many failed or redundant)

Neither agent reliably cleans up background processes. Windows makes this worse (`taskkill` syntax vs Unix `kill`).

### 3.3 Redundant File Reading

Due to no message accumulation (each Director call is fresh):
- **32 redundant Director file reads** — the same files read over and over
- The "Complete" step (step 8) reads the entire project again just to produce a 10-line summary
- Director reads `test-spec.plan.md` ~8 times, `app.ts` ~6 times, `package.json` ~5 times

### 3.4 Completion Summaries (Step 8): Low-Value Work

After each phase, a Director call writes a "Done summary" into the plan file. This:
- Costs ~$0.08 per phase ($0.32 total)
- Takes ~2 minutes per phase (~8 minutes total)
- Re-reads the entire codebase to generate a paragraph
- Adds no value for the Coder (which gets the summary in its next prompt anyway)

### 3.5 Test Runner Left in Watch Mode

`npm test` (Vitest default) runs in watch mode. Both agents repeatedly:
- Start watch mode, wait 2+ minutes for it to stabilize
- Read background task output files to get results
- Then need to kill the process

`npm run test -- --run` (single run) would save ~2 minutes per invocation. This happened **8+ times**.

## 4. What Went Right

### 4.1 The Output is Solid

The delivered project is genuinely well-structured:
- **Clean architecture**: Separate services, utils, types — proper separation of concerns
- **TypeScript strictness**: All types clean, no `any` abuse (except one fallback in `createErrorMetric`)
- **Error resilience**: `Promise.allSettled()` ensures partial failures don't crash the dashboard
- **Proper testing**: 35 tests including unit, integration, and resilience tests
- **Professional frontend**: 667-line responsive HTML dashboard with CSS variables, loading states, error handling
- **Documentation**: 442-line README with API docs, deployment guide, troubleshooting

### 4.2 Phased Delivery Worked

Each phase built cleanly on the previous one:
- Phase 1 → working Express server with tests
- Phase 2 → metrics collection with full error handling
- Phase 3 → dashboard frontend consuming the API
- Phase 4 → integration tests + documentation

Git history is clean: 4 commits, one per phase, each passing tests.

### 4.3 House Rules Were Followed

The Coder adhered to every house rule:
- POSIX path comments at top of every file
- Pino logger (not console.log)
- Vitest for tests
- Clean Code principles
- `tsc --noEmit` clean
- No dead code

### 4.4 Planning Flow Was Efficient

The planning phase (Analyze → Clarify → CreatePlan → Approve) took only 3.4 minutes and $0.18. The clarification questions were relevant (snapshot vs real-time, storage, refresh strategy). Plan revision after user feedback ("add .env with PORT=3333") was quick.

## 5. Comparison: Orchestrator vs Direct Claude Code

| | Orchestrator | Direct (estimated) |
|---|---|---|
| Time | 60 min | ~6 min |
| Cost | $6.81 | ~$0.50-1.00 |
| Quality controls | Automated reviews | Manual review |
| Git history | 4 clean commits | Likely 1 commit |
| Plan artifact | `.plan.md` with status tracking | None |
| House rules enforcement | Systematic | Best-effort |
| Error handling | Coder retry on `fix` | Manual iteration |

**The orchestrator is 10x slower and 7-9x more expensive** for this task, but produces more structured output with automated QA.

### Is It Worth It?

For this specific task (small greenfield project), **no**. The overhead dominates. A human using Claude Code directly could have done this in one session with similar quality.

The orchestrator's value proposition should emerge with:
- **Larger projects** where phased delivery prevents context overflow
- **Teams** where the plan artifact enables async review/approval
- **Complex specs** where clarification rounds prevent building the wrong thing
- **Compliance contexts** where automated review trails matter

## 6. Optimization Recommendations

### High Impact (save 50%+ of overhead)

1. **Eliminate or drastically simplify Director reviews**
   - Option A: Trust Coder self-report (tests pass + tsc clean = done)
   - Option B: Lightweight review — only run tests, skip functional verification
   - Option C: Review only on Coder failure/partial status
   - Savings: ~$1.76 and ~14 min

2. **Kill the Completion Summary step**
   - The Coder already reports what it did. Director can extract the summary from the Coder report.
   - Write a template-based summary instead of an LLM call.
   - Savings: ~$0.32 and ~8 min

3. **Force `vitest run` (not watch mode)**
   - In Coder and Director prompts, always use `npm run test -- --run`
   - Savings: ~2 min per invocation × 8 = ~16 min

### Medium Impact

4. **Fix port management**
   - Use random ports for functional testing (already done in integration tests!)
   - Add `process.exit()` cleanup to dev server
   - Or skip functional verification entirely (see #1)

5. **Pass Coder report to Director review as context**
   - Avoids Director re-reading every file from scratch
   - Could include a file manifest with checksums

6. **Merge small phases**
   - Phase 3 (Dashboard) found that `/api/metrics` was already built in Phase 2
   - The Coder noted "The /api/metrics endpoint was already implemented in previous phases"
   - 3 phases would have been enough: Setup, Core+API, Frontend+Tests

### Lower Impact

7. **Cache Director's project understanding between calls**
   - Pass a condensed project state (file tree + key contents) instead of letting Director re-explore

8. **Use Haiku for completion summaries**
   - If we keep step 8, use a cheaper/faster model for summary generation

## 7. Bottom Line

The orchestrator **works** — it delivered a functional, well-tested project from a 3-sentence spec. But the overhead model (Director reviews, completion summaries, stateless re-exploration) is designed for large, high-stakes projects. On a small task like this, it's like using a crane to move a couch.

**Next step:** Implement recommendations #1-3, re-run the same spec, and compare. Target: under 20 minutes and under $3.
