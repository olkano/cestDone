# TODO — cestdone

## 🔴 High priority (blocks current work)
_(items that must be resolved before or during current phase)_

- [ ] Atomic write for spec updates — write to temp file, then rename. Prevents corruption on crash mid-write
- [ ] Structured Director output schema — define `tool_use` response schema with action envelope (`approve | ask_human | fix | complete`). Needed before Director module implementation
- [ ] Windows stdin compatibility — use Node `readline` module, test explicitly on Windows. Required for Phase 0 acceptance criteria
- [ ] Non-TTY detection — error with clear message when no TTY available (Phase 0 hard requirement)

## 🟡 Medium priority (next phases)
_(items for upcoming phases, or improvements to current architecture)_

- [ ] `--yes` flag for CI/non-interactive environments (skip approval prompts, auto-approve)
- [ ] `--phase` on `done` phases — reset status to `pending` with confirmation prompt, warn about dependency order but allow
- [ ] Context window token tracking — implement the 80% budget rule with actual token counting, not just heuristics
- [ ] Director prompt size monitoring — log prompt token counts, alert when approaching limits
- [ ] `cestdone-state.md` run log support (Phase 2 scope)
- [ ] Re-run `--phase` dependency order validation — warn when re-running Phase N if Phase N+1 is already `done`

## 🟢 Low priority (nice to have)
_(polish, optimization, edge cases that can wait)_

- [ ] Config file hierarchical lookup (currently CWD only — may revisit if multi-repo setups need it)
- [ ] Graceful handling when house-rules.md is missing — currently warns, consider testing edge cases (empty file, broken path)
- [ ] Director "I'm stuck" escalation UX — after 3 rejections, format a clear summary of attempts for human review
- [ ] Spec parser recovery mode — currently strict-fail by design, may want a `--lint` command to validate spec files without running
