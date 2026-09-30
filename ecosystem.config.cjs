// pm2 process file. Build first (npm run build), then: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'venture-worker',
      script: 'dist/worker/index.js',
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 20,
      exp_backoff_restart_delay: 1000,
      // Must exceed SHUTDOWN_GRACE_MS (45 s) plus the abort wait so shutdown is graceful.
      kill_timeout: 60000,
      // pm2's default (true) SIGINTs every descendant by ppid, including the detached claude children, so the
      // graceful drain never runs. The worker signals and reaps its own process groups.
      treekill: false,
      time: true,
    },
  ],
};
