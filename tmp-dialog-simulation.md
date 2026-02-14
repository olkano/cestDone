# New Approach: Impressions & Dialog Simulation

## 1. Impressions

### What's great about this approach

**The user stops doing the Director's job.** Right now the user has to pre-structure phases with exact formatting (`## Phase N`, `### Status: pending`, `### Spec`, `### Done`). That's essentially asking the user to be the architect. The Director — who can actually read the codebase — should be the one breaking work into phases, sizing them, and deciding dependencies. This is the single biggest improvement.

**Lower barrier to entry.** A user can literally write a paragraph and get started. House rules, tech preferences, and specs can all live together in natural language. No learning a schema first.

**The `.plan.md` as a Director artifact is smart.** It gives:
- Transparency: the user sees exactly how the Director interpreted their intent
- Resumability: if the process crashes, the plan file has the state
- Auditability: you can diff the plan over time
- Approval gate: the user approves the Director's interpretation, not just a vague "go ahead"

**Curated context per phase.** Instead of dumping raw MD chunks to the Coder, the Director tailors what each phase needs — relevant house rules, tech decisions, prior phase outcomes. This reduces noise and keeps Coder focused.

### Things to think through

**Plan file as source of truth.** The `.plan.md` replaces the current structured spec as the tracking mechanism. Its format matters a lot — it needs to be machine-readable enough for resume/status but human-readable enough for approval. Consider whether the Director updates it or whether there's a deterministic writer (like current `spec-writer.ts`).

**Cost of the analysis step goes up.** The Director now does more heavy lifting upfront: parsing free-form text, asking questions, creating structured plans. This means the Analyze→Clarify→Plan cycle uses more tokens. Worth it, but worth tracking.

**Existing codebase changes the dynamic significantly.** With a greenfield project, the Director can plan freely. With an existing codebase, it needs to explore first (Glob/Grep/Read) to understand what's there before even asking questions. The analysis step should be codebase-aware — "I see you already have an Express app with these routes, so I'll build on that" vs. "Starting from scratch."

**Resumability after plan approval.** If the process dies mid-phase-2, the plan file should have enough state (phase statuses, completion notes) to resume cleanly. The current spec-writer's atomic write pattern is good — keep it for the plan file too.

**Plan modification after approval.** What if the user approves a 4-phase plan, finishes phase 1, then realizes phase 3 needs to change? Need a mechanism for plan amendments without losing progress.

---

## 2. Dialog Simulation

### Setup

- **Spec file** (`test-spec.md`): _"Build a web dashboard that scrapes and displays publicly available metrics for itmplatform.com. Use Express and never make assumptions, ask anything"_
- **House rules file** (`house-rules.md`): _"Use TDD. Update docs at the end."_
- **Target**: `C:\tmp\cestdone-test` (empty directory — greenfield project)
- **Command**: `npx tsx --env-file=.env src/cli/index.ts run --spec "C:\tmp\cestdone-test\test-spec.md" --target C:\tmp\cestdone-test --house-rules house-rules.md`

---

### Step 1: ANALYZE — Director reads spec + house rules + explores target

> **Director** _(uses Read, Glob, Grep on target directory)_
>
> I've read the spec and house rules. The target directory is empty (greenfield project).
>
> **Extracted so far:**
> - Goal: Web dashboard for publicly available metrics from itmplatform.com
> - Tech: Express (specified), rest TBD
> - House rules: TDD, update docs at the end
> - Embedded rule: "never make assumptions, ask anything"
>
> I have clarifying questions.

```json
{
  "action": "ask_human",
  "message": "I need to clarify a few things before I can create a solid plan.",
  "questions": [
    "What publicly available metrics from itmplatform.com should be displayed? (e.g., pricing page data, status page uptime, blog post count, social proof numbers like '10,000+ companies', or something else?)",
    "Should the scraping happen on-demand when a user visits the dashboard, or on a schedule (e.g., every hour) with results cached in a database/file?",
    "For the frontend, do you want server-rendered HTML (e.g., EJS/Pug templates) or a separate frontend framework (e.g., React) served by Express as an API?"
  ]
}
```

---

### Step 2: CLARIFY — Human answers

> **Human:**
> 1. Scrape pricing tiers and feature lists from the pricing page, and any customer count or social proof numbers from the homepage
> 2. On a schedule, every 6 hours. Store in a JSON file, no database
> 3. Keep it simple — server-rendered HTML with EJS templates

---

### Step 3: Director processes answers, confirms no remaining ambiguities

> **Director:**
>
> Got it. Let me confirm my understanding — no remaining questions:
> - Scrape: pricing tiers + features from `/pricing`, social proof from `/`
> - Schedule: every 6 hours via `node-cron`, persist to `data/metrics.json`
> - Frontend: EJS templates, served by Express
> - No database, no separate frontend build step

```json
{
  "action": "analyze",
  "message": "All clarifications received. Spec is clear. Ready to create plan."
}
```

---

### Step 4: PLAN — Director creates `test-spec.plan.md`

Director writes this file:

