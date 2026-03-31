# TODO — cestdone

- [ ] Instead of the "CLI: Still waiting... (150s elapsed)", show the "thinking process" as seen in the CLI itself (assess viability)
- [x] Change --target default from cwd (.) to the spec file's parent directory — so users don't need to pass --target when spec is in the target repo
- [ ] Limit Director questions to 3 max in Analyze prompt — prevent question flooding (found in live test)
- [ ] Allow 'skip' / empty Enter to skip remaining Director questions in Step 2
- [ ] `--yes` flag for CI/non-interactive environments (skip approval prompts, auto-approve)
- [ ] `--phase` on `done` phases — reset status to `pending` with confirmation prompt, warn about dependency order but allow
- [ ] Context window token tracking — implement the 80% budget rule with actual token counting, not just heuristics
- [ ] Director prompt size monitoring — log prompt token counts, alert when approaching limits
- [ ] `cestdone-state.md` run log support (Phase 2 scope)
- [ ] Re-run `--phase` dependency order validation — warn when re-running Phase N if Phase N+1 is already `done`
- [ ] cestdone-plan.md lifecycle: auto-create at Step 4, auto-delete after Step 8 commit
- [ ] Parallel session support: conflict detection, file-level locking
- [ ] Audit Claude session isolation across repos / VS Code surfaces — verify workers never resume cross-repo sessions, and reduce or clearly label session history bleed/visibility from unrelated repos

## Improvements from first real-world run (2026-03-25, weekly blog update)

Each item is self-contained with context for tackling in separate sessions.

### ~~A. Skip-commit flag for phases~~ (done)

Implemented `--auto-commit` / `--no-auto-commit` flag with `autoCommit: boolean` config (default `true`). When false, the review prompt's git commit section is replaced with a "Do NOT commit" policy, and "committed" wording is removed from action descriptions. Configurable via CLI flag or `.cestdonerc.json`.

### ~~B. User-configurable defaults~~ (done)

Implemented B1 (minimal). Added `houseRules` (default path) to `.cestdonerc.json` — CLI `--house-rules` overrides config, config overrides empty. `autoCommit` was already implemented in item A.

### C. Final summary report (markdown)

Each phase writes `phase-N-report.md`, but no consolidated summary exists. The `.log` has a Final Summary but it's buried in verbose output and has problems:
- **Wall-clock includes idle time** — the 2h12m run was actually ~21m of compute + ~1h51m waiting for plan approval
- **No per-phase breakdown** — can't see which phase was expensive/slow
- **No aggregated file changes or error summary**

Proposals:
- **(C1) Enrich CostTracker:** Add per-phase cost/tokens/duration, separate `computeTime` vs `wallClockTime`, fix retry counts. Files: `src/shared/cost-tracker.ts`, `src/director/director.ts`.
- **(C2) Generate `summary.md`:** After all phases, write `.cestdone/{runDir}/summary.md` with: title, spec, wall vs compute time, per-phase table (status, cost, tokens, duration, files), aggregated issues. Pure post-processing, no LLM call. Files: new `src/shared/summary-writer.ts`, `src/cli/index.ts`.
- **(C3) LLM-generated analysis (opt-in):** Invoke haiku/sonnet to read all reports and produce qualitative assessment. `--with-analysis` flag. Adds cost but gives the "independent review" feel.  

Recommendation: C1 + C2 first (no extra cost). C3 as opt-in later.

### ~~D. Centralized log directory~~ (done)

Implemented D1 (dual-write). `createSessionLogger()` writes to both run dir and `centralLogDir` (default `~/.cestdone/logs/`). Configurable via `.cestdonerc.json`. Central logs cleaned up by daemon cleanup (`cleanup.maxCentralLogs`).


## 🟢 Low priority (nice to have)
_(polish, optimization, edge cases that can wait)_

- [ ] Config file hierarchical lookup (currently CWD only — may revisit if multi-repo setups need it)
- [ ] Graceful handling when house-rules.md is missing — currently warns, consider testing edge cases (empty file, broken path)
- [ ] Spec parser recovery mode — currently strict-fail by design, may want a `--lint` command to validate spec files without running
