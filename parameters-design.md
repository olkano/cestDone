# cestDone — Parameters Design

## Context & Motivation

cestDone is an AI-orchestrated task runner. The user writes a free-form spec (a markdown or text file describing what to do), optionally provides house rules, and cestDone executes the task using one or two Claude agents.

### The two execution modes

**Single-agent (Director only):** The Director plans the task, then executes each phase itself. Suited for non-coding work: browsing the web, researching topics, writing content, monitoring Reddit, summarizing documents. Cheap and fast.

**Two-agent (Director + Coder):** The Director plans and optionally reviews; a separate Coder agent executes each phase. Suited for software development. The Coder gets full edit/bash tools; the Director acts as a senior engineer reviewing the output. More expensive, higher quality for coding.

### Architecture (relevant to understanding parameter impact)

**Planning flow** (always runs): Analyze → Clarify (Director may ask human questions) → CreatePlan → write `.plan.md`

**Phase execution** (per phase in `.plan.md`):
- Director-only mode: Director executes the phase directly
- Two-agent mode: Coder executes → optionally Director reviews → Director marks complete

**Session continuity:** The Director maintains a single continuous conversation across all planning and execution steps (via `resume: sessionId`). The Coder starts fresh for each phase — no cross-phase context pollution.

**Structured output:** Both agents produce schema-validated JSON responses. Director returns `{ action, message, questions? }`. Coder returns `{ status, summary, filesChanged?, testsRun?, issues? }`. This is enforced by the Agent SDK's `outputFormat: json_schema` — not a soft instruction.

**Tools:** The Agent SDK's `tools: string[]` parameter restricts what tools the model can see and use. This is a hard constraint, not an instruction the model can ignore.

### Cost data from empirical runs (same task: Express+TS dashboard from a 3-sentence spec)

| Run | Config | Cost | Time | Quality |
|-----|--------|------|------|---------|
| V1 | Sonnet+Sonnet, bash reviews | $6.81 | 60 min | 6.5/10 |
| V2 | Haiku+Haiku, optimized | $3.13 | 24 min | 6.5/10 |

**Where money goes (V2 breakdown):**
- Coder execution: $1.65 (53%) — the actual coding work
- Director reviews: $0.84 (27%) — reviewing Coder output after each phase
- Director completions: $0.38 (12%) — writing phase summaries
- Director planning: $0.07 (2%) — analyzing spec, clarifying, creating plan
- Other Director: $0.19 (6%)

**Key finding:** Haiku as Director ignores complex conditional instructions every time (re-ran tests in every review despite explicit "do NOT re-run" instructions). This was caused by Haiku having Bash available — removing Bash from review tools is a hard constraint, not an instruction. Sonnet is the minimum model for reliable Director orchestration.

### Design philosophy: flags include, defaults are minimal

All capability flags use `--with-*` naming. The default mode is the cheapest viable configuration. You add flags to include more expensive, higher-quality steps. This makes cost transparent and intentional.

---

## CLI Commands

```
cestDone run    --spec <path> [--target <path>] [--house-rules <path>] [flags]
cestDone resume --spec <path> [--target <path>] [flags]
```

`run` creates a `.plan.md` if one doesn't exist, then executes all pending phases.
`resume` requires an existing `.plan.md` and continues from where it left off.

`--help` on any command prints all available flags with descriptions (standard Commander.js behavior).

---

## Parameters

### `--director-model <model>`

**Values:** `haiku`, `sonnet`, `opus`
**Default:** `sonnet`
**Env var fallback:** `cestDone_DIRECTOR_MODEL`

The model used by the Director agent for all planning, orchestration, and review steps.

**Cost and compliance tradeoffs:**

| Model | Director cost est. (per run) | Instruction compliance |
|-------|------------------------------|----------------------|
| haiku | ~$1.50 | Poor — ignores complex conditional instructions |
| **sonnet (default)** | ~$4.00 | Good — reliable orchestration |
| opus | ~$12.00 | Excellent — rarely justified by cost |

The cost estimates are relative to V2 Haiku baseline ($1.48 Director cost). Sonnet is ~3.75× Haiku's token price. Opus is ~10× Haiku.

**Why sonnet is the default:** V2 demonstrated that Haiku as Director is unreliable for multi-step conditional instructions. The orchestration role requires a model that follows nuanced instructions precisely. Sonnet provides this at a reasonable cost. Haiku is still appropriate as Director for simple, single-phase specs where instructions are straightforward.

---

### `--coder-model <model>`

**Values:** `haiku`, `sonnet`, `opus`
**Default:** `haiku`
**Env var fallback:** `cestDone_CODER_MODEL`
**Relevant only with:** `--with-coder`

The model used by the Coder agent for phase execution.

**Cost tradeoffs:**

| Model | Coder cost est. (per run) | Output quality |
|-------|--------------------------|---------------|
| **haiku (default)** | ~$1.65 | Good — follows house rules, functional code, smaller scope |
| sonnet | ~$6.00 | Better architecture, larger output, more thorough |
| opus | ~$25.00 | Not worth it for routine coding |

**Why haiku is the default Coder:** V2 showed Haiku as Coder follows house rules well, produces functional code, and is 2.5× faster than Sonnet. It outputs less code (2,258 vs 7,216 lines in V1) but this is often appropriate. Use Sonnet Coder when the spec requires complex architecture or multi-file coordination.

