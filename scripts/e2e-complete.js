#!/usr/bin/env node
// Complete Signal Rush E2E verification wrapper.
//
// This script intentionally delegates to verify-ad-system-full.js instead of
// duplicating stale portal assumptions. The delegated script starts its own
// isolated economy service + temp DB, proves advertiser onboarding, campaign
// review, deposits, billed impressions, game API creatives, CLI sponsor
// rendering, and portal page health, then tears down only its child process.

const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'verify-ad-system-full.js');
const child = spawn(process.execPath, [script], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`E2E verification terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code || 0);
});
