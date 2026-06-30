// economy/tests/telegram-auth-test.js
// Unit tests for economy/telegram-auth.js
//
// Tests Telegram WebApp initData validation without requiring the full economy service.
// Uses a known bot token and constructs valid/invalid initData strings.

const assert = require('assert/strict');
const crypto = require('crypto');
const {
  validateInitData,
  parseInitData,
  buildDataCheckString,
  computeSignature,
} = require('../telegram-auth');

// ─── Helpers ─────────────────────────────────────────────────────────

const BOT_TOKEN = '123456:ABC-DEF-GHIJ-KLMN-OPQR-STUV-WXYZ';

/**
 * Build a valid initData string with a correct HMAC signature.
 * @param {object} overrides - Fields to override in the default initData
 * @returns {string} URL-encoded initData query string
 */
function makeValidInitData(overrides = {}) {
  const authDate = Math.floor(Date.now() / 1000);
  const user = {
    id: 987654321,
    first_name: 'Test',
    last_name: 'User',
    username: 'testuser',
    language_code: 'en',
    is_premium: false,
  };

  const fields = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
    ...overrides,
  };

  // Build data_check_string (sorted, no hash)
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');

  // Compute signature per Telegram WebAppData spec
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Build full query string
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`  ${err.message}`);
  }
}

// ─── parseInitData tests ─────────────────────────────────────────────

test('parseInitData: parses a simple query string', () => {
  const result = parseInitData('key1=value1&key2=value2');
  assert.equal(result.key1, 'value1');
  assert.equal(result.key2, 'value2');
});

test('parseInitData: handles URL-encoded values', () => {
  const result = parseInitData('user=%7B%22id%22%3A123%7D');
  assert.equal(result.user, '{"id":123}');
});

test('parseInitData: returns empty object for empty string', () => {
  const result = parseInitData('');
  assert.deepEqual(result, {});
});

// ─── buildDataCheckString tests ──────────────────────────────────────

test('buildDataCheckString: sorts keys alphabetically and excludes hash', () => {
  const fields = { z: '1', a: '2', hash: 'deadbeef', m: '3' };
  const result = buildDataCheckString(fields);
  assert.equal(result, 'a=2\nm=3\nz=1');
});

test('buildDataCheckString: handles single field', () => {
  const fields = { auth_date: '1234567890' };
  const result = buildDataCheckString(fields);
  assert.equal(result, 'auth_date=1234567890');
});

test('buildDataCheckString: handles empty fields (only hash was present)', () => {
  const fields = { hash: 'abc' };
  const result = buildDataCheckString(fields);
  assert.equal(result, '');
});

// ─── computeSignature tests ──────────────────────────────────────────

test('computeSignature: produces expected HMAC-SHA256 hex string', () => {
  const data = 'test_data';
  const token = 'my_bot_token';
  const result = computeSignature(data, token);

  // Manually compute expected per Telegram WebAppData spec
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(data).digest('hex');

  assert.equal(result, expected);
});

test('computeSignature: different tokens produce different signatures', () => {
  const data = 'same_data';
  const sig1 = computeSignature(data, 'token_a');
  const sig2 = computeSignature(data, 'token_b');
  assert.notEqual(sig1, sig2);
});

test('computeSignature: different data produce different signatures', () => {
  const token = 'same_token';
  const sig1 = computeSignature('data_a', token);
  const sig2 = computeSignature('data_b', token);
  assert.notEqual(sig1, sig2);
});

// ─── validateInitData: input validation tests ────────────────────────

test('validateInitData: rejects null initDataString', () => {
  const result = validateInitData(null, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'initDataString is required');
});

test('validateInitData: rejects undefined initDataString', () => {
  const result = validateInitData(undefined, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'initDataString is required');
});

test('validateInitData: rejects empty initDataString', () => {
  const result = validateInitData('', BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'initDataString is required');
});

test('validateInitData: rejects null botToken', () => {
  const result = validateInitData('some=data', null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'botToken is required');
});

test('validateInitData: rejects empty botToken', () => {
  const result = validateInitData('some=data', '');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'botToken is required');
});

test('validateInitData: rejects initData without hash field', () => {
  const result = validateInitData('user=test&auth_date=123', BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing hash field in initData');
});

// ─── validateInitData: signature validation tests ────────────────────

test('validateInitData: rejects initData with wrong hash', () => {
  const authDate = Math.floor(Date.now() / 1000);
  const user = JSON.stringify({ id: 123, first_name: 'Test' });
  const initData = `user=${encodeURIComponent(user)}&auth_date=${authDate}&hash=deadbeef`;
  const result = validateInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid hash');
});

test('validateInitData: rejects initData signed with wrong bot token', () => {
  const validData = makeValidInitData();
  const result = validateInitData(validData, 'wrong:token');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid hash');
});

test('validateInitData: rejects tampered user data', () => {
  const authDate = Math.floor(Date.now() / 1000);
  // Build with one user, then swap in another
  const realUser = { id: 111, first_name: 'Real' };
  const tamperedUser = { id: 999, first_name: 'Hacker' };

  const fields = {
    user: JSON.stringify(realUser),
    auth_date: String(authDate),
  };
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Use tampered user but original hash
  const params = new URLSearchParams({
    user: JSON.stringify(tamperedUser),
    auth_date: String(authDate),
    hash,
  });

  const result = validateInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid hash');
});

// ─── validateInitData: expiration tests ──────────────────────────────

test('validateInitData: rejects expired initData (>24h old)', () => {
  const oldAuthDate = Math.floor(Date.now() / 1000) - 100000; // >24h ago
  const initData = makeValidInitData({ auth_date: String(oldAuthDate) });
  const result = validateInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'initData expired');
});

test('validateInitData: rejects invalid auth_date', () => {
  const initData = makeValidInitData({ auth_date: 'not-a-number' });
  const result = validateInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid auth_date');
});

// ─── validateInitData: success tests ─────────────────────────────────

test('validateInitData: accepts valid initData', () => {
  const initData = makeValidInitData();
  const result = validateInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 987654321);
  assert.equal(result.user.first_name, 'Test');
  assert.equal(result.user.last_name, 'User');
  assert.equal(result.user.username, 'testuser');
  assert.equal(result.user.language_code, 'en');
  assert.equal(result.user.is_premium, false);
  assert.equal(typeof result.user.auth_date, 'number');
});

test('validateInitData: accepts valid initData with minimal user fields', () => {
  const user = { id: 42, first_name: 'Minimal' };
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
  };
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });

  const result = validateInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 42);
  assert.equal(result.user.first_name, 'Minimal');
  assert.equal(result.user.last_name, undefined);
  assert.equal(result.user.username, undefined);
});

test('validateInitData: accepts valid initData with photo_url', () => {
  const user = {
    id: 100,
    first_name: 'Photo',
    photo_url: 'https://t.me/i/userpic/320/abc.jpg',
  };
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
  };
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });

  const result = validateInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.user.photo_url, 'https://t.me/i/userpic/320/abc.jpg');
});

test('validateInitData: rejects initData with invalid user JSON', () => {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    user: 'not-valid-json{{{',
    auth_date: String(authDate),
  };
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });

  const result = validateInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'failed to parse user data');
});

test('validateInitData: rejects initData with missing user id', () => {
  const user = { first_name: 'NoId' }; // no id field
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
  };
  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });

  const result = validateInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid user data: missing id');
});

// ─── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
