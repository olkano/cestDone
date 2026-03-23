# Agentic Director -- Design Document

**Status:** Proposal
**Date:** 2026-03-20

---

## 1. Problem Statement

The Director today is a **thin state machine** with a hardcoded orchestration flow:

```
Planning Worker --> for each phase: { Phase Worker --> Director Review --> Director Complete }
```

The Director LLM only makes three decisions during execution: `done`, `fix`, or `continue`. It cannot reason about *how* to decompose work, what *kind* of Worker to spawn, or whether a phase needs sub-planning before implementation. The orchestration logic lives in TypeScript, not in the Director's reasoning.

This creates a gap: the human can write rules like *"per each step, call a Worker to plan and a Worker to TDD and execute the plan, then document if necessary"* in the spec or house rules, but the system cannot honor them. The Planning Worker might interpret the rule by creating more phases, but the orchestration remains one-Worker-per-phase, serially, with no sub-planning step.

### What works well today

- **Predictability.** The flow is deterministic and easy to debug -- you know exactly what will happen.
- **Token efficiency.** The Director uses minimal context because it doesn't reason about workflow.
- **Traceability.** Every prompt and report is a file in `.cestdone/reports/`.
- **Safety.** The Director can't enter infinite loops or spawn unbounded Workers.

### What's missing

- The Director cannot adapt its workflow based on the spec or house rules.
- It cannot spawn a "planning Worker" for a specific phase before spawning an "execution Worker."
- It cannot decide that a phase needs documentation after implementation.
- It cannot parallelize independent phases.
- It cannot skip phases it determines are unnecessary after reviewing prior work.

---

## 2. Vision: Director as Workflow Agent

Instead of a hardcoded state machine, the Director becomes an **LLM-driven loop** that receives a set of available actions and decides what to do next.

```
Director receives: spec, plan, current state, available actions
Director decides:  which action to take next
System executes:   the action, returns result
Director decides:  next action
...until Director says "all done"
```

The Director would be aware that Workers exist, what kinds of Workers are available, and would choose when and how to use them.

### Available Actions

| Action | Description |
|--------|-------------|
| `spawn-planner` | Launch a Worker to create a sub-plan for a specific phase or task |
| `spawn-coder` | Launch a Worker to implement code (current behavior) |
| `spawn-reviewer` | Launch a Worker to review code (instead of Director doing it) |
| `spawn-documenter` | Launch a Worker to write/update documentation |
| `review` | Director reviews a Worker's report directly (current behavior) |
| `ask-human` | Pause and ask the human a question |
| `skip-phase` | Mark a phase as unnecessary based on prior work |
| `done` | All work is complete |

### Example Flow

Given a spec with the house rule: *"Per each step, call a Worker to plan and a Worker to TDD and execute"*:

```
Director reads plan (7 phases)

Phase 1:
  Director --> spawn-planner(phase=1)
    Planner Worker --> writes phase-1-subplan.md
  Director reads subplan
  Director --> spawn-coder(phase=1, subplan=phase-1-subplan.md)
    Coder Worker --> implements, writes phase-1-report.md
  Director --> review(phase=1)
    Director reads report, checks code
  Director --> done(phase=1)

Phase 2:
  Director --> spawn-planner(phase=2)
  ...
```

Without that house rule, the Director could choose a simpler flow:

```
Phase 1:
  Director --> spawn-coder(phase=1)
  Director --> review(phase=1)
  Director --> done(phase=1)
```

The Director *reasons* about what workflow fits the spec and rules, rather than following a fixed script.

---

## 3. Architecture

### 3.1 Director Loop

The core change is replacing the hardcoded `executeTwoAgentPhase` with an LLM-driven loop:

```typescript
async function executePhaseAgentic(plan, phase, config, deps): Promise<void> {
  const actions = buildAvailableActions(config)
  let state = { phase, reports: [], subplans: [] }

  while (true) {
    const decision = await deps.backend.invoke({
      prompt: buildAgenticPrompt(plan, phase, state, actions),
      systemPrompt: buildAgenticSystemPrompt(plan, config),
      outputSchema: AGENTIC_RESPONSE_SCHEMA,
      ...
    })

    const response = parseAgenticResponse(decision)

    switch (response.action) {
      case 'spawn-planner':
        const subplan = await spawnPlannerWorker(phase, response.instructions, deps)
        state.subplans.push(subplan)
        break
      case 'spawn-coder':
        const report = await spawnCoderWorker(phase, response.instructions, deps)
        state.reports.push(report)
        break
      case 'review':
        const reviewResult = await directorReview(phase, state.reports, deps)
        state.reviewResult = reviewResult
        break
      case 'ask-human':
        const answer = await deps.askInput(response.question)
        state.humanAnswers.push({ question: response.question, answer })
        break
      case 'done':
        return
    }
  }
}
```

### 3.2 Director System Prompt

The Director needs a system prompt that explains its capabilities:

```
You are the Director of cestDone. You orchestrate software development by
delegating work to specialized Workers and reviewing their output.

## Available Workers
- **Planner**: Analyzes a task and produces a detailed sub-plan. Use when
  a phase is complex or when house rules require planning before coding.
- **Coder**: Implements code following instructions or a sub-plan. Has full
  access to read/write files, run tests, and execute commands.
- **Documenter**: Updates documentation based on code changes.

## Available Actions
- spawn-planner: Give instructions, receive a sub-plan file
- spawn-coder: Give instructions (or a sub-plan path), receive a report file
- spawn-documenter: Give instructions, documentation is updated in-place
- review: Read a Worker's report and verify the work
- ask-human: Ask the human a question when you're stuck
- skip-phase: Skip a phase you determine is unnecessary
- done: Mark the current phase as complete

## Decision Guidelines
- Read the spec and house rules to determine the appropriate workflow
- If house rules say "plan before coding," use spawn-planner then spawn-coder
- If the phase is simple and well-specified, go straight to spawn-coder
- Always review after coding unless house rules say otherwise
- Document only when the spec or house rules require it
```

### 3.3 State Management

The Director needs to see what has happened so far in the current phase:

```typescript
interface PhaseState {
  phase: Phase
  subplans: Array<{ path: string; summary: string }>
  workerReports: Array<{ path: string; status: string; summary: string }>
  reviewResults: Array<{ decision: string; message: string }>
  humanAnswers: Array<{ question: string; answer: string }>
  retryCount: number
}
```

Each Director call receives the current state, so it can make informed decisions about what to do next. The state is built from the files in `.cestdone/reports/` -- the Director doesn't need to remember anything across calls.

### 3.4 Safety Guardrails

An LLM-driven loop is inherently less predictable. Guardrails needed:

| Risk | Mitigation |
|------|------------|
| Infinite loops | Max actions per phase (e.g., 20). Hard stop with escalation to human. |
| Unbounded Workers | Each Worker call still has `maxTurns` and `maxBudgetUsd`. |
| Wrong action chosen | Schema validation on response. Invalid actions → retry with error message. |
| Token accumulation | Director state is rebuilt from files each call, not accumulated in session. No session resume within a phase -- each decision is a fresh call with the current state. |
| Runaway costs | Per-phase budget limit. Director sees cumulative cost in its state. |
| Human override | `ask-human` action + escalation after N retries. `--non-interactive` mode limits available actions. |

### 3.5 File-Based Communication (unchanged)

The agentic Director still communicates with Workers via files:

```
.cestdone/
  spec.plan.md                    <-- main plan
  reports/
    phase-1-subplan.md            <-- Planner Worker output
    phase-1-prompt.md             <-- Coder Worker instructions
    phase-1-report.md             <-- Coder Worker report
    phase-1-review.md             <-- Director review result (NEW)
    phase-2-subplan.md
    ...
```

Adding `phase-N-review.md` captures the Director's review reasoning as a traceable artifact.

---

## 4. Impact Assessment

### What changes

| Component | Current | Agentic |
|-----------|---------|---------|
| `runPhase` | Hardcoded: Worker → Review → Complete | LLM loop: Director chooses actions |
| Director prompt | Minimal (review prompt only) | Rich (available actions, state, guidelines) |
| Director calls per phase | 2 (review + complete) | Variable (3-10 depending on complexity) |
| Token usage per phase | Low (~30K cache-read) | Higher (~50-100K, fresh calls with state) |
| Predictability | Deterministic | LLM-dependent |
| Debugging | Read log, know exact flow | Read log + understand Director's reasoning |

### What stays the same

- Planning flow: Planning Worker writes `.plan.md` (unchanged)
- Worker implementation: Workers are still fresh sessions with `rawPrompt` or `buildWorkerPrompt`
- Backend abstraction: Still `Backend.invoke()`
- File-based communication: Still `.cestdone/reports/`
- CLI interface: Same flags, same commands
- Non-interactive/daemon mode: Works, but with restricted actions (no `ask-human`)

### Token cost estimate

