# Quality Gaps and Mitigations

**Status:** Recommendations
**Date:** 2026-03-23
**Context:** Post-mortem on the first non-trivial cestdone run (itm-form-spec, 7 phases, ~250 tests generated). All tests passed, yet a manual audit found 6 issues the system should have caught.

---

## 1. Problem Summary

cestdone's current architecture delivers *working code* — tests pass, the build succeeds, and the Worker self-reports "no issues." But it does not reliably deliver *correct code* as measured against the spec. The gap is not in code generation but in **verification**: the system verifies that tests pass, but does not verify that the tests are sufficient, that the implementation matches the spec's reference code, or that cross-cutting concerns (accessibility, component patterns, documentation) are consistent across phases.

The bugs found were not regressions or crashes. They were **spec drift** — subtle divergences between what the spec says and what the Worker built.

---

## 2. Failure Taxonomy

Every issue from the audit maps to one of five categories. These are general — they will recur on future specs unless addressed structurally.

### 2.1 Reference code not followed

The spec includes code samples (getters, methods, render templates) that define the canonical implementation. The Worker reimplements the logic from its understanding rather than transcribing the spec's code verbatim. This produces functionally similar but semantically wrong code (e.g., reading an attribute instead of a property).

**Why it happens:** The Worker receives the full phase spec but treats code samples as illustrative, not prescriptive. Nothing in the prompt says "follow code samples exactly."

### 2.2 Cross-phase pattern inconsistency

When multiple phases produce similar components (e.g., checkbox vs textbox), the later phase doesn't inherit patterns from the earlier one. Each Worker starts fresh — it reads the codebase but doesn't know *which* patterns from existing components are mandatory to replicate.

**Why it happens:** Workers get a clean session per phase. The phase spec describes what to build, not what to match. The Planning Worker doesn't extract "must follow the same pattern as X" instructions.

### 2.3 Test coverage optimism

Workers write tests that prove their implementation works (happy path), not tests that prove the spec is satisfied (edge cases, negative paths, cross-component interactions). The house rule "TDD for core logic, edge cases after" is interpreted as "write a few edge cases" rather than "systematically enumerate untested scenarios."

**Why it happens:** No one asks "what's missing?" The Worker self-reports passing tests. The Director review checks that tests pass, not what they cover.

### 2.4 Spec deviations accepted silently

When the Worker deviates from the spec (e.g., using a native element instead of an existing component), the Director review sees the deviation in the report but accepts it as a reasonable trade-off. There is no policy that spec deviations require explicit human approval.

**Why it happens:** The review prompt says "flag anything missing or divergent" but treats deviations as informational, not blocking. The `fix` action is reserved for broken code, not for spec mismatches.

### 2.5 Out-of-scope obligations ignored

The spec may contain instructions that are outside the Worker's direct implementation scope — like updating a tracker section, modifying documentation in another file, or notifying downstream consumers of a breaking change. Workers focus on their assigned deliverables and skip ancillary obligations.

**Why it happens:** The Worker prompt emphasizes "implement Phase N" and the reporting template asks about files changed, not about spec-wide obligations. The Planning Worker doesn't extract these obligations into the phase spec.

---

## 3. Mitigations

### 3.1 Spec compliance checklist in phase specs — Implemented

Planning Worker prompt now instructs: include a `#### Compliance Checklist` inside each phase's `### Spec` with checkboxes for prescriptive code, component choices, accessibility requirements, and documentation obligations. The plan format template shows the expected structure. Both Workers (self-check) and Director review (verification) use the checklist.

### 3.2 Review prompt with spec-diffing — Implemented

The Director review's "Requirements Check" step replaced with "Spec Compliance (mandatory)". Now requires: verify every Compliance Checklist item (failed = `fix`), compare against Reference Component patterns (deviation = `fix`), and treat all spec deviations as blocking — only the human can approve them.

### 3.3 Pattern-matching instruction for similar components — Implemented

Planning Worker prompt now instructs: when a phase builds something similar to an existing component, include a `#### Reference Component` inside `### Spec` naming the model component and the specific patterns (accessibility, event shape, error handling, test style) the Worker must replicate. The plan format template shows the expected structure.

### 3.4 Test gap analysis step — Implemented

Director review now includes a "Test Coverage" check (step 4). The Director reads the spec and Worker's test files, identifies untested scenarios (edge cases, negative paths, accessibility, guard rails, boundary conditions), and responds with `fix` if significant gaps exist.

### 3.5 Post-execution obligations phase — Implemented

Planning Worker prompt now instructs: if the spec contains tracking tables, changelogs, or documentation obligations, add a final lightweight phase dedicated to those — do not bury them in implementation phases where they get skipped.

