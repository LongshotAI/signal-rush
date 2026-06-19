// Seeded pseudo-random number generator (mulberry32).
// Fast, good statistical quality, deterministic across runs.
// Used for reproducible game simulation, testing, daily challenges, replays.

function mulberry32(seed) {
  let state = seed >>> 0;
  return function () {
    state += 0x6d2b79f5;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), 1 | z);
    z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// Create an RNG from a seed (number or string).
// String seeds are hashed to a 32-bit integer.
function createRNG(seed) {
  if (typeof seed === 'string') {
    // Simple string hash (djb2-like)
    let hash = 5381;
    for (let i = 0; i < seed.length; i += 1) {
      hash = ((hash << 5) + hash) ^ seed.charCodeAt(i);
    }
    seed = hash >>> 0;
  }
  if (!Number.isFinite(seed)) seed = Date.now();
  return mulberry32(seed);
}

// Default RNG (non-deterministic) - uses Math.random
const defaultRNG = Math.random;

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// Get the daily challenge seed for a given date.
// All players on the same date get the same seed, enabling fair competition.
// Returns a numeric seed derived from hashing 'signal-rush-YYYY-MM-DD'.
function getDailyChallengeSeed(date = new Date()) {
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  // Use the same djb2 hash as createRNG for strings, but return the
  // numeric seed (not the RNG function).
  let hash = 5381;
  const str = `signal-rush-${dateStr}`;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

module.exports = {
  createRNG,
  defaultRNG,
  randInt,
  mulberry32,
  getDailyChallengeSeed,
};