# Weekly cestDone usage report

Create and email one concise analysis of cestDone token usage for the most recent
closed seven-day reporting window. The window ends at Friday 20:00
`Europe/Madrid`; compare it with the immediately preceding seven-day window.

This is an operational reporting job. Do not modify source files, configuration,
specifications, or Git state. Do not commit or push anything.

## Authoritative data

Use the deterministic compiled summarizer. Do not scan or parse human session logs
and do not calculate token totals yourself.

Run these commands from `C:/Users/dpire/Code/cestdone`:

```powershell
node dist/usage/summarize-cli.js --usage-dir C:/Users/dpire/.cestdone/usage --timezone Europe/Madrid --weeks-ago 0
node dist/usage/summarize-cli.js --usage-dir C:/Users/dpire/.cestdone/usage --timezone Europe/Madrid --weeks-ago 1
```

The first snapshot is the reporting window; the second is the comparison window.
If either command fails completely, stop and fail the job. Do not send a misleading
or partial email. Invalid individual records are not fatal: report the skipped
counts emitted in `dataQuality` and continue with valid records.

## Report

Write one Markdown report to:

```text
C:/Users/dpire/.cestdone/usage/reports/weekly/<period-end-YYYY-MM-DD>.md
```

Create the directory if needed. Use the period end from the current snapshot,
expressed in Europe/Madrid, for the filename and report heading.

Keep the report short and decision-oriented:

1. **Headline:** reporting bounds, runs, success rate, total processed tokens,
   output tokens, and actual metered cost when available. Say `n/a (subscription)`
   when no calls have provider-reported cost; never describe that as zero cost.
2. **By application:** runs, failures, total tokens, share of total, average per
   successful run, and change from the preceding window.
3. **By invocation and model:** direct/schedule/webhook/poller totals and model mix.
4. **Largest and abnormal runs:** the five largest runs, failed or retried runs
   with material usage, missing usage, unknown applications, and significant
   changes from the comparison window.
5. **Recommendations:** at most three specific actions. Distinguish observed facts
   from inferences. High usage alone is not waste if the workflow produced
   proportionate value.

Preserve uncached input, cache creation, cache read, and output as distinct token
categories. `totalProcessedTokens` is an activity measure, not a price estimate.

If the current window contains no usage, still create a short report saying that no
usage was recorded and include any data-quality warnings.

## Email

After the report file is complete, send exactly one email:

```powershell
cestdone send-email --to "daniel.piret@itmplatform.com" --subject "cestDone usage — <period-end-YYYY-MM-DD>" --body-file "<absolute-report-path>"
```

Do not send a separate success, test, or notification email. The report email is
the only authorized external write for a successful run. If the email command
fails, fail the job so the existing daemon failure notification handles it.

## Completion response

Return a structured successful Worker report naming the saved report path, the
period analyzed, and confirmation that exactly one email was sent. Do not include
the full report body in the completion response.
