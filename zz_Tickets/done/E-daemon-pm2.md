# E. Daemon does not work under pm2

**Status**: FIXED and verified
**Priority**: Was blocking, now resolved
**Date**: 2026-03-27
**Fix**: CJS wrapper (`cestdone-pm2.cjs`) + `ecosystem.config.cjs`

---

## Root Cause: `isCliEntryPoint()` fails under pm2's fork container

When pm2 launches a script in `fork_mode`, it doesn't run `node dist/cli/index.js daemon` directly. Instead it runs:

```
node <pm2-install>/lib/ProcessContainerFork.js
```

Then `ProcessContainerFork.js` loads the user script via:

```javascript
// pm2/lib/ProcessContainerFork.js, line 29-30
if (ProcessUtils.isESModule(process.env.pm_exec_path) === true) {
  import(url.pathToFileURL(process.env.pm_exec_path));
}
```

This means inside cestdone's `dist/cli/index.js`:

| Variable | Value |
|---|---|
| `process.argv[1]` | `C:\...\pm2\lib\ProcessContainerFork.js` |
| `__filename` (from `import.meta.url`) | `C:\...\cestdone\dist\cli\index.js` |

The `isCliEntryPoint()` guard at [index.ts:326](src/cli/index.ts#L326) compares these two paths:

```typescript
function isCliEntryPoint(): boolean {
  if (!process.argv[1] || process.env.VITEST) return false
  const argv1 = path.resolve(process.argv[1])
  if (argv1 === __filename) return true
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(__filename)
  } catch {
    return false
  }
}
```

**They don't match** → `isCliEntryPoint()` returns `false` → Commander never parses → daemon action never runs.

The module loads fine (all imports execute, hence 73MB memory usage), but no code path actually *does* anything. The Node process stays alive because pm2's container keeps the event loop referenced.

### Why PMPilot (also ESM) works

PMPilot's entry (`inference/mainChatServer.js`) has no `isCliEntryPoint()` guard — it executes top-level code directly:

```javascript
import { createServer } from 'http';
import app from './chatAPI.js';
const port = Config.EXPRESS_PORT;
// ... creates server immediately
```

No Commander, no argv check. The `import()` from pm2 loads the file and the server starts.

### Why it's NOT an ESM issue

The TODO hypothesized pm2 + ESM as the root cause. Investigation disproves this:

1. **pm2 v6.0.5** correctly detects ESM via `ProcessUtils.isESModule()` — checks `package.json` for `"type": "module"` ✓
2. **`pathToFileURL()` fix** is present in `ProcessContainerFork.js` line 30 — the Windows `ERR_UNSUPPORTED_ESM_URL_SCHEME` bug was fixed ✓
3. **PMPilot proves it** — same machine, same pm2, same Node 24.14.0, `"type": "module"`, runs fine for 3+ days ✓
4. The module *does* load — 73MB memory proves all imports resolved. It just doesn't *execute* the daemon action.

### Additional issue: `ProcessContainerFork.js` doesn't concat args

`ProcessContainer.js` (cluster mode) has this at line 77:

```javascript
process.argv = process.argv.concat(pm2_env.args);
```

`ProcessContainerFork.js` (fork mode, used for ESM) does NOT. So even if `isCliEntryPoint()` passed, Commander would see `process.argv = ['node', 'ProcessContainerFork.js']` with no `daemon` argument — no subcommand would match.

---

## Environment

| Component | Value |
|---|---|
| pm2 | 6.0.5 |
| Node.js | 24.14.0 |
| OS | Windows 11 Pro |
| cestdone package.json | `"type": "module"` |
| tsconfig module | `"Node16"` (emits ESM) |
| pm2 exec mode | `fork_mode` |
| pm2 script path | `C:\Users\dpire\Code\cestdone\dist\cli\index.js` |
| pm2 args | `daemon` |

### pm2 internals referenced

- `C:\Users\dpire\AppData\Roaming\npm\node_modules\pm2\lib\ProcessContainerFork.js` — fork mode container, loads ESM via `import(url.pathToFileURL(...))`
- `C:\Users\dpire\AppData\Roaming\npm\node_modules\pm2\lib\ProcessContainer.js` — cluster mode container, has `process.argv.concat(args)` (fork does not)
- `C:\Users\dpire\AppData\Roaming\npm\node_modules\pm2\lib\ProcessUtils.js` — `isESModule()` detection, walks up to find `package.json`

---

## Fix Options

### Option A: CJS wrapper that fixes argv (recommended)

Create `cestdone-pm2.cjs` at the repo root:

```javascript
// cestdone-pm2.cjs — pm2 entry point
// pm2's ProcessContainerFork.js doesn't set process.argv correctly for ESM scripts.
// This wrapper fixes argv so Commander can parse the subcommand.
const execPath = process.env.pm_exec_path || process.argv[1];
const args = process.env.args ? JSON.parse(process.env.args) : [];
process.argv = [process.argv[0], execPath, ...args];
import('./dist/cli/index.js');
```

Update ecosystem config:

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "cestdone-daemon",
    script: "cestdone-pm2.cjs",
    args: "daemon",
    cwd: "C:/Users/dpire/Code/cestdone/"
  }]
};
```

**Pros**: No source changes, no build changes, well-known pattern
**Cons**: Extra file to maintain

### Option B: Fix `isCliEntryPoint()` to detect pm2

```typescript
function isCliEntryPoint(): boolean {
  if (process.env.VITEST) return false
  // pm2 sets pm_exec_path to the real script path
  if (process.env.pm_exec_path) return true
  if (!process.argv[1]) return false
  const argv1 = path.resolve(process.argv[1])
  if (argv1 === __filename) return true
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(__filename)
  } catch {
    return false
  }
}
```

Also need to fix argv for Commander to see the `daemon` subcommand:

```typescript
if (isCliEntryPoint()) {
  // pm2's ProcessContainerFork doesn't set process.argv correctly for ESM
  if (process.env.pm_exec_path && !process.argv.includes(process.env.pm_exec_path)) {
    const args = process.env.args ? JSON.parse(process.env.args) : []
    process.argv = [process.argv[0], process.env.pm_exec_path, ...args]
  }
  const program = new Command()
  // ...
}
```

**Pros**: No extra files, works transparently
**Cons**: Source code becomes pm2-aware (tight coupling)

### Option C: Dedicated daemon entry point

Create `src/daemon/entry.ts` that bypasses Commander entirely:

```typescript
// src/daemon/entry.ts — direct daemon entry, no Commander
import { handleDaemon } from '../cli/index.js'
handleDaemon()
```

Point pm2 at `dist/daemon/entry.js`.

**Pros**: Clean separation of concerns
**Cons**: Need to extract `handleDaemon` from the Commander action, second entry point to maintain

### Option D: Drop pm2 for daemon

Since the daemon already manages its own PID, lifecycle, and graceful shutdown, use Windows Task Scheduler or a simple `node dist/cli/index.js daemon` via `nssm` (Non-Sucking Service Manager) or `start /B`.

**Pros**: No pm2 quirks at all
**Cons**: Lose pm2 monitoring, log rotation, restart policies

---

## What was implemented (Option A variant — direct call, no Commander)

The original Option A (argv-fixing wrapper) hit a secondary issue: pm2 sets `process.env.args` as a plain string, not JSON, and `pm_exec_path` points to the wrapper itself, not `dist/cli/index.js`. Fixing argv for Commander turned out fragile.

**Final approach**: the CJS wrapper bypasses Commander entirely and calls the daemon startup code directly:

1. `cestdone-pm2.cjs` — imports `handleRun`, `loadConfig`, `createDaemon`, `createDaemonLogger` from the ESM modules and wires them together (same logic as the Commander `daemon` action)
2. `ecosystem.config.cjs` — points pm2 at the wrapper, no `args` needed

**Files created**:
- `cestdone-pm2.cjs` — CJS wrapper that directly starts daemon
- `ecosystem.config.cjs` — pm2 ecosystem config

**Usage**:
```bash
pm2 start ecosystem.config.cjs
pm2 save   # persist to dump for auto-restart
```

---

## Verification results (2026-03-27)

All checks pass:

| Check | Result |
|---|---|
| `pm2 show cestdone-daemon` → status | `online`, 0 restarts |
| pm2 out.log | `[cestdone-daemon] Starting...`, config loaded, scheduler started |
| `.cestdone/daemon.pid` | Written, matches pm2 PID |
| `.cestdone/daemon/daemon.log` | Entries: Daemon starting, scheduler started with 1 schedule |
| Schedule registered | "weekly-blog-update" next run: 2026-04-02T04:00:00.000Z |
| `pm2 save` | Dump saved — survives pm2 restart |
