# Token usage ledger and weekly analysis report

Add durable token-usage accounting to cestDone and a scheduled weekly analysis
report. The first version must use versioned JSON files, not SQL, and must not add
a public reporting CLI or web dashboard.

## Decision

Use one atomic JSON record per cestDone run under the user's central cestDone data
directory:

```text
~/.cestdone/usage/runs/YYYY/MM/<run-id>.json
```

Update that record after every completed model call and when the run finishes.
Provide a deterministic internal summarizer for the weekly reporting Worker and
for occasional agent-assisted investigations. Schedule one weekly cestDone job
that analyzes the previous closed week, saves a Markdown report, and emails it to
the configured notification recipient.

Do not use SQLite or another database in this version. The expected volume is
small enough for partitioned JSON files, and one file per run avoids shared-file
locking between the daemon and simultaneous direct invocations. It also keeps the
records inspectable and introduces no database dependency or migration lifecycle.

Do not build a dashboard in this version. A dashboard would add a web process,
authentication, deployment, and ongoing UI maintenance. The weekly report answers
the current operational need. The versioned record schema and shared aggregation
module must nevertheless keep a future dashboard straightforward.

## Existing behavior and problems to correct

cestDone already receives these values from both backends and aggregates them in
memory for Director and Worker calls:

- uncached input tokens;
- output tokens;
- cache-read input tokens;
- cache-creation input tokens;
- duration and turn count;
- actual USD cost when the Agent SDK backend reports one.

The current final summary is only human-readable log text. It cannot reliably be
grouped by period, logical application, invocation source, or model. It also has
these correctness gaps:

- A run that throws before `logFinalSummary()` may consume tokens without writing
  a final summary.
- `claude-cli` runs use a subscription and currently display `$0.00`; zero must
  not be presented as an actual metered cost. Store and display cost as unavailable.
- The displayed input total adds uncached input and cache reads but omits cache
  creation. Reports must preserve all four token categories and may additionally
  show their sum as `totalProcessedTokens`.
- A daemon job knows its trigger name, but `handleRun()` does not receive a durable
  source type (`schedule`, `webhook`, or `poller`) or logical application label.
- Templated webhook and poller specs are rendered to UUID filenames, which loses
  the original spec identity in the central session-log filename.
- The central-log cleanup policy must not delete the usage ledger or its reports.

Historical text logs may be analyzed separately on a best-effort basis, but do
not implement an automatic backfill in this change. Rounded totals, missing failed
runs, and incomplete source attribution would make old records look more precise
than they are. Accurate structured accounting begins when this feature is deployed.

## Terminology

- **Run:** one call to `handleRun()` or `handleResume()`, including a daemon retry.
- **Model call:** one backend invocation made by a Director or Worker inside a run.
- **Application:** a stable logical business/application label such as `sales`,
  `support`, `accounting`, `website`, or `server-operations`. It is deliberately
  separate from the target repository and trigger name.
- **Invocation type:** `direct`, `schedule`, `webhook`, or `poller`.
- **Actual cost:** provider-reported USD cost. This is available for metered Agent
  SDK calls and `null` for subscription-backed Claude CLI calls.

## Record format

Create a versioned TypeScript schema similar to the following. Exact names may be
adapted to established project conventions, but do not remove the stated data.

```ts
interface UsageRunRecordV1 {
  schemaVersion: 1
  runId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
  errorCategory?: string

  application: string
  invocation: {
    type: 'direct' | 'schedule' | 'webhook' | 'poller'
    triggerName?: string
    daemonJobId?: string
    attempt?: number
  }

  originalSpecPath: string
  targetRepoPath: string
  runDir: string
  calls: UsageCallRecordV1[]
  totals: UsageTotalsV1
}

interface UsageCallRecordV1 {
  callId: string
  completedAt: string
  role: 'director' | 'worker'
  workflowStep: number
  phaseNumber?: number
  backend: 'agent-sdk' | 'claude-cli'
  model: string
  success: boolean
  durationMs: number
  numTurns: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalProcessedTokens: number
  actualCostUsd: number | null
}

interface UsageTotalsV1 {
  calls: number
  successfulCalls: number
  failedCalls: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalProcessedTokens: number
  actualCostUsd: number | null
  callsWithActualCost: number
}
```

`totalProcessedTokens` is the sum of uncached input, cache creation, cache read,
and output tokens. It is an activity measure, not a price calculation; each token
category can have a different billing rate.

Never store prompts, model responses, tool inputs, tool outputs, API keys, webhook
payloads, email addresses, or environment variables in the usage ledger. Paths and
the small amount of execution metadata above are sufficient.

## Application attribution

Add an optional `application` property to schedule, webhook, and poller
configuration. Add an optional `application` run option for direct and resumed
runs. It may be exposed as `--application <name>` because direct invocations need
a way to override attribution, but do not add any usage-reporting CLI commands.

Resolve the application in this order:

