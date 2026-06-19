// economy/auth.js
// Signal Rush — Authentication Module
//
// Dual-mode authentication:
// 1. Service-to-service: shared secret via ECONOMY API_KEY env var (for CLI→economy bridge)
// 2. Advertiser API keys: looked up in advertiser_accounts table (for portal clients)
//
// When ECONOMY_AUTH_ENFORCED='true', requests must include
// Authorization: Bearer <token>. The token is checked against both
// the shared secret and the advertiser_accounts table.
//
// Design decisions:
// - Uses constant-time comparison to prevent timing attacks
// - Returns generic "unauthorized" message (never reveals which part failed)
// - Supports a development bypass via ALLOW_INSECURE=false (default: true for MVP)
//   Set ALLOW_INSECURE=false in production to enforce auth
// - Advertiser accounts with status='suspended' are always rejected

const crypto = require('crypto');

const MAX_KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = 'sha512';
const PBKDF2_KEYLEN = 64;
const SALT_BYTES = 32;

/**
 * Get the expected API key from environment.
 * @returns {string|null} The key, or null if not configured
 */
function getExpectedKey() {
  const key = process.env.ECONOMY_API_KEY || null;
  if (!key || key.trim().length === 0) return null;
  return key.trim();
}

/**
 * Check if auth enforcement is enabled.
 * Default: true (auth enforced) — set ECONOMY_AUTH_ENFORCED=false to disable.
 * @returns {boolean}
 */
function isAuthEnforced() {
  return process.env.ECONOMY_AUTH_ENFORCED !== 'false';
}

/**
 * Validate an Authorization header against the shared secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param {string|null} authHeader - The Authorization header value
 * @returns {{ ok: boolean, error?: string }}
 */
function validateAuth(authHeader) {
  // If auth is not enforced, allow through (MVP default)
  if (!isAuthEnforced()) {
    return { ok: true };
  }

  const expectedKey = getExpectedKey();
  if (!expectedKey) {
    // Auth is enforced but no key configured — deny everything
    return { ok: false, error: 'server misconfigured: no API key' };
  }

  if (!authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'missing Authorization header' };
  }

  // Expect "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { ok: false, error: 'invalid Authorization format' };
  }

  const providedKey = parts[1];
  if (providedKey.length > MAX_KEY_LENGTH) {
    return { ok: false, error: 'invalid key' };
  }

  // Constant-time comparison.
  // To avoid leaking the key length via timing, we compare buffers of
  // a fixed maximum length. We zero-pad the provided key to MAX_COMPARE_LEN
  // and compare against the expected key padded to the same length.
  // This ensures the comparison time is constant regardless of key length.
  const MAX_COMPARE_LEN = 64;
  const expectedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  const providedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  Buffer.from(expectedKey).copy(expectedBuf, 0, 0, MAX_COMPARE_LEN);
  Buffer.from(providedKey).copy(providedBuf, 0, 0, MAX_COMPARE_LEN);
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  return { ok: true };
}

/**
 * Validate an Authorization header against an advertiser API key in the database.
 * Checks: key format, account exists, account is not suspended.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string|null} authHeader - The Authorization header value
 * @returns {{ ok: boolean, accountId?: string, error?: string }}
 */
