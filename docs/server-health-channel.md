# Server-health report-hub channel

The daily health check and portal feedback processor belong to the sibling `ubuntu-linux-server` repository. The portal belongs to `Agent-Automation-Workflows/report-hub`. See `C:/Users/dpire/Code/ubuntu-linux-server/health-monitoring/README.md` for state and permissions.

The ignored `.cestdonerc.json` owns the deployed trigger configuration. Preserve `daily-server-health` at `0 23 * * *`, target `C:/Users/dpire/Code/ubuntu-linux-server`, spec `zz_Specifications/recurring_cron_tasks/server-and-application-health.md`, with its existing options. Add this entry under `daemon.webhooks`:

```json
{
  "name": "server-health-feedback",
  "port": 7799,
  "path": "/server-health-feedback",
  "secret": "<existing report-hub relay secret from the ignored runtime configuration>",
  "spec": "C:/Users/dpire/Code/ubuntu-linux-server/health-monitoring/process-feedback.md",
  "target": "C:/Users/dpire/Code/ubuntu-linux-server",
  "options": {
    "skipPlanning": true,
    "workerModel": "opus",
    "autoCommit": false
  }
}
```

Reuse the existing shared report-hub HMAC secret only after comparing the runtime values without printing them. Never commit `.cestdonerc.json`, a resolved secret, or a raw webhook message. The tracked commit for this integration records this value-free contract; the live config stays ignored.

The processor validates the channel, sender and message/reference IDs. It may edit only its own Ubuntu health state and commit without push, then send one confirmation to Daniel's ITM Platform address. It cannot SSH, restart, deploy, delete production data, change specifications, or alter schedules. A duplicate completed receipt performs no action and sends no email. Daily maintenance permissions do not transfer to feedback.

Validate the whole daemon config before writing it in place. Verify hot reload and the expected webhook count in SYSTEM daemon logs, preserving schedules and pollers. Restart report-hub through the elevated PM2 recipe in `AGENTS.md`; no daemon restart should be necessary for a successful config reload. Test without live customer actions: an authenticated portal reply against reserved fixture SRV-000, ledger read-back, and recipient confirmation. Remove the fixture afterward while retaining a sanitized verification record and message receipt. A portal response proves queueing, not completion or email delivery.
