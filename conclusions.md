# cestdone Orchestrator — Post-Mortem Analysis

---

# PART 1: V1 RUN (Sonnet, 2026-02-14)

**Setup:** Sonnet (Director + Coder) | 3-sentence spec → Express+TS dashboard scraping itmplatform.com | One-shot from empty repo

## 1. V1 Run Summary

| Metric | Value |
|--------|-------|
| Total time / cost | 59.9 min / $6.81 |
| Phases | 4 (all completed) |
| Output | 26 files (7,216 lines), 35 tests passing |
| Director / Coder calls | 12 (182 turns) / 4 (237 turns), 410 tool invocations |

**Time split:** Coder 37.6 min (63%) · Director overhead 22.2 min (37%): planning 3.4 min, reviews ~14 min, completion summaries ~5 min

| Phase | Coder Time | Coder Cost | Review Cost | Total |
|-------|-----------|------------|-------------|-------|
| 1. Project Setup | 6m 9s | $0.64 | $0.33 | 10.2 min |
| 2. Metrics Service | 11m 58s | $1.86 | $0.51 | 16.1 min |
| 3. Dashboard Frontend | 7m 9s | $0.60 | $0.52 | 11.5 min |
| 4. Integration Tests | 12m 23s | $1.62 | $0.55 | 16.5 min |

## 2. V1 Waste Analysis