```markdown
# Dashboard for itmplatform.com Metrics

## Context
Build a web dashboard that scrapes publicly available metrics from itmplatform.com
and displays them via a server-rendered Express app.

## Tech Stack
- Runtime: Node.js + TypeScript
- Web framework: Express
- Templating: EJS
- Scraping: cheerio + node-fetch (or axios)
- Scheduling: node-cron
- Storage: JSON file (data/metrics.json)

## House Rules
- Use TDD (red-green-refactor for core logic)
- Update documentation at the end

## Phase 1: Scraping Engine & Scheduled Job
### Status: pending
### Spec
- Create a scraper module that fetches and parses:
  - Pricing tiers and feature lists from itmplatform.com/pricing
  - Customer count / social proof from itmplatform.com homepage
- Store results in `data/metrics.json`
- Set up `node-cron` job to run every 6 hours
- Include a manual trigger endpoint: `POST /api/scrape`
- TDD: Write tests for HTML parsing logic using fixture HTML files
### Applicable Rules
- TDD (red-green-refactor for core logic)
### Done
_(to be filled)_

## Phase 2: Dashboard UI & Documentation
### Status: pending
### Spec
- Create EJS views that display:
  - Pricing tiers in a comparison table
  - Social proof numbers (customer count, etc.)
  - Last-scraped timestamp
- Express routes: `GET /` renders dashboard from `data/metrics.json`
- Style with minimal CSS (no framework needed)
- Update README with setup instructions, architecture overview, and how to run
### Applicable Rules
- TDD (red-green-refactor for core logic)
- Update docs at the end
### Done
_(to be filled)_
```

Director presents this to the user:

```json
{
  "action": "approve",
  "message": "I've created a 2-phase plan. Phase 1 focuses on the scraping engine with TDD. Phase 2 adds the dashboard UI and documentation. Please review the plan file."
}
```

---

### Step 5: APPROVE — Human reviews

> **Human:** Approved.

---

### Step 6: EXECUTE Phase 1 — Director sends curated context to Coder

What the Director sends to Coder (note: this is **processed**, not a raw MD chunk):

> **Phase 1: Scraping Engine & Scheduled Job**
>
> You are working on a greenfield Node.js + TypeScript project. No existing code.
>
> **Your task:**
> 1. Initialize the project (`npm init`, `tsconfig.json`, install dependencies: express, cheerio, node-fetch, node-cron, ejs)
> 2. Create a scraper module (`src/scraper.ts`) that:
>    - Fetches HTML from itmplatform.com/pricing and homepage
>    - Parses pricing tiers, feature lists, and social proof numbers using cheerio
>    - Returns structured data
> 3. Create a storage module (`src/storage.ts`) that reads/writes `data/metrics.json`
> 4. Set up the cron job (`src/scheduler.ts`) — every 6 hours
> 5. Add `POST /api/scrape` endpoint for manual triggers
>
> **Rules for this phase:**
> - Use TDD: write failing tests first, then implement. Use Vitest as test framework.
> - Use fixture HTML files in `test/fixtures/` for scraper tests (don't hit the real site in tests)
>
> **Not in scope for this phase:** UI, EJS templates, documentation — those are Phase 2.

---

### Step 7: REVIEW — Director verifies Phase 1

> **Director** _(runs `npm test`, `npx tsc`, reads changed files)_
>
> Tests: 12 passed, 0 failed. TypeScript: 0 errors. Scraper correctly parses fixture HTML.
> Committed: `cestdone: Phase 1 — scraping engine with cron scheduling`

```json
{
  "action": "done",
  "message": "Phase 1 complete. Scraper, storage, and scheduler working. 12 tests passing."
}
```

---

### Step 8: EXECUTE Phase 2 — Director sends curated context to Coder

What Director sends to Coder:

> **Phase 2: Dashboard UI & Documentation**
>
> The project now has a working scraping engine (Phase 1 complete). Key files:
> - `src/scraper.ts` — fetches and parses metrics
> - `src/storage.ts` — reads/writes `data/metrics.json`
> - `src/scheduler.ts` — cron job
> - `src/server.ts` — Express app with `POST /api/scrape`
>
> **Your task:**
> 1. Create EJS views in `views/`:
>    - `dashboard.ejs` — pricing comparison table + social proof numbers + last-scraped timestamp
>    - `layout.ejs` — base layout with minimal CSS
> 2. Add route: `GET /` renders dashboard from stored JSON
> 3. Add minimal CSS in `public/styles.css`
> 4. Update `README.md`: setup instructions, architecture, how to run
>
> **Rules for this phase:**
> - Use TDD for the route handler (test that GET / returns 200, contains expected data)
> - Update documentation: README.md with setup, architecture, and usage

---

### Step 9: REVIEW Phase 2 → COMPLETE

> **Director** _(runs tests, checks docs)_
>
> Tests: 15 passed. README updated. Dashboard renders correctly.
> Committed: `cestdone: Phase 2 — dashboard UI and documentation`

```json
{
  "action": "done",
  "message": "Phase 2 complete. Dashboard renders pricing tiers and social proof. README updated with setup and architecture docs. All 15 tests passing."
}
```

---

## What would differ with an existing codebase?

| Aspect | Greenfield (this example) | Existing Codebase |
|--------|--------------------------|-------------------|
| **Analyze step** | Director notes empty directory, plans from scratch | Director explores existing code: "I see you have an Express app in `src/app.ts` with 5 routes, using Handlebars. I'll add to this." |
| **Questions** | Focus on choices (EJS vs React, DB vs file) | Focus on constraints: "Your existing Express app uses Handlebars — should I switch to EJS or keep Handlebars?" |
| **Phase structure** | Clean separation, no legacy concerns | Must account for refactoring: "Phase 1 includes migrating the existing route structure to support the new dashboard" |
| **Coder context** | Mostly instructions, little existing code context | Heavy on existing code references: "The auth middleware in `src/middleware/auth.ts` must be applied to new routes" |
| **House rules** | Applied as stated | May conflict with existing patterns: "House rules say TDD, but existing tests use Jest — should I migrate to Vitest or keep Jest?" |
| **Risk** | Low — nothing to break | Higher — Director must ensure new code doesn't break existing functionality. Review step runs existing test suite too |
