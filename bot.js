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

// Inline keyboard with "Play Signal Rush" Mini App button (private chats only — Telegram blocks web_app inline buttons in groups)
function playKeyboard() {
  if (!MINI_APP_URL) return new InlineKeyboard();
  return new InlineKeyboard().webApp('🎮 Play Signal Rush', MINI_APP_URL);
}

// Set global MenuButton so the Mini App is accessible from any chat via bot profile / chat bar
async function setMenuButton() {
  try {
    await bot.api.setChatMenuButton({
      type: 'web_app',
      text: '🎮 Play Signal Rush',
      web_app: { url: MINI_APP_URL },
    });
    console.log('[Signal Rush Bot] MenuButton set — users can play from bot profile');
  } catch (err) {
    console.error('[Signal Rush Bot] Failed to set MenuButton:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeReply(ctx, text, extra = {}) {
  try {
    await ctx.reply(text, extra);
  } catch (err) {
    // If web_app button is rejected (group chat), send text-only with menu button instructions
    if (err.message?.includes('BUTTON_TYPE_INVALID')) {
      console.log('[Signal Rush Bot] web_app inline button not available in this chat type — sending text-only');
      const menuText = text + '\n\n🎮 Tap the **Play** button on my profile (@signal_rush_bot) or in the chat bar to launch the game!';
      await ctx.reply(menuText);
    } else if (err.message?.includes('Bad Request')) {
      console.error('[Signal Rush Bot] Bad Request:', err.message);
      await ctx.reply(text);
    } else {
      console.error('[Signal Rush Bot] Reply failed:', err.message);
    }
  }
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
    '🟡 Packet Hop — Cross the grid alive',
    '🔵 Packet Hop — Route packets at speed',
    '',
    'Tap the button below to play 👇',
  ].join('\n');

  await safeReply(ctx, text, { reply_markup: playKeyboard() });
});

bot.command('play', async (ctx) => {
  if (!MINI_APP_URL) {
    return ctx.reply('⚡ Mini App is not configured yet. Check back soon!');
  }
  await safeReply(ctx, '⚡ Tap to launch Signal Rush:', {
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
      '• AI Hunt    — Survive AI hazards, dodge obstacles',
      '• Packet Hop — Cross the grid through moving obstacles',
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
  console.warn('[Signal Rush Bot] MINI_APP_URL not set');
}

// Set global MenuButton so users can play from any chat
setMenuButton();

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
