#!/usr/bin/env node
// Start the economy service on port 8725 with a fresh test DB
process.env.ECONOMY_PORT = '8725';
process.env.ECONOMY_DB = '/tmp/sr-visual-test.db';

const { createServer } = require('./economy/service.js');
const fs = require('fs');

for (const f of ['/tmp/sr-visual-test.db', '/tmp/sr-visual-test.db-wal', '/tmp/sr-visual-test.db-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

const server = createServer({
  port: 8725,
  host: '127.0.0.1',
  dbPath: '/tmp/sr-visual-test.db',
});

server.start().then(() => {
  console.log('SERVICE_READY: http://127.0.0.1:8725');
}).catch(e => {
  console.error('START_FAILED:', e.message);
  process.exit(1);
});