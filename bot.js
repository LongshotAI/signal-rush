/**
 * bot.js — Signal Rush Telegram Bot
 *
 * Commands:
 *   /start  → Welcome + "🎮 Play Signal Rush" inline button (opens Mini App)
 *   /play   → Opens the Mini App directly via inline keyboard
 *   /stats  → Shows player stats from economy API
 *   /help   → Help text
 *
 * Environment variables:
 *   BOT_TOKEN        — Telegram bot token (required)
 *   MINI_APP_URL     — Telegram Mini App URL (required for /play button)
 *   ECONOMY_API_URL  — Economy service base URL (default: http://localhost:8720)
 *   NODE_ENV         — development|production (default: development)
 */

import { Bot, InlineKeyboard } from 'grammy';

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ECONOMY_API_URL = process.env.ECONOMY_API_URL || 'http://localhost:8720';
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN environment variable is required');
  process.exit(1);
}

// ── Bot ───────────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

// Inline keyboard with "Play Signal Rush" button
function playKeyboard() {
  if (!MINI_APP_URL) {
    return new InlineKeyboard();
  }
  return new InlineKeyboard().webApp('🎮 Play Signal Rush', MINI_APP_URL);
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const name = ctx.from?.first_name || 'Player';
  const text = [
    `⚡ Welcome to Signal Rush, ${name}!`,
    '',
    'Three modes. One reflex test.',
    '',
    '🟢 AI Hunt  — Dodge AI, chase pickups',
    '🟡 Frogger   — Cross the grid alive',
    '🔵 Packet Hop — Route packets at speed',
    '',
    'Tap the button below to play 👇',
  ].join('\n');

  await ctx.reply(text, { reply_markup: playKeyboard() });
});

bot.command('play', async (ctx) => {
  if (!MINI_APP_URL) {
    return ctx.reply('⚡ Mini App is not configured yet. Check back soon!');
  }
  await ctx.reply('⚡ Tap to launch Signal Rush:', {
    reply_markup: playKeyboard(),
  });
});

bot.command('stats', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    return ctx.reply('⚠️ Could not identify your Telegram account.');
  }

  try {
    const res = await fetch(`${ECONOMY_API_URL}/telegram/player/${telegramId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        return ctx.reply(
          '📊 No stats found yet.\n\n' +
          'Play Signal Rush first to create your account!'
        );
      }
      throw new Error(`Economy API returned ${res.status}`);
    }
    const player = await res.json();
    const lines = [
      `📊 **Signal Rush Stats**`,
      '',
      `👤 Player: ${player.username || 'Anonymous'}`,
      `🆔 Telegram ID: \`${telegramId}\``,
      `💰 Credits: ${player.balance ?? 0}`,
      `📈 Total Earned: ${player.total_earned ?? 0}`,
      `📉 Total Spent: ${player.total_spent ?? 0}`,
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Stats fetch error:', err.message);
    await ctx.reply('⚠️ Could not fetch stats right now. Try again later.');
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      '⚡ **Signal Rush — Help**',
      '',
      '/start — Welcome & play button',
      '/play  — Launch the game',
      '/stats — View your stats',
      '/help  — Show this message',
      '',
      '🎮 Modes:',
      '• AI Hunt    — Survive AI hazards, collect pickups for credits',
      '• Frogger    — Cross the grid through moving obstacles',
      '• Packet Hop — Route packets at increasing speed',
      '',
      'Built by Longshot 🎯',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

// Log all messages in development
if (NODE_ENV === 'development') {
  bot.use(async (ctx, next) => {
    const user = ctx.from?.username || ctx.from?.first_name || 'unknown';
    const text = ctx.message?.text || '[no text]';
    console.log(`[${new Date().toISOString()}] @${user}: ${text}`);
    await next();
  });
}

// ── Error handler ─────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('Bot error:', err.message);
});

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`[Signal Rush Bot] Starting in ${NODE_ENV} mode...`);
if (!MINI_APP_URL) {
  console.warn('[Signal Rush Bot] MINI_APP_URL not set — /play will show placeholder');
}

bot.start({
  drop_pending_updates: true,
  onStart: (botInfo) => {
    console.log(`[Signal Rush Bot] @${botInfo.username} is running`);
  },
}).catch((err) => {
  console.error('[Signal Rush Bot] Failed to start:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Signal Rush Bot] Stopping...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Signal Rush Bot] Stopping...');
  bot.stop();
  process.exit(0);
});
