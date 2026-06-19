// economy/auth.js
// Signal Rush — Authentication Module
//
// Dual-mode authentication:
// 1. Service-to-service: shared secret via ECONOMY API_KEY env var (for CLI→economy bridge)
// 2. Advertiser API keys: looked up in advertiser_accounts table (for portal clients)
//
// When ECONOMY_AUTH_ENFORCED is set to anything other than 'false',
// requests must include Authorization: Bearer <token>.
// The token is checked against both the shared secret and the
// advertiser_accounts table.
// To disable auth: set ECONOMY_AUTH_ENFORCED=false.
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

  // Always perform a constant-time comparison to avoid timing side-channels.
  // We zero-pad both sides to a fixed length regardless of input validity,
  // then compare. This ensures every code path takes the same time.
  const MAX_COMPARE_LEN = 64;
  const expectedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  const providedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);

  if (expectedKey) {
    Buffer.from(expectedKey).copy(expectedBuf, 0, 0, MAX_COMPARE_LEN);
  }

  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1].length <= MAX_KEY_LENGTH) {
      Buffer.from(parts[1]).copy(providedBuf, 0, 0, MAX_COMPARE_LEN);
    }
  }

  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  // If we reach here, buffers matched — but we still need to verify preconditions
  // (no key configured, or malformed header) without leaking which one.
  if (!expectedKey || !authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'unauthorized' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1].length > MAX_KEY_LENGTH) {
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

  // Always perform a constant-time comparison to avoid timing side-channels.
  // Zero-pad both sides to a fixed 64-byte length regardless of input validity,
  // then compare. This ensures every code path takes the same time.
  const MAX_COMPARE_LEN = 64;
  const providedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  let providedKey = '';

  // Parse without short-circuiting — extract key if format is valid
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      providedKey = parts[1];
      Buffer.from(providedKey).copy(providedBuf, 0, 0, MAX_COMPARE_LEN);
    }
  }

  // Perform the constant-time comparison against a dummy (always)
  // to keep timing uniform even if format parse failed
  const dummyKey = crypto.randomBytes(MAX_COMPARE_LEN).toString('hex');
  const dummyBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  Buffer.from(dummyKey).copy(dummyBuf, 0, 0, MAX_COMPARE_LEN);
  try { crypto.timingSafeEqual(dummyBuf, providedBuf); } catch {}

  // Look up advertiser by api_key
  const account = providedKey.length > 0
    ? db.prepare(
        'SELECT id, api_key, status FROM advertiser_accounts WHERE api_key = ?'
      ).get(providedKey)
    : null;

  if (!account) {
    return { ok: false, error: 'unauthorized' };
  }

  // Constant-time comparison (defense in depth — DB lookup already filtered)
  // Use fixed-length 64-byte zero-padded buffers
  const accountBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  Buffer.from(account.api_key).copy(accountBuf, 0, 0, MAX_COMPARE_LEN);

  if (!crypto.timingSafeEqual(accountBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  // Check account status
  if (account.status === 'suspended') {
    return { ok: false, error: 'unauthorized' };
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

  // Always perform a constant-time comparison to avoid timing side-channels.
  // Zero-pad both sides to a fixed length regardless of input validity.
  const MAX_COMPARE_LEN = 64;
  const expectedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);
  const providedBuf = Buffer.alloc(MAX_COMPARE_LEN, 0);

  if (adminKey && adminKey.trim().length > 0) {
    Buffer.from(adminKey.trim()).copy(expectedBuf, 0, 0, MAX_COMPARE_LEN);
  }

  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1].length <= MAX_KEY_LENGTH) {
      Buffer.from(parts[1]).copy(providedBuf, 0, 0, MAX_COMPARE_LEN);
    }
  }

  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, error: 'unauthorized' };
  }

  // Buffers matched — verify preconditions without leaking which failed
  if (!adminKey || adminKey.trim().length === 0 || !authHeader || typeof authHeader !== 'string') {
    return { ok: false, error: 'unauthorized' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1].length > MAX_KEY_LENGTH) {
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
