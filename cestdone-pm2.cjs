// CJS wrapper for pm2 — directly starts the daemon, bypassing Commander.
// pm2's ProcessContainerFork.js doesn't set process.argv correctly for ESM CLI apps,
// so we skip Commander and call the daemon startup code directly.
import('./dist/cli/index.js').then(async function(mod) {
  var path = require('path');
  var { loadConfig } = await import('./dist/shared/config.js');
  var { createDaemon } = await import('./dist/daemon/daemon.js');
  var { createDaemonLogger } = await import('./dist/daemon/daemon-logger.js');

  console.log('[cestdone-daemon] Starting (pid: ' + process.pid + ', cwd: ' + process.cwd() + ')');

  var config = loadConfig();
  if (!config.daemon) {
    console.error('[cestdone-daemon] No "daemon" section found in .cestdonerc.json');
    process.exit(1);
  }

  console.log('[cestdone-daemon] Config loaded: ' +
    (config.daemon.schedules ? config.daemon.schedules.length : 0) + ' schedule(s), ' +
    (config.daemon.webhooks ? config.daemon.webhooks.length : 0) + ' webhook(s), ' +
    (config.daemon.pollers ? config.daemon.pollers.length : 0) + ' poller(s)');

  var logDir = config.daemon.logDir || 'logs/daemon';
  var logger = createDaemonLogger(logDir);
  console.log('[cestdone-daemon] Log file: ' + path.resolve(logDir, 'daemon.log'));

  var daemon = createDaemon({
    executeRun: mod.handleRun,
    logger: logger,
    config: config,
  });

  var shutdown = async function() {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await daemon.start();
}).catch(function(err) {
  console.error('[cestdone-pm2.cjs] Fatal:', err);
  process.exit(1);
});