**Director Reviews (#1 cost center):** Each review is a fresh `query()` session — re-reads all files, re-runs tests + tsc, starts servers, fights port conflicts, commits, produces structured output. 4 reviews = $1.76, ~14 min. Phase 2 review hit `error_max_turns` (31 turns) without structured output — entirely wasted.

**Port conflicts:** 7 incidents, 17 process kill attempts, 20 server start attempts. Neither agent reliably cleans up. Windows `taskkill` vs Unix `kill` adds friction.

**Redundant file reads:** 32 redundant Director reads (no message accumulation). `test-spec.plan.md` read ~8×, `app.ts` ~6×, `package.json` ~5×.

**Completion summaries:** ~$0.32 and ~8 min total for low-value paragraph summaries that re-read the entire codebase.

**Watch mode:** Vitest defaulted to watch mode 8+ times. ~2 min wasted per invocation waiting for stabilization + process cleanup.

## 3. V1 What Went Right

- **Solid output:** Clean architecture, strict TypeScript, `Promise.allSettled()` resilience, 35 tests, 667-line responsive dashboard, 442-line README
- **Phased delivery worked:** 4 clean git commits, each phase built on the previous, all tests passing
- **House rules followed:** POSIX path comments, Pino logger, Vitest, Clean Code, `tsc --noEmit` clean
- **Efficient planning:** Analyze→Clarify→CreatePlan→Approve in 3.4 min / $0.18

## 4. V1 Code Quality: 6.5/10

**Good:** Clean factory-based architecture, `strict: true` TS config, `Promise.allSettled()`, 35 tests, signal handling, Pino logging.

**Bugs found:**
1. **XSS (Critical)** — HTTP headers/SEO metadata injected via `innerHTML` without sanitization
2. **Regex bug (Medium)** — Broken character class in HTML parser; fails on many real pages
3. **3 redundant HTTP requests** — Same URL fetched separately by availability, performance, and SEO collectors
4. **MetricsCollector instantiated per request** — No caching; concurrent visitors hammer target
5. **Unsafe type assertions** — `any` return types and `as Record<string, string>` on headers

**Missing:** Rate limiting, caching, CORS, helmet, input validation, ESLint, IPv6 DNS, SSL chain validation. Integration tests hit real endpoints (flaky in CI).

| Category | Score |
|----------|-------|
| Architecture | 8/10 |
| Type Safety | 6/10 |
| Security | 4/10 |
| Error Handling | 7/10 |
| Test Quality | 6/10 |
| Performance | 5/10 |
| Production Readiness | 5/10 |

## 5. V1 vs Direct Claude Code

| | Orchestrator | Direct (est.) |
|---|---|---|
| Time / Cost | 60 min / $6.81 | ~6 min / ~$0.50-1.00 |
| Tradeoff | Automated QA, 4 clean commits, plan artifact, house rules enforcement | Manual review, likely 1 commit |

**10× slower, 7-9× more expensive** for this small task. Value proposition emerges with larger projects, team workflows, complex specs, or compliance contexts.

## 6. V1 Optimization Recommendations

**High impact:**
1. Eliminate/simplify Director reviews (trust Coder self-report or lightweight diff-only) → ~$1.50 / ~12 min saved
2. Kill Completion Summary step → ~$0.32 / ~8 min saved
3. Force `vitest run` (not watch mode) → ~16 min saved

**Medium:** Fix port management (random ports), pass Coder report to Director as context, merge small phases (3 would suffice)

**Lower:** Cache Director project state, use Haiku for summaries

---

# BRIDGE: Optimizations Applied (2026-02-16)

### Round 1 — Session Resumption
Director maintains continuous conversation via `resume: sessionId`. Coder stays fresh per phase.

### Round 2 — Lightweight Reviews + Environment
- Review prompt: "Coder already ran tests — do NOT re-run." Diff-based review only.
- Non-interactive test mode for both agents
- `detectEnvironment()` utility injected: OS, shell, package manager, kill syntax
- Explicit cleanup instructions; review max turns 30→20

**Target:** ~25-30 min / ~$4-5 (from 59.9 min / $6.81)

---

# PART 2: V2 RUN (Haiku + Optimizations, 2026-02-16)

**Setup:** Haiku 4.5 (both agents) | Same task | All bridge optimizations applied

## 7. V2 Run Summary

| Metric | V1 (Sonnet) | V2 (Haiku) | Change |
|--------|-------------|------------|--------|
| Time / Cost | 59.9 min / $6.81 | **24.0 min / $3.13** | **-60% / -54%** |
| Phases | 4 | 5 | +1 |
| Output | 26 files, 7,216 lines | 20 files, 2,258 lines | Smaller scope |
| Tests | 35 | 28 | -7 |
| Planning | 3.4 min / $0.18 | 2.6 min / $0.07 | -24% / -61% |
| Reviews | ~14 min / $1.76 | ~5 min / $0.84 | -64% / -52% |
| Summaries | ~8 min / $0.32 | ~48s / $0.38 | **-90% time** |

Cost split: Director $1.48 (47%) · Coder $1.65 (53%)

| Phase | Coder Time | Coder Cost | Review Cost | Total |
|-------|-----------|------------|-------------|-------|
| 1. Project Setup | 1m 28s | $0.13 | $0.13 (max_turns!) | ~2m 38s |
| 2. Metric Collection (+fix) | 3m 44s | $0.42 | $0.27 | ~5m 48s |
| 3. Dashboard Route & HTML | 2m 13s | $0.28 | $0.20 | ~3m 16s |
| 4. Integration & Hardening | 3m 01s | $0.40 | $0.25 | ~4m 33s |
| 5. Final Review & Acceptance | 4m 16s | $0.42 | $0.19 | ~5m 25s |

**Key:** Phase 2 review caught a real bug (`https : https` ternary) — justifies the review step. Phase 1 review hit `error_max_turns` (over-verification). Phase 5 was new (README + docs).

## 8. Optimization Results

| Optimization | Result | Detail |
|---|---|---|
| Session resumption | **Partial** | Major reduction vs V1's 32 redundant reads, but Haiku still re-reads files within the same review call |
| Lightweight reviews | **Failed** | Haiku violated "do NOT re-run tests" in **every review** (7 test runs, 9+ build/type-check runs) |
| Functional testing | **Appropriate** | Done only for endpoint-delivering phases; 4 failed server starts in Phase 3 (shell syntax) |
| Port conflicts | **Much improved** | 7→1 incidents, 17→5 kill attempts |
| Watch mode | **Solved** | Zero incidents |
| Completion summaries | **Dramatic** | ~2 min→~10 sec per summary (session context eliminates re-reading) |

## 9. V2 New Waste

- **Redundant test runs:** ~15 unnecessary re-runs across both agents (~45-60s wasted)
- **MEMORY.md writes:** Coder wrote to `.claude/projects/` in Phases 2-4 — not in spec, wastes turns
- **Unnecessary files:** `PHASE2-REVIEW.md`, `PHASE5-REVIEW.md` created autonomously

## 10. V2 Code Quality: 6.5/10

**Good:** Strategy-pattern collectors, `escapeHtml()` applied consistently (**fixes V1 XSS**), cheerio for HTML parsing (**fixes V1 regex bug**), all tests properly mocked (**fixes V1 flaky tests**), house rules compliant, graceful shutdown.

**Bugs found:**
1. **DNS timeout dead code (Medium)** — `AbortController` signal never passed to `resolve4()`
2. **Protocol always HTTP (Low)** — `domain.startsWith('https://')` always false since domain has no protocol prefix
3. **Socket leak (Low)** — Response body not consumed/destroyed in performance collector
4. **2× `any` in production** — `MetricResult<any>` and `(res.socket as any)`

| Category | V1 | V2 | Notes |
|----------|----|----|-------|
| Architecture | 8/10 | 7/10 | 463-line God file in dashboard.ts |
| Type Safety | 6/10 | 8/10 | Only 2 `any` in prod |
| Security | 4/10 | 4/10 | XSS fixed, but still no helmet/rate-limit/CSP |
| Error Handling | 7/10 | 7/10 | DNS timeout broken |
| Test Quality | 6/10 | 7/10 | All mocked, no flaky network tests |
| Performance | 5/10 | 5/10 | No caching/compression |
| Production Readiness | 5/10 | 5/10 | Same gaps |

Same 6.5/10 score but **better bug profile**: V1 had critical XSS + flaky tests; V2 has non-functional DNS timeout + protocol inconsistency (lower severity).

## 11. Haiku vs Sonnet Comparison

| Dimension | Haiku | Sonnet |
|-----------|-------|--------|
| Speed | **2.5× faster** (24 vs 60 min) | — |
| Cost | **2.2× cheaper** ($3.13 vs $6.81) | — |
| Security fixes | XSS fixed, tests mocked, no regex bugs | Had critical XSS, flaky tests |
| Instruction compliance | **Poor** — ignored review constraints every time | Baseline |
| Output scope | 2,258 lines, 28 tests | 7,216 lines, 35 tests |
| Architecture | 463-line God file | Better separation |
| Unnecessary artifacts | MEMORY.md, PHASE*-REVIEW.md | None |

**Verdict:** Haiku = **good Coder** (fast, cheap, functional, follows house rules) · **poor Director** (ignores complex conditional instructions). Sonnet needed for orchestration.

## 12. Overall Bottom Line

| | V1 (Sonnet) | V2 (Haiku + opts) | Target |
|---|---|---|---|
| Time | 59.9 min | **24.0 min** | < 20 min |
| Cost | $6.81 | **$3.13** | < $3 |
| Quality | 6.5/10 | 6.5/10 | 7+/10 |
| Instruction compliance | Baseline | Partial (Coder ✓, Director ✗) | Full |

Optimizations clearly worked: session resumption saved ~7 min on summaries, watch mode solved, port conflicts 7→1, reviews -64% time / -52% cost. Remaining overhead dominated by Haiku Director ignoring "no re-testing."

## 13. Next Steps

1. **Split models:** Sonnet Director + Haiku Coder (highest impact)
2. **Remove Bash from Director review tools** — hard constraint prevents re-running tests
3. **Coder prompt guardrails:** "Do not write to MEMORY.md or create review summary files"
4. **Consider merging Completion Summary into Review step**
5. **Re-run with split model config and compare**
