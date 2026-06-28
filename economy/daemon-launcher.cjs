// daemon-launcher.cjs — Keeps the economy service alive with auth disabled
const { spawn } = require('child_process');
const path = require('path');

const child = spawn('/home/hive/.local/bin/node', [
  path.resolve(__dirname, 'start-player-auth.js')
], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  env: {
    ...process.env,
    ECONOMY_DB: '/home/hive/.signal-rush/economy.db',
    ECONOMY_PORT: '8720',
    ECONOMY_AUTH_ENFORCED: 'false',
  }
});

child.on('error', (err) => {
  console.error('[daemon] Failed to start:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('[daemon] Service detached, PID:', child.pid);
  process.exit(0);
}, 500);