1. Explicit run/trigger `application`.
2. Target repository directory name, normalized to lowercase kebab-case.
3. `unknown` only if no target identity can be resolved.

Log a warning when the fallback is used so recurring jobs can be labelled
explicitly. Application values must be short identifiers, not display names or
arbitrary user content.

Update the active daemon entries in `.cestdonerc.json` with explicit application
labels so related tasks roll up together. Use these mappings unless the current
configuration has materially changed by implementation time:

| Trigger | Application |
|---|---|
| `weekly-accounting-update`, `accounting-feedback` | `accounting` |
| `weekly-blog-update` | `website` |
| `daily-server-health` | `server-operations` |
| `monthly-invoices` | `invoicing` |
| `daily-sales-report`, `weekly-sales-review`, `sales-feedback` | `sales` |
| `helpscout-ticket-research` | `support` |

Give the weekly usage-report job the application `cestdone-observability`. Do not
exclude its usage from future totals; observability has a real token overhead and
should remain visible.

## Invocation context

Propagate this context from the daemon queue into `handleRun()`:

- invocation type;
- original trigger name;
- daemon job ID;
- retry attempt;
- original spec path, even when a temporary rendered spec is executed.

Direct calls default to invocation type `direct`. Each retry is a distinct run
record but shares the daemon job ID and has its own attempt number. All retry usage,
including failed attempts, counts toward the totals.

Do not infer invocation type later from filenames or timestamps.

## Durable recording

Add a usage recorder owned by each run.

1. Generate a UUID and write the initial `running` record before the first model
   call.
2. After every backend result, append the model-call data in memory, recalculate
   totals, and atomically replace the run JSON file.
3. Record backend failure results as failed calls when they contain usage data.
4. In the outer run `finally`, mark the record `completed` or `failed`, add the
   completion timestamp and a safe error category, and write it again.
5. Do not let a usage-recording failure hide or replace the original run failure.
   Log the recording error prominently and continue the normal error path.

Write to a uniquely named temporary file in the same directory and rename it to
the final `.json` path. The weekly reader must ignore temporary files. Different
processes write different run IDs, so no global append lock is required.

Record at the model-call boundary, before higher-level parsing can throw away a
backend result. Extend backend invocation context with role, workflow step, and
phase number rather than attempting to reconstruct them from log messages.

Keep the existing `CostTracker` and terminal/session summaries if useful, but make
the structured recorder the accounting source of truth. Update human-readable
summaries so subscription cost is shown as `n/a (subscription)`, not `$0.00`, and
show cache creation separately or include it correctly in a clearly labelled total.

## Deterministic aggregation

Create a shared aggregation module plus a small internal Node entry point used by
the scheduled Worker. This is not a public `cestdone usage` command and should not
be added to the main CLI help.

The internal summarizer accepts:

- start and end timestamps;
- IANA timezone;
- optional application and invocation-type filters;
- output JSON path.

It reads only valid versioned run records and produces a compact snapshot containing:

- exact period bounds in both local time and UTC;
- run and model-call counts;
- completed and failed runs, retries, and success rate;
- all four token categories and total processed tokens;
- Director versus Worker totals;
- application, invocation type, backend, and model breakdowns;
- average tokens per run and per successful run;
- actual provider cost and its coverage; never estimate subscription cost;
- the five highest-token runs with application, trigger/spec identity, status,
  and token breakdown;
- records skipped because they were invalid or used an unsupported schema version.

Token usage belongs to the period containing each model call's `completedAt`, so a
long run crossing a reporting boundary is accounted for accurately. Run counts use
`startedAt`. Document these semantics in the snapshot.

The summarizer must be deterministic and perform all arithmetic itself. The Worker
analyzes a compact aggregate; it must not scan hundreds of raw records or calculate
totals conversationally.

## Weekly report

Create a recurring operational specification, for example:

```text
zz_Specifications/recurring-tasks/weekly-usage-report.md
```

Add a daemon schedule named `weekly-usage-report`, running Friday at 20:00
`Europe/Madrid`, with:

- target: the cestDone repository;
- `skipPlanning: true`;
- `autoCommit: false`;
- explicit application: `cestdone-observability`;
- economical Director and Worker models that still support reliable analysis.

The job analyzes the most recent closed seven-day window, from Friday 20:00 through
the following Friday 20:00 in `Europe/Madrid`. Because it runs after the period
closes, its own token usage naturally appears in the following report rather than
recursively changing the report it is generating.

The Worker must:

1. Run the deterministic summarizer for the closed Friday-to-Friday window and the
   seven-day window immediately before it.
2. Read only those compact snapshots.
3. Write the report to:

   ```text
   ~/.cestdone/usage/reports/weekly/YYYY-MM-DD.md
   ```

4. Send exactly one email using `cestdone send-email --body-file`, addressed to
   `daniel.piret@itmplatform.com` as requested for this deployment. Keep the address
   in the operational specification, not in application source code.
