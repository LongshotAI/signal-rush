/**
 * bot.js — Signal Rush Telegram Bot
 *
 * Commands:
 *   /start  → Welcome + "🎮 Play Signal Rush" inline button (opens Mini App)
 *   /play   → Opens the Mini App directly via inline keyboard
 *   /stats  → Compact player stats from economy API (legacy alias for /status)
 *   /status → Comprehensive stats: balance, lifetime earnings, claimable rewards,
 *             VMCO sub-key status, best scores from economy + local persistence
 *   /redeem → Convert earned micros → VMCO sub-key (portable API credits for
 *             the player's own agents)
 *   /help   → Help text
 *
 * Environment variables:
 *   BOT_TOKEN        — Telegram bot token (required)
 *   MINI_APP_URL     — Telegram Mini App URL (required for /play button)
 *   ECONOMY_API_URL  — Economy service base URL (default: http://localhost:8720)
 *   ECONOMY_API_KEY  — Server-to-server shared secret for bot-authenticated
 *                      endpoints (/telegram/redeem). Set this in .env or
 *                      economy.env. Falls back gracefully when unset.
 *   NODE_ENV         — development|production (default: development)
 */

import { Bot, InlineKeyboard } from 'grammy';
import { config as loadDotenv } from 'dotenv';
loadDotenv();

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ECONOMY_API_URL = process.env.ECONOMY_API_URL || 'http://localhost:8720';
const ECONOMY_API_KEY = process.env.ECONOMY_API_KEY || process.env.SIGNAL_RUSH_ECONOMY_KEY || '';
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
async function configureBotUi() {
  if (!MINI_APP_URL) {
    console.warn('[Signal Rush Bot] MINI_APP_URL not set — skipping MenuButton setup');
    return;
  }
  try {
    await bot.api.setChatMenuButton({
      type: 'web_app',
      text: '🎮 Play Signal Rush',
      web_app: { url: MINI_APP_URL },
    });
    await bot.api.setMyCommands([
      { command: 'play', description: 'Launch Signal Rush' },
      { command: 'status', description: 'Check earnings and VMCO key' },
      { command: 'redeem', description: 'Convert earnings to credits' },
      { command: 'help', description: 'How to play' },
    ]);
    console.log('[Signal Rush Bot] MenuButton and commands configured');
  } catch (err) {
    console.error('[Signal Rush Bot] Failed to configure bot UI:', err.message);
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
    const body = await res.json();
    const player = body.player || body;
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

// ── /status — comprehensive stats with rewards + VMCO sub-key ────
// Surfaces everything a user needs to know at a glance:
//   - Identity (player_id, telegram_id)
//   - Lifetime credits (earned, spent, balance)
//   - Claimable rewards (the headline figure for /redeem)
//   - VMCO sub-key status (so users know if they already have API credits)
//   - Best scores from local persistence (if the user has played CLI)
// Falls back to a helpful error if the economy is unreachable, never
// crashes the bot.
bot.command('status', async (ctx) => {
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
          '📊 **No status yet**\n\n' +
          'You haven\'t played Signal Rush yet. Tap /play to launch the game and start earning!'
        );
      }
      throw new Error(`Economy API returned ${res.status}`);
    }
    const body = await res.json();
    const player = body.player || body;
    const lines = [
      `📊 **Signal Rush Status**`,
      '',
      `👤 Player: ${player.display_name || player.username || 'Anonymous'}`,
      `🆔 ID: \`${player.id?.slice(0, 8) || 'n/a'}\``,
      '',
      '💰 **Credits**',
      `  Balance: ${player.balance ?? 0}`,
      `  Lifetime earned: ${player.total_earned ?? 0}`,
      `  Lifetime spent: ${player.total_spent ?? 0}`,
    ];

    // Fetch claimable rewards — the figure that drives /redeem
    try {
      const rewardsRes = await fetch(`${ECONOMY_API_URL}/players/${player.id}/rewards`, {
        signal: AbortSignal.timeout(5000),
      });
      if (rewardsRes.ok) {
        const rewards = await rewardsRes.json();
        const earned = rewards.earned_micros || 0;
        const claimed = rewards.claimed_micros || 0;
        const available = earned - claimed;
        const availableCredits = Math.floor(available / 10000);
        lines.push('');
        lines.push('🎁 **Claimable Rewards**');
        lines.push(`  Earned: ${earned} micros`);
        lines.push(`  Claimed: ${claimed} micros`);
        lines.push(`  Available: ${available} micros (~${availableCredits} credits)`);
        if (available >= 10000) {
          lines.push('');
          lines.push('👉 Run /redeem to convert to API credits');
        }
      }
    } catch (e) {
      // rewards endpoint optional — don't fail the whole command
    }

    // VMCO sub-key status is included by the bot-safe Telegram player endpoint.
    // Do not call /vmco/sub-key here: that route is player-session protected.
    if (player.vmco) {
      lines.push('');
      lines.push('🔑 **API Key (VMCO)**');
      if (player.vmco.has_sub_key) {
        lines.push(`  Budget: ${player.vmco.budget_credits} credits`);
        lines.push(`  ID: \`${player.vmco.sub_key_id?.slice(0, 8) || ''}...\``);
        lines.push(`  Created: ${player.vmco.created_at?.split('T')[0] || 'n/a'}`);
      } else {
        lines.push('  None yet — /redeem to provision one');
      }
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Status fetch error:', err.message);
    await ctx.reply('⚠️ Could not fetch status right now. Try again later.');
  }
});

