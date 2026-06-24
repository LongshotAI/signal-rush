#!/usr/bin/env node
// economy/start-dev.js — Fixed: directly creates and starts the server
process.env.ECONOMY_AUTH_ENFORCED = 'false';
process.env.ECONOMY_PORT = process.env.ECONOMY_PORT || '8720';
process.env.ECONOMY_DB = process.env.ECONOMY_DB || ':memory:';

const { createServer } = require('./service.js');

const port = parseInt(process.env.ECONOMY_PORT) || 8720;
const host = process.env.ECONOMY_HOST || '127.0.0.1';
const dbPath = process.env.ECONOMY_DB;

const server = createServer({ port, host, dbPath });
server.start().then(() => {
  console.log(`[economy] Service running on ${host}:${port}`);
  console.log(`[economy] Database: ${dbPath}`);
}).catch(err => {
  console.error('[economy] Failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => server.stop().then(() => process.exit(0)));