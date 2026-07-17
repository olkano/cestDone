# Send-email: read HTML body from stdin

Add stdin support to `cestdone send-email` so Workers never pass large HTML bodies
through shell arguments. Then update the Worker prompt and the recurring job specs
to use the new form.

## Background: the 2026-07-17 empty email incident

- The `internet-listening-scan` daemon job sent its daily leads email, but it arrived
  empty: only the text of the first `<h3>` rendered, the rest of the body was lost.
- The Worker followed the job spec, which instructs sending with the HTML inline:
  `--html "<the HTML body>"`.
- The CLI reported success and SMTP accepted the message, so the data loss was silent.
- Root cause: passing multi-kilobyte multiline HTML through shell argv is inherently
  fragile. Shell quoting, `$(cat ...)` expansion, and Windows spawn escaping can each
  mangle it. Reproduced manually on 2026-07-17: `HTML=$(cat body.html)` followed by
  `--html "$HTML"` delivered an email containing only the first heading.
- Sending the exact same HTML by reading the file in Node and calling `sendEmail()`
  directly delivered the full 2260-char body, confirming the mail pipeline itself is
  fine. Only the argv channel is broken.

## Why stdin, not a --html-file flag

- Any fix that keeps the HTML in argv stays fragile. The two robust channels are a
  file or a stream.
- A file flag forces the Worker to create a temp file. Job house rules often restrict
  which files a Worker may create or modify (internet-listening-scan allows only
  `leads.csv` and `scan-log.md`), so every spec would need a carve-out plus cleanup.
- A quoted heredoc piped to stdin needs no file and passes bytes through untouched.
  This is the established convention of sendmail, mail, psql, and `gh api --input -`,
  so agents already know the pattern.

Target usage:

```bash
cestdone send-email \
  --to "daniel.piret@olkano.com" \
  --subject "Internet Listening: <YYYY-MM-DD> - <N> actionable lead(s)" \
  --body "<short plain text summary>" \
  --html - <<'HTML'
<the HTML body>
HTML
```

## Steps

### 1. CLI change

In `src/cli/index.ts`, `send-email` command (currently around line 561) and
`handleSendEmail`:

- When `--html -` is passed, read the HTML body from stdin (consume the stream fully,
  UTF-8) before sending.
- If `--html -` is passed and stdin yields an empty string, fail with a clear error.
  Never send an email whose HTML body is empty; that is exactly the silent failure
  this spec exists to prevent.
- Inline `--html "<html>"` keeps working unchanged for short bodies.

### 2. Worker prompt

`src/worker/worker-prompt.ts` (Available CLI Tools section, around line 46) currently
advertises the inline form:

```
cestdone send-email --to <addr> --subject <subj> --body <text> [--html <html>]
```

Update it to document the stdin form with a heredoc example, and state explicitly:
never pass multiline HTML inline as an argument, always use `--html -` with a quoted
heredoc.

### 3. Tests

In `tests/cli-send-email.test.ts` add:

- `--html -` with piped stdin: the piped content arrives as the html field.
- `--html -` with empty stdin: command fails, nothing is sent.
- Regression: inline `--html` still passes through unchanged.

### 4. Update the recurring job specs (olkano repo, absolute paths)

In `C:/Users/dpire/Code/olkano/Marketing/zz_Specifications/recurring_cron_tasks/`:

- `internet-listening-scan.md` section 6: replace the inline `--html "<the HTML body>"`
  invocation with the heredoc form shown above.
- `internet-listening-refresh.md` section 3: same replacement. Also add the missing
  `--body` flag: its current example omits `--body` entirely, which is a required
  option, so the documented command fails as written today.
- Leave the specs under `deprecated/` untouched.
- Commit in the olkano repo (only these two files):
  `chore(specs): send email HTML via stdin heredoc, not inline argv`

### 5. Commit (cestdone repo)

```bash
git add src/cli/index.ts src/worker/worker-prompt.ts tests/cli-send-email.test.ts
git commit -m "feat(cli): send-email reads HTML body from stdin via --html -"
```

Do not push.

## Acceptance

- `printf '<h3>Hi</h3>' | cestdone send-email --to <addr> --subject s --body b --html -`
  delivers the full HTML body.
- Full test suite passes (`npm test`).
- Both updated job specs show the heredoc form and no spec instructs passing
  multiline HTML inline.