---

### `--with-coder`

**Default:** off (Director-only mode)

Enables the two-agent architecture: Director plans, a separate Coder agent executes each phase, and (if `--with-reviews` is also set) Director reviews.

**Without this flag:** Director executes phases itself. It gets full tools (Read, Glob, Grep, Write, Edit, Bash, WebFetch) per phase. This is the natural mode for non-coding tasks: researching, browsing, writing, summarizing.

**With this flag:** Coder gets full coding tools (Read, Write, Edit, MultiEdit, Bash, Glob, Grep). Director remains read-only during execution (Read, Glob, Grep only). Separation of concerns: Director thinks, Coder acts.

**Cost impact:** Adds ~$1.65 Coder cost per run (Haiku) on top of Director cost. Worthwhile for multi-phase software development. Not worthwhile for simple or non-coding tasks.

**When to use:** Any coding task spanning multiple files, tests, or build steps. Not needed for research, browsing, writing, or single-pass transformations.

---

### `--with-reviews`

**Default:** off
**Requires:** `--with-coder`

After each Coder phase completes, the Director evaluates the work using read-only tools (Read, Glob, Grep) and decides: `done` (phase accepted), `continue` (Coder needs to do more work), or `fix` (Coder made mistakes, retry).

**What read-only review actually does:** Director reads the files Coder changed, reads Coder's self-report (which includes test output, issues found, files modified), and searches the codebase for problems. It cannot run anything itself — but this is often enough. In V2, the `https:https` ternary bug was caught by Director reading the code, not by running it.

**Why no Bash by default:** V2 showed that when Director had Bash available, Haiku re-ran tests in every review (15 unnecessary runs) despite explicit "do NOT re-run" instructions. Removing Bash is a hard tool constraint, not a soft instruction the model can override. Read-only reviews are more predictable and sufficient for most cases.

**Cost impact:** Reviews cost ~$0.84 per run (27% of V2 total).

**Quality impact:** Without this flag, Director trusts the Coder's self-reported status entirely. The Coder's self-report can be wrong — V2 caught a real bug that Coder missed.

**When to use:** Any run where correctness matters. Skip for prototyping or when you plan to manually review the output yourself.

---

### `--with-bash-reviews`

**Default:** off
**Implies:** `--with-reviews` automatically — no need to pass both
**Requires:** `--with-coder`

Upgrades reviews to include Bash alongside the read-only tools. Director can run tests, start servers, check runtime behavior, verify ports — not just read files.

**When this adds value over `--with-reviews`:** When the spec delivers a running service (server, API, background process) and you need to confirm it actually starts and responds correctly — something that can't be verified by reading code alone.

**When it does not add value:** For pure library code, CLI tools, or anything that doesn't have a runtime to exercise. In those cases `--with-reviews` is sufficient and cheaper.

**Risk:** Even Sonnet with Bash available can spend review turns fighting environment issues (port conflicts, process cleanup, OS differences). V2 logged 7 port conflict incidents and 17 process kill attempts in reviews. Use only when runtime verification is essential.

**Cost impact:** ~1.5–2× the cost of `--with-reviews` due to more turns.

---

### `--with-human-validation`

**Default:** off

Pauses after the plan is created and displays the `.plan.md` to the user. Waits for explicit y/n approval before executing any phases.

**No API cost.** Adds human review time only.

**What you're validating:** The plan includes phase names, specs, and applicable house rules. Reviewing it lets you catch misunderstood requirements, over-engineered scope, or wrong tech stack choices before spending money on execution.

**When to use:** First run of a new spec type. Any run expected to cost over ~$3. Specs that are vague or high-stakes. Any task touching production systems or external services.

**Without this flag:** Director auto-proceeds to execution once it determines the plan is valid. For well-specified, familiar tasks this is fine.

---

## Flag interaction summary

| Flags | Mode | What runs |
|-------|------|-----------|
| *(none)* | Director only | Plan → Director executes each phase |
| `--with-coder` | Two-agent | Plan → Coder executes, Director marks complete |
| `--with-coder --with-reviews` | Two-agent + QA | Plan → Coder executes → Director reviews (read-only) |
| `--with-coder --with-bash-reviews` | Two-agent + runtime QA | Plan → Coder executes → Director reviews (with Bash) |
| `--with-human-validation` | Any mode + pause | Plan created → human approves → execute |

Any combination of the above is valid. `--with-bash-reviews` includes `--with-reviews` automatically.

---

## Current implementation gaps (as of 2026-02-17)

The following flags are designed above but not yet implemented in the codebase:

- `--director-model` / `--coder-model` — currently set via env vars only (`cestDone_DIRECTOR_MODEL`, `cestDone_CODER_MODEL`)
- `--with-coder` — two-agent mode is currently the only mode; Director-only execution does not exist yet
- `--with-reviews` — reviews currently always run; making them opt-in requires a flag to be threaded through `runPhase()`
- `--with-bash-reviews` — Bash is currently always included in Director's Review step; read-only should become the default
- `--with-human-validation` — `askApproval()` exists in `DirectorDeps` but plan approval auto-proceeds based on Director's `approve` action
