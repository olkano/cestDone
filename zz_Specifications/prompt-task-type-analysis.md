# Prompt/Task-Type Applicability Analysis

The current prompts were designed for **coding tasks**. This analysis maps every prompt instruction against three task types to identify what breaks when the task is not code.

**Task types:**
- **Code** -- build features, fix bugs, refactor, add tests
- **Content** -- edit blog posts, translate, write docs, update markdown
- **Agentic** -- call APIs, deploy, run scripts, send emails, git operations, data fetching

---

## 1. Planning Worker Prompt (`buildPlanningWorkerPrompt`)

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Explore the codebase using Read/Glob/Grep/Bash" | Yes | Partial | Partial | Content tasks need to explore content files, not code. Agentic tasks may not need exploration at all |
| 2 | "Each phase should be a discrete, testable deliverable" | Yes | No | No | Blog posts and API calls are not "testable deliverables." Content phases are verifiable by reading; agentic phases by confirming side effects |
| 3 | "Compliance Checklist: prescriptive code, mandated component choices, accessibility, docs" | Yes | Partial | No | Checklist categories are code-specific. Content needs: tone, style, formatting rules. Agentic needs: expected outcomes, retry policy |
| 4 | "Reference Component: replicate pattern from existing component" | Yes | Yes | No | Works for content (model a post after an existing one) but irrelevant for agentic actions |
| 5 | "Do NOT write code. Only explore the codebase and write the plan file" | Yes | Misleading | Misleading | For content tasks there is no "codebase" to explore. For agentic tasks, the planner may need to verify endpoints or scripts exist |

---

## 2. Worker Execution Prompt (`buildWorkerPrompt`)

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Read the phase spec, explore the codebase, determine implementation order, and execute" | Yes | Partial | No | Content worker should explore content files and style guides, not "codebase." Agentic worker should execute commands, not explore |
| 2 | "Implement incrementally and ensure tests pass at each step" | Yes | No | No | No tests to run when editing markdown or calling APIs |
| 3 | "Run tests in non-interactive mode" | Yes | No | No | Content has no tests. Agentic tasks may have verification steps but not test suites |
| 4 | "Kill any servers or background processes when done" | Yes | No | Partial | Content never starts servers. Agentic might, depending on the action |
| 5 | "Available CLI Tools: cestdone send-email" | Partial | Partial | Yes | Only relevant when the phase needs to send notifications |
| 6 | "External Operations: use long timeouts, retry 3x" | Partial | No | Yes | Core for agentic tasks. Irrelevant for content editing |
| 7 | "Testing: run tests, kill servers" | Yes | No | No | Same as #3 above |
| 8 | "Compliance Self-Check: re-read spec, verify checklist" | Yes | Yes | Yes | Universal, works for all types |
| 9 | "Reporting: write report + diff" | Yes | Partial | Partial | Diff is meaningless for agentic tasks (no file changes). Content diff is useful but "Test Results" section doesn't apply |
| 10 | "Write diff: `git --no-pager diff > cestdone-diff.txt`" | Yes | Partial | No | Content creates a diff. Agentic tasks may not change any files at all |

---

## 3. Worker Initial Instructions (`buildInitialWorkerInstructions`)

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Implement Phase N" | Yes | Misleading | Misleading | "Implement" implies writing code. Content should say "edit/write." Agentic should say "execute" |
| 2 | "Read the phase spec, explore the codebase, determine implementation order" | Yes | Partial | No | Same issue as Worker prompt #1 |
| 3 | "If the work is large, implement incrementally and ensure tests pass" | Yes | No | No | Content and agentic tasks have no incremental test cycle |
| 4 | "Run tests in non-interactive mode" | Yes | No | No | Repeated code-only instruction |
| 5 | "Kill any servers or background processes when done" | Yes | No | Partial | Same as above |

---

## 4. Director Review Prompt (`buildReviewPrompt`)

