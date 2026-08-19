# cestDone agent instructions

## Required startup

Before investigating, planning, or changing anything:

1. Read `README.md` for architecture, CLI reference, and daemon configuration.

## Contextual references

Before concluding that access or connection information is unavailable, consult
the appropriate document:

- Email sending (SendGrid, SMTP): see `Email` section below and `.env`
- Daemon schedules, webhooks, pollers: `.cestdonerc.json`. GOTCHA (2026-08-19): the daemon's config watcher only reacts to fs.watch `change` events; an atomic write (temp file + rename, which Claude Code's Edit tool uses) makes it reload STALE content. After editing `.cestdonerc.json`, verify the reload in the daemon log (`C:\ProgramData\pm2\home\logs\cestdone-daemon-out.log`, look for the new trigger counts); if the change did not take, rewrite the file in place (`Set-Content` with the same content) to fire a clean `change` event.
- Agent SDK internals: `agent-sdk-details.md`
- SendGrid account, keys, domain auth: `C:\Users\dpire\Code\ITMPlatform\SENDGRID-ACCESS.md`
- Azure Key Vault secrets: `C:\Users\dpire\Code\ITMPlatform\INFRASTRUCTURE.md`

## Build and test

```bash
npm run build        # compile TypeScript
npm test             # run all Vitest tests
npm link             # install global `cestdone` command
```

After code changes, run `npm run build` to update the global command.

## PM2 daemon management

The cestdone-daemon runs as a PM2 process under the **Local System** account
(via the pm2-windows-service). The PM2 home directory is
`C:\ProgramData\pm2\home`, not the user-level default.

**You cannot manage it from a normal user shell.** To run PM2 commands, open an
elevated PowerShell and set the home directory:

```powershell
# Option 1: inline
Start-Process powershell -Verb RunAs -ArgumentList '-Command', '$env:PM2_HOME = \"C:\ProgramData\pm2\home\"; pm2 status' -Wait

# Option 2: script file (for multi-step operations)
# Write commands to a .ps1 file, then:
Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"path\to\script.ps1`"" -Wait
```

When capturing output from elevated commands, write to a temp file and read it
back, since the elevated window's stdout is not piped to the caller.

Ecosystem config: `ecosystem.config.cjs` (restart policy, backoff delay).
Entry point: `cestdone-pm2.cjs` (CJS wrapper that bypasses Commander).
Logs: `C:\ProgramData\pm2\home\logs\cestdone-daemon-*.log`

## Azure Key Vault

Secrets used by this project (SendGrid API key, etc.) are stored in Azure Key
Vault `kv-itmplatform-prod`. Fetch them with:

```powershell
az keyvault secret show --vault-name kv-itmplatform-prod --name <secret-name> --query value --output tsv
```

Requires an active `az login` session. The developer identity has Key Vault
Administrator role on all three vaults (prod, stage, demo).

Key secrets relevant to cestdone:
- `SendGridAPIKey` -- production SendGrid send key (used in `.env` as `SENDGRID_API_KEY`)

## Email

Provider: SendGrid (via `src/email/sendgrid-provider.ts`). Configured in `.env`:

```
MAIL_PROVIDER=sendgrid
MAIL_FROM=notifier@itmplatform.com
SENDGRID_API_KEY=SG.xxxxx
```

The send key comes from Azure Key Vault (`SendGridAPIKey` in
`kv-itmplatform-prod`). SMTP/Zoho config is commented out in `.env` as a
fallback.

Domain `itmplatform.com` has full SendGrid domain authentication (SPF, DKIM,
DMARC). Verified sender: `notifier@itmplatform.com`.
