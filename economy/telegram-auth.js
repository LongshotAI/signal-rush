// economy/telegram-auth.js
// Signal Rush — Telegram WebApp initData Validation
//
// Validates the initData string sent by a Telegram Mini App.
// Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// Telegram sends initData as a URL-encoded query string in the WebApp.initData field.
// Validation steps:
//   1. Parse the query string
//   2. Extract the hash field (this is the signature)
//   3. Sort all remaining fields lexicographically by key
//   4. Build data_check_string: "key=value\nkey=value\n..." (newline-separated)
//   5. Compute secret_key = HMAC-SHA256(bot_token, "WebAppData")
//   6. Compute HMAC-SHA256(data_check_string, secret_key)
//   7. Compare hex-encoded hash with the provided hash (constant-time)
//
// This module is standalone — no dependencies on the rest of the economy service.

const crypto = require('crypto');

/**
 * Parse a URL-encoded query string into an object.
 * Does NOT decode the 'user' field (it's JSON-encoded by Telegram).
 * @param {string} queryString
 * @returns {Record<string, string>}
 */
function parseInitData(queryString) {
  const params = new URLSearchParams(queryString);
  const result = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

/**
 * Compute the data_check_string from parsed initData fields.
 * Excludes the 'hash' field, sorts remaining keys alphabetically,
 * and joins as "key=value\nkey=value\n..."
 * @param {Record<string, string>} fields
 * @returns {string}
 */
function buildDataCheckString(fields) {
  const keys = Object.keys(fields).filter(k => k !== 'hash').sort();
  return keys.map(k => `${k}=${fields[k]}`).join('\n');
}

/**
 * Compute HMAC-SHA256 of the data_check_string using Telegram WebAppData.
 * Telegram Mini Apps derive the secret key as HMAC_SHA256(bot_token, "WebAppData").
 * @param {string} dataCheckString
 * @param {string} botToken
 * @returns {string} Hex-encoded HMAC-SHA256 digest
 */
function computeSignature(dataCheckString, botToken) {
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  return crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

/**
 * Validate Telegram WebApp initData.
 *
 * @param {string} initDataString - The raw initData query string from Telegram
 * @param {string} botToken - Your Telegram bot token (e.g. "123456:ABC-DEF...")
 * @returns {{ ok: true, user: { id: number, first_name: string, last_name?: string, username?: string, language_code?: string, is_premium?: boolean, photo_url?: string, auth_date: number } } | { ok: false, error: string }}
 */
function validateInitData(initDataString, botToken) {
  if (!initDataString || typeof initDataString !== 'string') {
    return { ok: false, error: 'initDataString is required' };
  }

  if (!botToken || typeof botToken !== 'string') {
    return { ok: false, error: 'botToken is required' };
  }

  // 1. Parse the query string
  let fields;
  try {
    fields = parseInitData(initDataString);
  } catch (err) {
    return { ok: false, error: 'failed to parse initData' };
  }

  // 2. Extract the hash
  const providedHash = fields.hash;
  if (!providedHash) {
    return { ok: false, error: 'missing hash field in initData' };
  }

  // 3. Build data_check_string (sorted, excluding hash)
  const dataCheckString = buildDataCheckString(fields);

  // 4. Compute expected hash
  const expectedHash = computeSignature(dataCheckString, botToken);

  // 5. Constant-time comparison
  const providedBuf = Buffer.from(providedHash, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');

  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, error: 'invalid hash' };
  }

  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, error: 'invalid hash' };
  }

  // 6. Parse user data
  let user;
  try {
    user = JSON.parse(fields.user);
  } catch (err) {
    return { ok: false, error: 'failed to parse user data' };
  }

  if (!user || typeof user.id !== 'number') {
    return { ok: false, error: 'invalid user data: missing id' };
  }

  // 7. Check auth_date is not too old (optional but recommended — 24h max)
  const authDate = parseInt(fields.auth_date, 10);
  if (isNaN(authDate)) {
    return { ok: false, error: 'invalid auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  const maxAge = 86400; // 24 hours in seconds
  // Reject future auth_date (clock skew > 60s)
  if (authDate > now + 60) {
    return { ok: false, error: 'initData auth_date is in the future' };
  }
  if (now - authDate > maxAge) {
    return { ok: false, error: 'initData expired' };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      first_name: user.first_name || '',
      last_name: user.last_name || undefined,
      username: user.username || undefined,
      language_code: user.language_code || undefined,
      is_premium: user.is_premium !== undefined ? user.is_premium : undefined,
      photo_url: user.photo_url || undefined,
      auth_date: authDate,
    },
  };
}

module.exports = {
  validateInitData,
  parseInitData,
  buildDataCheckString,
  computeSignature,
};