This is where the blog job failed. 20-turn budget burned on code-style review of a markdown file.

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Review Worker's work. Worker already ran tests -- do NOT re-run them" | Yes | Misleading | Misleading | Content worker didn't run tests. Agentic worker may not have tests. This framing confuses the reviewer |
| 2 | "Focus on: code quality, spec compliance, integration" | Yes | Partial | No | "Code quality" and "integration" don't apply to content. Spec compliance does |
| 3 | **Code Review (mandatory)**: correctness, completeness, quality, security | Yes | No | No | **Root cause of the blog failure.** Director spent 20 turns doing "code review" on a markdown file, checking frontmatter fields, socialImage, gitignore, etc. |
| 4 | **Functional Verification**: start servers, verify endpoints | Yes | No | Partial | Never applies to content. For agentic tasks, could verify that the action took effect (e.g., email was sent, branch was merged) |
| 5 | **Spec Compliance (mandatory)**: checklist, reference component, deviations | Yes | Yes | Yes | Universal. But for content, checklist items should be about tone/style/formatting. For agentic, about outcomes |
| 6 | "External operations that failed are NEVER acceptable as done" | Partial | No | Yes | Core for agentic tasks. Irrelevant for content |
| 7 | **Test Coverage**: untested scenarios, edge cases, negative paths | Yes | No | No | Content has no tests. Agentic tasks rarely have test suites |
| 8 | **Git Commits**: `git add -A && git commit` | Yes | Yes | Partial | Content needs commits. Agentic tasks may or may not produce file changes |
| 9 | "fix / continue / done" actions | Yes | Yes | Yes | Universal |

---

## 5. Director Execution Prompt (`buildDirectorExecutionPrompt`, `--no-with-worker` mode)

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Use your full tools to read the codebase, write code, run tests, and verify" | Yes | No | No | Wrong vocabulary for content and agentic |
| 2 | "Run tests in non-interactive mode" | Yes | No | No | Same pattern |
| 3 | "Kill any servers or background processes" | Yes | No | Partial | Same pattern |

---

## 6. Execution System Prompt (`buildExecutionSystemPrompt`)

| # | Instruction | Code | Content | Agentic | Notes |
|---|-------------|:----:|:-------:|:-------:|-------|
| 1 | "Review code quality and verify functionality" | Yes | No | No | Role description is code-centric. Should adapt to task type |
| 2 | "Do not re-read files unless checking for changes made by the Worker" | Yes | Partial | Yes | Generally good advice but content review may need re-reading to assess tone |

---

## Summary: What needs to change per task type

### Content tasks need
- **Planning**: "Explore content files and style guides" instead of "explore codebase"
- **Planning**: Phases are "verifiable deliverables" not "testable deliverables"
- **Worker**: No testing instructions. Instead: "Verify formatting, links, and style compliance"
- **Worker**: No diff for phases that don't change files
- **Review**: Replace Code Review with **Content Review**: tone consistency, formatting rules, link validity, frontmatter correctness
- **Review**: Drop Test Coverage entirely
- **Review**: Drop Functional Verification (no servers to start for markdown)

### Agentic tasks need
- **Planning**: "Verify that scripts/endpoints/credentials exist" instead of "explore codebase"
- **Planning**: Phases are "confirmed outcomes" not "testable deliverables"
- **Worker**: No testing instructions. Instead: "Verify the action took effect (check response, confirm side effect)"
- **Worker**: External Operations section is primary, not secondary
- **Worker**: Diff/report may be empty (no file changes)
- **Review**: Replace Code Review with **Outcome Verification**: did the API respond? did the deploy succeed? did the email arrive?
- **Review**: Drop Test Coverage entirely
- **Review**: Functional Verification becomes the primary check, not optional

### Hybrid tasks
Most real specs are a mix. The blog job is content + agentic (write posts, then deploy + email). The prompts need to adapt per phase, not per spec. The planning worker could tag each phase with a type (`code`, `content`, `agentic`) and the downstream prompts would select the appropriate instructions.
