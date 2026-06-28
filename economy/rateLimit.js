// economy/rateLimit.js
// Signal Rush — Rate Limiting
//
// In-memory sliding window rate limiter.
// Tracks requests per client key (player_id or IP) per endpoint prefix.
//
// Design decisions:
// - Sliding window (not fixed) — prevents burst at window boundaries
// - In-memory only — no external dependencies, resets on service restart
// - Configurable via environment variables
// - Returns 429 with Retry-After header when limit exceeded

const DEFAULT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;
const DEFAULT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000; // 1 minute

// Map<key, Array<timestamp>>
const windows = new Map();

/**
 * Clean up old entries to prevent unbounded memory growth.
 * Called periodically and on each check.
 * @param {number} now - Current timestamp
 * @param {number} windowMs - Window size in ms
 */
function cleanup(now, windowMs) {
  for (const [key, timestamps] of windows.entries()) {
    const valid = timestamps.filter(t => now - t < windowMs);
    if (valid.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, valid);
    }
  }
}

/**
 * Check if a client is rate limited.
 *
 * @param {string} key - Client identifier (player_id or IP address)
 * @param {number} max - Max requests in window
 * @param {number} windowMs - Window size in ms
 * @returns {{ limited: boolean, remaining: number, retryAfter: number }}
 */
function checkLimit(key, max = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();

  if (!windows.has(key)) {
    windows.set(key, []);
  }

  const timestamps = windows.get(key);
  // Remove expired entries
  const valid = timestamps.filter(t => now - t < windowMs);
  windows.set(key, valid);

  if (valid.length >= max) {
    const oldest = valid[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { limited: true, remaining: 0, retryAfter: Math.max(retryAfter, 1) };
  }

  // Record this request
  valid.push(now);
  windows.set(key, valid);

  return { limited: false, remaining: max - valid.length, retryAfter: 0 };
}

/**
 * Reset all rate limit windows (useful for testing).
 */
function reset() {
  windows.clear();
}

/**
 * Get current window stats (for monitoring).
 * @returns {{ keys: number, totalEntries: number }}
 */
function stats() {
  let total = 0;
  for (const timestamps of windows.values()) {
    total += timestamps.length;
  }
  return { keys: windows.size, totalEntries: total };
}

module.exports = {
  checkLimit,
  reset,
  stats,
  cleanup,
  DEFAULT_MAX,
  DEFAULT_WINDOW_MS,
};

// Periodic cleanup every 5 minutes to prevent unbounded memory growth.
// Unref'd so it doesn't keep the Node.js event loop alive.
setInterval(() => {
  cleanup(Date.now(), DEFAULT_WINDOW_MS);
}, 5 * 60 * 1000).unref?.();
