#!/usr/bin/env node
// Load .env file manually (handles special chars better than bash source)
// Then dynamically import bot.js (ESM)
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '.env');
const content = fs.readFileSync(envFile, 'utf8');
for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let value = trimmed.slice(eqIdx + 1).trim();
  // Strip surrounding quotes if any
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// Verify BOT_TOKEN was loaded
if (!process.env.BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN not loaded from .env');
  process.exit(1);
}

// Dynamically import ESM bot.js
import('./bot.js').catch(err => {
  console.error('FATAL: Failed to load bot.js:', err.message);
  process.exit(1);
});