5. Make no source changes, commits, pushes, or external writes other than the report
   file and the one email.

The report should be concise and decision-oriented:

```text
Subject: cestDone usage — YYYY-MM-DD

1. Headline
   Total runs, success rate, total processed tokens, output tokens, and actual
   metered cost when available.

2. By application
   Runs, failures, total tokens, share of total, average per successful run, and
   change from the prior seven-day window.

3. By invocation type and model
   Direct/schedule/webhook/poller totals and model mix.

4. Largest and abnormal runs
   Top five runs, failed/retried runs that consumed material tokens, missing usage,
   unlabelled applications, and changes that are unusually large relative to the
   previous seven-day window.

5. Recommendations
   At most three specific actions. Distinguish an observed fact from an inference.
   Do not recommend changing a workflow merely because it used many tokens when it
   also produced proportionate value.
```

If there is no usage in the period, still write the report and send one short email
stating that no usage was recorded. If some records are invalid, report the count
and continue with valid records. If deterministic aggregation fails completely,
fail the job and rely on the existing daemon failure notification; do not send a
misleading usage report.

## On-demand analysis

No public reporting CLI is required. When Daniel asks Codex to inspect usage for a
custom period, the agent can run the internal deterministic summarizer and analyze
its compact JSON output. The user should not need to learn or operate a command.

## Dashboard decision and future threshold

A web dashboard is explicitly out of scope for this version. Reconsider it only if
one or more of these becomes true:

- ad-hoc date/application filtering is requested more than twice per month;
- more than one person needs self-service access;
- near-real-time monitoring or budget alerts become operationally important;
- the weekly report regularly hides details that require manual follow-up.

If a dashboard is later justified, build it on the same aggregation module and
versioned records. Prefer a read-only local/static dashboard before introducing a
database-backed service. Do not make the dashboard a prerequisite for collecting
good data now.

## Tests

Add unit and integration coverage for at least:

- creation and atomic update of a run record;
- recomputation of all token categories and totals;
- `actualCostUsd: null` for Claude CLI subscription calls versus numeric Agent SDK
  cost;
- Director/Worker, model, workflow-step, and phase attribution;
- direct, schedule, webhook, and poller invocation attribution;
- preservation of original spec identity for rendered webhook/poller specs;
- explicit application labels and fallback normalization;
- completed calls remaining recorded when a later call or the overall run fails;
- final run status on success and failure;
- simultaneous runs writing distinct files without corrupting each other;
- reader ignoring temporary, malformed, and unsupported-version records;
- previous-week boundaries across `Europe/Madrid` daylight-saving transitions;
- aggregation by call completion time for a run crossing a period boundary;
- retry attempts counted separately but correlated by daemon job ID;
- prior-week comparison and top-run ordering;
- no prompts, responses, payloads, or secrets appearing in serialized records;
- existing session logging, direct execution, resume, and daemon behavior remaining
  compatible.

## Documentation

Update `README.md` with a short "Usage accounting" section covering:

- where structured records and weekly reports live;
- the meaning of application and invocation type;
- the four token categories and `totalProcessedTokens`;
- why Claude CLI subscription cost is unavailable rather than zero;
- how to label new daemon jobs with `application`;
- the weekly schedule and report period;
- that raw prompts and responses are never stored in the usage ledger.

Do not turn the README section into a manual query guide; reporting is intentionally
agent-assisted and scheduled.

## Build, verification, and commit

Run:

```bash
npm test
npm run build
```

Perform one manual direct run with a harmless, minimal test specification and verify
that its structured record contains the correct application, direct invocation
type, backend/model metadata, token categories, and final status. Exercise the
internal summarizer against that record without sending an email.

After editing `.cestdonerc.json`, verify that the running daemon loaded the new
schedule by checking the Local System PM2 daemon log and its reported trigger count.
If the watcher retained stale content after an atomic write, rewrite the same JSON
in place to produce an `fs.watch` change event, then verify again. Do not wait for
the first scheduled Friday to validate configuration.

Commit the cestDone source, tests, README, recurring specification, and daemon
configuration together. Do not push.

## Acceptance criteria

- Every completed model call is durably represented even when its overall run later
  fails.
- Usage can be grouped correctly by arbitrary date range, application, invocation
  type, role, backend, and model without parsing human log text.
- Active daemon jobs have explicit, sensible application labels.
- Claude CLI subscription runs never claim an actual `$0.00` provider cost.
- Token totals retain uncached input, cache creation, cache reads, and output as
  separate values; any combined total includes all four.
- The closed Friday-to-Friday window can be summarized deterministically and
  compared with the preceding seven-day window.
- One scheduled weekly report is saved and emailed, with no duplicate email and no
  source-control changes from the reporting job.
- Usage collection and report files are not removed by ordinary run/log cleanup.
- No SQL database, public reporting CLI, or web dashboard is added.
- Full tests and build pass, the manual direct-run record is verified, and the PM2
  daemon confirms the new schedule is active.
