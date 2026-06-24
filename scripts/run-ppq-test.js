#!/usr/bin/env node
// scripts/run-ppq-test.js
// Standalone test runner: starts its own economy service, runs the ppq claim flow test, stops.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TEST_PORT = 18725;
const testDbPath = path.join(os.tmpdir(), `sr-ppq-run-${process.pid}-${Date.now()}.db`);

async function waitForService(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
}

async function main() {
  // Clean up old test DB
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(testDbPath + ext); } catch {}
  }

  const env = {
    ...process.env,
    ECONOMY_AUTH_ENFORCED: '***',
    ECONOMY_PORT: String(TEST_PORT),
    ECONOMY_DB_PATH: testDbPath,
  };

  const child = spawn('node', ['economy/service.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', d => {}); // swallow

  const ready = await waitForService(TEST_PORT);
  if (!ready) {
    console.error('Failed to start economy service');
    child.kill();
    process.exit(1);
  }
  console.log(`Economy service started on port ${TEST_PORT}`);

  // Run the actual test
  const testEnv = { ...env, ECONOMY_PORT: String(TEST_PORT) };
  const testProc = spawn('node', ['scripts/test-ppq-claim-flow.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: testEnv,
    stdio: 'inherit',
    timeout: 45000,
  });

  testProc.on('exit', (code) => {
    child.kill();
    // Cleanup test DB
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(testDbPath + ext); } catch {}
    }
    process.exit(code || 0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });