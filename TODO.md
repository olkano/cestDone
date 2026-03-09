# TODO — cestdone

- [ ] Instead of the "CLI: Still waiting... (150s elapsed)", show the "thinking process" asn seen in the CLI itself (assess viability)
- [ ] Change --target default from cwd (.) to the spec file's parent directory — so users don't need to pass --target when spec is in the target repo
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

## 🟢 Low priority (nice to have)
_(polish, optimization, edge cases that can wait)_

- [ ] Config file hierarchical lookup (currently CWD only — may revisit if multi-repo setups need it)
- [ ] Graceful handling when house-rules.md is missing — currently warns, consider testing edge cases (empty file, broken path)
- [ ] Spec parser recovery mode — currently strict-fail by design, may want a `--lint` command to validate spec files without running