### 3.6 Dedicated review Worker (future — ties into agentic Director)

**What:** Instead of the Director reviewing code inline (with limited context window and read-only tools), spawn a Review Worker with full codebase access. The Review Worker reads the spec, the implementation, and the tests, and produces a structured review report. The Director then decides `fix`, `continue`, or `done` based on the review report.

**Why this is better than Director review:**
- The Director review happens in a session that accumulates context from prior phases, leaving less room for thorough review of the current phase.
- A Review Worker gets a fresh session focused entirely on the review — it can read more files, compare more patterns, and be more thorough.
- The Review Worker can run targeted tests or checks (e.g., grep for `getAttribute` where the spec says property access).

**What it catches:** All five categories, especially with the compliance checklist (3.1) and test gap analysis (3.4) baked into the review prompt.

**Implementation:** This is a workflow template change. In the current architecture, it would be a new `code-then-review` template. In the agentic architecture (Option C from agentic-director.md), the Planning Worker would set `### Workflow: code-then-review` on phases that need deeper verification.

---

## 4. Recommendations for Future Specs

These are guidelines for writing specs that are more resilient to agent drift.

### 4.1 Mark reference code as prescriptive

If the spec includes code that the Worker must follow exactly, mark it explicitly:

```markdown
**Implementation (follow exactly):**
```js
get values() {
    const obj = {};
    for (const field of this.fields) {
        setByPath(obj, field.path, field.value);
    }
    return obj;
}
```
```

vs. code that is illustrative:

```markdown
**Example (adapt to your implementation):**
```

Without this distinction, the Worker treats all code as suggestions.

### 4.2 Name the reference component

When a new component should follow patterns from an existing one, say so explicitly:

```markdown
`itm-checkbox` must follow the same accessibility patterns as `itm-textbox`:
- `aria-describedby` linking error messages to the input
- `role="alert"` on the error span
- Label association via `for` or `aria-labelledby`
```

### 4.3 Include a negative requirements section

Specs typically describe what to build. Adding a section on what *not* to do catches common agent mistakes:

```markdown
### What NOT to do
- Do NOT use native `<button>` — use `<itm-button>` for all interactive elements
- Do NOT use `getAttribute('path')` — use the `path` property directly
- Do NOT render `<slot>` in Light DOM components
```

### 4.4 Define the test matrix in the spec

Rather than relying on the Worker to enumerate edge cases, include a test matrix:

```markdown
### Required test scenarios
| Scenario | Type | Component |
|----------|------|-----------|
| Empty form submit | Unit | itm-form-layout |
| Populate with unmatched paths | Unit | itm-form-layout |
| Double-click Save prevention | E2E | itm-form-actions |
| Dirty revert after cancel | E2E | itm-form-layout |
| Enter key triggers submit | E2E | itm-form-layout |
```

The Worker can add more tests, but these are the minimum.

### 4.5 Separate tracker obligations from implementation

If the spec has a tracking table, add an explicit instruction at the phase boundary:

```markdown
**After each phase:** Update the Implementation Tracker (§0) to reflect completed tasks.
```

Better yet, put this in the house rules so it applies to all specs.

---

## 5. Priority and Effort

| # | Mitigation | Effort | Impact | Status |
|---|-----------|--------|--------|--------|
| 3.1 | Compliance checklist in plan | Small (prompt change) | High | Done |
| 3.2 | Spec-diffing in review prompt | Small (prompt change) | High | Done |
| 3.3 | Reference component instruction | Small (prompt change) | Medium | Done |
| 3.4 | Test gap analysis in review | Small (prompt change) | Medium | Done |
| 3.5 | Post-execution obligations phase | Small (prompt change) | Medium | Done |
| 3.6 | Dedicated review Worker | Medium (new workflow) | High | Do with agentic Director |

Additionally, a **Compliance Self-Check** section was added to the Worker prompt (`buildWorkerPrompt`), so Workers verify checklist items and reference component patterns before writing their report.

---

## 6. Relationship to Agentic Director (Option C)

Option C from `agentic-director.md` adds per-phase workflow hints (`### Workflow: plan-then-code`). This is useful infrastructure, but it does not directly address the quality gaps described here. The agentic Director gives the system *flexibility* in how it orchestrates phases, but the issues are about *what the system checks*, not *how it sequences work*.

That said, Option C becomes the natural vehicle for mitigation 3.6 (dedicated review Worker). The Planning Worker could set `### Workflow: code-then-review` on complex phases, triggering a Review Worker after the Coder Worker. Without Option C, the review step is always the Director doing an inline review — which is the weakest link in the current pipeline.

**Status:** Mitigations 3.1–3.5 implemented (prompt-level fixes). Implement 3.6 alongside Option C when the agentic Director ships.
