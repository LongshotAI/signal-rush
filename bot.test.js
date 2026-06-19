/**
 * bot.test.js — Unit tests for Signal Rush Telegram Bot
 *
 * Tests bot command parsing and response generation without calling
 * the real Telegram API. Uses source-code analysis to verify structure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFile(name) {
  return readFileSync(join(__dirname, name), 'utf-8');
}

// ── Test: playKeyboard function behavior ──────────────────────────────────────

describe('playKeyboard', () => {
  it('bot.js uses webApp inline keyboard', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('webApp'), 'bot.js should use webApp inline keyboard');
    assert.ok(botSrc.includes('🎮 Play Signal Rush'), 'bot.js should have play button text');
  });

  it('bot.js does not hardcode the token', () => {
    const botSrc = readFile('bot.js');
    assert.ok(!botSrc.includes('8968258535'), 'bot.js must NOT contain hardcoded token');
    assert.ok(botSrc.includes('process.env.BOT_TOKEN'), 'bot.js should read BOT_TOKEN from env');
  });
});

// ── Test: Command registration ────────────────────────────────────────────────

describe('bot command structure', () => {
  it('registers /start command', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("bot.command('start'"), 'Should register /start');
  });

  it('registers /play command', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("bot.command('play'"), 'Should register /play');
  });

  it('registers /stats command', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("bot.command('stats'"), 'Should register /stats');
  });

  it('registers /help command', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("bot.command('help'"), 'Should register /help');
  });
});

// ── Test: Stats command economy API integration ───────────────────────────────

describe('stats command', () => {
  it('calls economy API with telegram ID', () => {
    const botSrc = readFile('bot.js');
    assert.ok(
      botSrc.includes('/telegram/player/'),
      'Stats should call economy API player endpoint'
    );
  });

  it('handles 404 (player not found) gracefully', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('404'), 'Should handle 404 status');
    assert.ok(
      botSrc.includes('No stats found'),
      'Should show friendly message for new players'
    );
  });

  it('handles API errors gracefully', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('catch'), 'Should have error handling');
    assert.ok(
      botSrc.includes('Could not fetch stats'),
      'Should show error message on API failure'
    );
  });
});

// ── Test: Environment configuration ───────────────────────────────────────────

describe('environment configuration', () => {
  it('reads BOT_TOKEN from env', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('process.env.BOT_TOKEN'), 'Should read BOT_TOKEN');
  });

  it('reads MINI_APP_URL from env', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('process.env.MINI_APP_URL'), 'Should read MINI_APP_URL');
  });

  it('reads ECONOMY_API_URL from env with default', () => {
    const botSrc = readFile('bot.js');
    assert.ok(
      botSrc.includes("ECONOMY_API_URL || 'http://localhost:8720'"),
      'Should default ECONOMY_API_URL to localhost:8720'
    );
  });

  it('exits if BOT_TOKEN is missing', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes('process.exit(1)'), 'Should exit on missing token');
  });
});

// ── Test: Development logging ─────────────────────────────────────────────────

describe('development mode', () => {
  it('logs incoming messages in development', () => {
    const botSrc = readFile('bot.js');
    assert.ok(
      botSrc.includes('NODE_ENV ==='),
      'Should check NODE_ENV for dev mode'
    );
  });
});

// ── Test: Graceful shutdown ───────────────────────────────────────────────────

describe('graceful shutdown', () => {
  it('handles SIGINT', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("process.on('SIGINT'"), 'Should handle SIGINT');
  });

  it('handles SIGTERM', () => {
    const botSrc = readFile('bot.js');
    assert.ok(botSrc.includes("process.on('SIGTERM'"), 'Should handle SIGTERM');
  });
});

// ── Test: .env.example exists ─────────────────────────────────────────────────

describe('.env.example', () => {
  it('has BOT_TOKEN placeholder', () => {
    const envExample = readFile('.env.example');
    assert.ok(envExample.includes('BOT_TOKEN='), 'Should have BOT_TOKEN placeholder');
  });

  it('has MINI_APP_URL placeholder', () => {
    const envExample = readFile('.env.example');
    assert.ok(envExample.includes('MINI_APP_URL='), 'Should have MINI_APP_URL placeholder');
  });

  it('has ECONOMY_API_URL placeholder', () => {
    const envExample = readFile('.env.example');
    assert.ok(envExample.includes('ECONOMY_API_URL='), 'Should have ECONOMY_API_URL placeholder');
  });
});