Current per phase: ~30K Director (2 calls with session resume)
Agentic per phase: ~50-100K Director (3-6 fresh calls with state rebuild)

For a 7-phase project: current ~210K Director total, agentic ~350-700K. Roughly 2-3x more Director tokens. Worker tokens stay the same.

With Claude CLI (subscription billing), the token increase doesn't cost more money. With Agent SDK (API billing), it's ~$0.50-1.00 more per project at Opus rates.

---

## 5. Implementation Strategy

### Option A: Full agentic loop (big change)

Replace `executeTwoAgentPhase` and `executeDirectorOnlyPhase` with a single `executePhaseAgentic`. The Director LLM drives all decisions.

**Pros:** Maximum flexibility. Director can honor any house rule about workflow.
**Cons:** Large change. Hard to test deterministically. Risk of regressions.

**Estimate:** 3-5 days of work. Major test rewrite. Needs extensive manual testing.

### Option B: Configurable workflow templates (medium change)

Keep the hardcoded orchestration but make it configurable via "workflow templates":

```json
{
  "workflow": "plan-then-code"
}
```

Available templates:
- `default`: Worker → Review → Complete (current)
- `plan-then-code`: Planner Worker → Coder Worker → Review → Complete
- `plan-code-document`: Planner → Coder → Review → Documenter → Complete
- `code-only`: Worker → Complete (no review)

The spec or house rules can reference a template. The orchestrator picks the right sequence.

**Pros:** Predictable. Easy to test. No LLM-driven loop risk.
**Cons:** Limited flexibility. Can't adapt to arbitrary house rules. New templates require code changes.

**Estimate:** 1-2 days. Moderate test changes. Low risk.

### Option C: Hybrid -- agentic planning, deterministic execution (recommended)

The Planning Worker already reads house rules. Extend it to **embed workflow hints in the plan file**:

```markdown
## Phase 1: Core form infrastructure
### Status: pending
### Workflow: plan-then-code
### Spec
...
```

The orchestrator reads `### Workflow` from each phase and selects the matching template. The Planning Worker decides the workflow per phase based on the spec and house rules. The execution is still deterministic.

This gives the *appearance* of an agentic Director without the risks of an LLM-driven loop.

**Pros:** Planning Worker reasons about workflow (it has the full context). Execution is deterministic and testable. No new LLM loop. Incremental change from current architecture.
**Cons:** Limited to predefined templates. Can't handle truly novel workflows. Adds a field to the plan format.

**Estimate:** 1 day. Small changes to plan parser, orchestrator, and Planning Worker prompt. Low risk.

---

## 6. Recommendation

**Start with Option C** (hybrid). It delivers the core user request -- the system can honor rules like "plan before coding each phase" -- without the risks of a full agentic loop.

If Option C proves insufficient (users need workflows that don't fit templates), **upgrade to Option A** later. The file-based communication architecture supports both -- Workers don't care who spawned them.

### Migration path: C then A

1. **Now:** Implement Option C. Add `### Workflow` to plan format. Planning Worker chooses workflow per phase. Orchestrator executes templates.
2. **Later (if needed):** Replace the template executor with an agentic loop. The plan format stays the same -- `### Workflow` becomes a hint rather than a directive. The Director can override it.
3. **Even later:** Add new Worker types (documenter, reviewer) as the system matures.

---

## 7. Open Questions

1. **Should the Director review Planner Worker output?** In the `plan-then-code` template, the Planner produces a sub-plan. Should the Director review/approve it before spawning the Coder? Or should it trust the Planner and go straight to coding? (Recommendation: trust the Planner -- adding a review step doubles Director calls.)

2. **Parallel phases.** The current orchestrator executes phases serially. Some phases are independent and could run in parallel. This is orthogonal to the agentic question but would multiply the value. (Recommendation: defer. Serial is simpler and sufficient for now.)

3. **Worker specialization.** Should different Worker types have different tool sets? A Documenter Worker might not need Bash. A Planner Worker might not need Write (it only writes the sub-plan). (Recommendation: keep it simple -- all Workers get the same tools. Restrict via house rules, not tooling.)

4. **Budget awareness.** Should the Director see cumulative cost and make budget-conscious decisions? ("This phase is simple, use Haiku instead of Opus.") (Recommendation: interesting but premature. Add when cost tracking is more mature.)

5. **Learning from failures.** When a Worker fails and the Director retries, should the retry include a summary of what went wrong? Currently it does (via the `fix` instructions). An agentic Director could do this more naturally by including failure reports in its state. (Recommendation: already handled well enough by the current retry mechanism.)