// ── /redeem — convert claimable rewards → VMCO sub-key ──────────
// Calls the bot-authenticated /telegram/redeem endpoint. Validates
// amount (must be a positive multiple of 10000 micros = 1 credit).
// On success, DMs the user the sub-key value and a reminder to use
// it in their own agents.
//
// Minimum: 1 credit (10,000 micros). Maximum per command: 100 credits
// (1,000,000 micros) to prevent fat-finger drain. Users with more
// than 100 credits available should run /redeem multiple times.
bot.command('redeem', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) {
    return ctx.reply('⚠️ Could not identify your Telegram account.');
  }

  if (!ECONOMY_API_KEY) {
    return ctx.reply(
      '⚠️ Redeem is not configured on this bot.\n\n' +
      'The bot admin must set ECONOMY_API_KEY to enable credit redemption.'
    );
  }

  // Parse optional amount: /redeem [amount_credits]
  // Examples: /redeem 5   → claim 5 credits (50000 micros)
  //           /redeem max → claim all available (capped at 100)
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  let amountMicros = null;

  if (args.length > 0) {
    const arg = args[0].toLowerCase();
    if (arg === 'max') {
      amountMicros = 'max';
    } else {
      const n = parseInt(arg, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        return ctx.reply(
          '⚠️ Invalid amount.\n\n' +
          'Usage: /redeem [credits]\n' +
          'Examples:\n' +
          '  /redeem 5   → claim 5 credits (50,000 micros)\n' +
          '  /redeem max → claim all available (up to 100 credits)\n' +
          '  /redeem     → claim default 1 credit (10,000 micros)',
          { parse_mode: 'Markdown' }
        );
      }
      amountMicros = n * 10000; // 1 credit = 10,000 micros
    }
  }

  // Look up player + available rewards
  let player, available;
  try {
    const pRes = await fetch(`${ECONOMY_API_URL}/telegram/player/${telegramId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (pRes.status === 404) {
      return ctx.reply(
        '⚠️ You don\'t have a Signal Rush account yet.\n\n' +
        'Tap /play to launch the game and start earning.'
      );
    }
    if (!pRes.ok) throw new Error(`player fetch ${pRes.status}`);
    const playerBody = await pRes.json();
    player = playerBody.player || playerBody;

    const rRes = await fetch(`${ECONOMY_API_URL}/players/${player.id}/rewards`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!rRes.ok) throw new Error(`rewards fetch ${rRes.status}`);
    const rewards = await rRes.json();
    available = (rewards.earned_micros || 0) - (rewards.claimed_micros || 0);
  } catch (err) {
    console.error('Redeem pre-check error:', err.message);
    return ctx.reply('⚠️ Could not check your balance right now. Try again later.');
  }

  // Resolve final amount
  if (amountMicros === null) {
    amountMicros = 10000; // default: 1 credit
  } else if (amountMicros === 'max') {
    if (available < 10000) {
      return ctx.reply(
        '⚠️ You don\'t have enough to redeem yet.\n\n' +
        `Available: ${available} micros\n` +
        'Minimum: 10,000 micros (1 credit)\n\n' +
        'Keep playing to earn more!'
      );
    }
    // Round down to nearest 10k, capped at 1M (100 credits)
    amountMicros = Math.min(1000000, Math.floor(available / 10000) * 10000);
  }

  if (amountMicros < 10000) {
    return ctx.reply(
      '⚠️ You need at least 1 credit (10,000 micros) to redeem.\n\n' +
      `Currently available: ${available} micros\n\n` +
      'Keep playing to earn more!'
    );
  }

  if (available < amountMicros) {
    return ctx.reply(
      '⚠️ Not enough rewards.\n\n' +
      `Requested: ${amountMicros} micros (${amountMicros / 10000} credits)\n` +
      `Available: ${available} micros (~${Math.floor(available / 10000)} credits)\n\n` +
      'Try `/redeem ' + Math.floor(available / 10000) + '` to claim what you have.'
    );
  }

  // Call the bot-authenticated redeem endpoint
  let result;
  try {
    const r = await fetch(`${ECONOMY_API_URL}/telegram/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ECONOMY_API_KEY}`,
      },
      body: JSON.stringify({
        telegram_id: String(telegramId),
        amount_micros: amountMicros,
      }),
      signal: AbortSignal.timeout(30000),
    });
    result = await r.json();
    if (!r.ok || !result.ok) {
      const errMsg = result.error || `HTTP ${r.status}`;
      if (r.status === 503 && errMsg.includes('low')) {
        return ctx.reply(
          '⚠️ API credit pool is temporarily low.\n\n' +
          'Try again in a few minutes, or ping the bot admin.'
        );
      }
      throw new Error(errMsg);
    }
  } catch (err) {
    console.error('Redeem error:', err.message);
    return ctx.reply(
      '⚠️ Redemption failed: ' + err.message + '\n\n' +
      'Your micros are still safe — try again later.'
    );
  }

  // Success — DM the user the sub-key value. Mark as new vs top-up.
  const creditsAdded = amountMicros / 10000;
  const newBudget = result.budget_credits;
  const keySnippet = result.sub_key ? `${result.sub_key.slice(0, 12)}...${result.sub_key.slice(-4)}` : 'n/a';
  const lines = [
    result.is_new ? '🎉 **VMCO API Key Provisioned!**' : '✅ **API Key Topped Up**',
    '',
    `🔑 Key: \`${result.sub_key}\``,
    '',
    `📊 Budget: **${newBudget} credits** (added ${creditsAdded})`,
    `🆔 ID: \`${result.sub_key_id}\``,
    '',
    '💡 **How to use it:**',
    'Set this as your LLM API key in your own agent config:',
    '  `OPENAI_API_KEY=' + result.sub_key + '`',
    '  `BASE_URL=https://api.vmco.ai/v1`',
    '',
    '🔒 **Keep it private.** Anyone with this key can spend your credits.',
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      '⚡ **Signal Rush — Help**',
      '',
      '/start  — Welcome & play button',
      '/play   — Launch the game',
      '/status — Your stats, rewards, and API key',
      '/redeem — Convert earnings to API credits',
      '/stats  — Compact stats (legacy)',
      '/help   — Show this message',
      '',
      '🎮 Modes:',
      '• AI Hunt    — Survive AI hazards, dodge obstacles',
      '• Packet Hop — Cross the grid through moving obstacles',
      '',
      '💰 **Earn while you play:**',
      'Every game you finish adds micros to your claimable balance.',
      'Use /redeem to convert micros into a portable API key for your own agents.',
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

bot.start({
  drop_pending_updates: true,
  onStart: async (botInfo) => {
    console.log(`[Signal Rush Bot] @${botInfo.username} is running`);
    await configureBotUi();
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