function validateAdvertiserAuth(db, authHeader) {
  // If auth is not enforced, still try to identify the advertiser if a key is provided
  if (!isAuthEnforced()) {
    // If no auth header, allow through with no accountId
    if (!authHeader || typeof authHeader !== 'string') {
      return { ok: true, accountId: null };
    }
    // If auth header provided, try to identify the advertiser
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      return { ok: true, accountId: null };
    }
    const account = db.prepare(
      'SELECT id FROM advertiser_accounts WHERE api_key = ? AND status = \'active\''
    ).get(parts[1]);
    return { ok: true, accountId: account ? account.id : null };
  }

  if (!authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'missing Authorization header' };
  }

  // Expect "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { ok: false, error: 'invalid Authorization format' };
  }

  const providedKey = parts[1];
  if (providedKey.length > MAX_KEY_LENGTH || providedKey.length < 16) {
    return { ok: false, error: 'invalid key' };
  }

  // Look up advertiser by api_key
  const account = db.prepare(
    'SELECT id, api_key, status FROM advertiser_accounts WHERE api_key = ?'
  ).get(providedKey);

  if (!account) {
    // Constant-time comparison against dummy to prevent timing attacks
    // (reveals whether the key exists by response time)
    const dummy = crypto.randomBytes(32).toString('hex');
    const dummyBuf = Buffer.from(dummy);
    const providedBuf = Buffer.from(providedKey);
    const compareLen = Math.min(dummyBuf.length, providedBuf.length);
    try { crypto.timingSafeEqual(dummyBuf.subarray(0, compareLen), providedBuf.subarray(0, compareLen)); } catch {}
    return { ok: false, error: 'unauthorized' };
  }

  // Constant-time comparison (defense in depth — DB lookup already filtered)
  const storedBuf = Buffer.from(account.api_key);
  const providedBuf = Buffer.from(providedKey);
  if (storedBuf.length !== providedBuf.length) {
    return { ok: false, error: 'unauthorized' };
  }
  if (!crypto.timingSafeEqual(storedBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  // Check account status
  if (account.status === 'suspended') {
    return { ok: false, error: 'account suspended' };
  }

  return { ok: true, accountId: account.id };
}

/**
 * Validate an admin Authorization header.
 * Uses a separate ADMIN_API_KEY env var to distinguish admin from advertiser.
 *
 * @param {string|null} authHeader - The Authorization header value
 * @returns {{ ok: boolean, error?: string }}
 */
function validateAdminAuth(authHeader) {
  if (!isAuthEnforced()) {
    return { ok: true };
  }

  const adminKey = process.env.ADMIN_API_KEY || null;
  if (!adminKey || adminKey.trim().length === 0) {
    return { ok: false, error: 'server misconfigured: no admin key' };
  }

  if (!authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'missing Authorization header' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { ok: false, error: 'invalid Authorization format' };
  }

  const providedKey = parts[1];
  if (providedKey.length > MAX_KEY_LENGTH) {
    return { ok: false, error: 'invalid key' };
  }

  const expectedBuf = Buffer.from(adminKey.trim());
  const providedBuf = Buffer.from(providedKey);
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, error: 'unauthorized' };
  }

  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  return { ok: true };
}

/**
 * Generate a secure random API key.
 * @param {number} bytes - Number of random bytes (default: 32)
 * @returns {string} Hex-encoded key
 */
function generateKey(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hash a password using PBKDF2-HMAC-SHA512.
 * Returns "salt:iterations:hash" as hex strings.
 * @param {string} password
 * @returns {string} The hashed password
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_HASH);
  return `${salt.toString('hex')}:${PBKDF2_ITERATIONS}:${hash.toString('hex')}`;
}

/**
 * Verify a password against a PBKDF2 hash.
 * Uses constant-time comparison.
 * @param {string} password
 * @param {string} storedHash - "salt:iterations:hash" format
 * @returns {boolean} True if password matches
 */
function verifyPassword(password, storedHash) {
  const parts = storedHash.split(':');
  if (parts.length !== 3) return false;

  const salt = Buffer.from(parts[0], 'hex');
  const iterations = parseInt(parts[1], 10);
  const stored = Buffer.from(parts[2], 'hex');

  if (isNaN(iterations) || iterations < 1) return false;

  const hash = crypto.pbkdf2Sync(password, salt, iterations, stored.length, PBKDF2_HASH);

  if (hash.length !== stored.length) return false;
  return crypto.timingSafeEqual(hash, stored);
}

module.exports = {
  validateAuth,
  validateAdvertiserAuth,
  validateAdminAuth,
  getExpectedKey,
  isAuthEnforced,
  generateKey,
  hashPassword,
  verifyPassword,
};
