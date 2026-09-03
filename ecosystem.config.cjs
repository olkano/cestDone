module.exports = {
  apps: [{
    name: "cestdone-daemon",
    script: "cestdone-pm2.cjs",
    cwd: "C:/Users/dpire/Code/cestdone/",
    node_args: "--env-file=.env",
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    min_uptime: 5000,
  }]
};
