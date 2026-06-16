// Determinism tests for Signal Rush seeded RNG.
// Proves: same seed = identical run; different seeds = divergent runs; direct RNG injection works.

const assert = require('node:assert/strict');
const { createEngine } = require('../src/core/engine');
const { createRNG } = require('../src/core/rng');

function simulateRun(seed, steps = 500, mode = 'aiHunt') {
  const engine = createEngine({ mode, seed });
  const { state } = engine;
  const snapshots = [];

  for (let i = 0; i < steps; i += 1) {
    if (state.gameOver) break;
    // Deterministic input: move right, dash every 20 ticks
    const input = i % 20 === 0 ? { move: { x: 1, y: 0 }, dash: true } : { move: { x: 1, y: 0 } };
    engine.step(input);
    snapshots.push({
      tick: state.tick,
      player: { x: state.player.x, y: state.player.y },
      health: state.player.health,
      score: state.score,
      hazards: state.hazards.map((h) => ({ x: h.x, y: h.y, kind: h.kind })),
      pickups: state.pickups.map((p) => ({ x: p.x, y: p.y, value: p.value, ttl: p.ttl })),
      dashCooldown: state.dashCooldown,
      combo: state.combo,
    });
  }
  return { finalScore: state.score, snapshots };
}

function simulateRunWithRNG(rng, steps = 500, mode = 'aiHunt') {
  const engine = createEngine({ mode, rng });
  const { state } = engine;
  const snapshots = [];

  for (let i = 0; i < steps; i += 1) {
    if (state.gameOver) break;
    const input = i % 20 === 0 ? { move: { x: 1, y: 0 }, dash: true } : { move: { x: 1, y: 0 } };
    engine.step(input);
    snapshots.push({
      tick: state.tick,
      player: { x: state.player.x, y: state.player.y },
      health: state.player.health,
      score: state.score,
      hazards: state.hazards.map((h) => ({ x: h.x, y: h.y, kind: h.kind })),
      pickups: state.pickups.map((p) => ({ x: p.x, y: p.y, value: p.value, ttl: p.ttl })),
      dashCooldown: state.dashCooldown,
      combo: state.combo,
    });
  }
  return { finalScore: state.score, snapshots };
}

function testSameSeedProducesIdenticalRuns() {
  console.log('Testing: same seed produces identical runs...');
  const run1 = simulateRun(42, 300);
  const run2 = simulateRun(42, 300);
  assert.deepEqual(run1, run2, 'Run with seed 42 must be identical');
  console.log('  PASS');
}

function testDifferentSeedsProduceDifferentRuns() {
  console.log('Testing: different seeds produce different runs...');
  const run1 = simulateRun(42, 300);
  const run2 = simulateRun(43, 300);
  // They should differ in at least some aspect
  const different = run1.finalScore !== run2.finalScore ||
    !run1.snapshots.every((s, i) => s.player.x === run2.snapshots[i]?.player.x && s.player.y === run2.snapshots[i]?.player.y);
  assert(different, 'Runs with different seeds should diverge');
  console.log('  PASS');
}

function testDirectRNGInjection() {
  console.log('Testing: direct RNG injection works...');
  const rng = createRNG(12345);
  const run1 = simulateRunWithRNG(rng, 300);
  const rng2 = createRNG(12345);
  const run2 = simulateRunWithRNG(rng2, 300);
  assert.deepEqual(run1, run2, 'Direct RNG injection with same seed must be identical');
  console.log('  PASS');
}

function testFroggerModeDeterminism() {
  console.log('Testing: Frogger mode determinism...');
  const run1 = simulateRun(999, 200, 'frogger');
  const run2 = simulateRun(999, 200, 'frogger');
  assert.deepEqual(run1, run2, 'Frogger run with seed 999 must be identical');
  console.log('  PASS');
}

function testStringSeed() {
  console.log('Testing: string seed works...');
  const run1 = simulateRun('daily-challenge-2026-06-15', 200);
  const run2 = simulateRun('daily-challenge-2026-06-15', 200);
  assert.deepEqual(run1, run2, 'String seed must produce identical runs');
  console.log('  PASS');
}

function testResetPreservesDeterminism() {
  console.log('Testing: engine.reset() preserves determinism...');
  const engine = createEngine({ mode: 'aiHunt', seed: 777 });
  const { state } = engine;

  // Run 100 ticks
  for (let i = 0; i < 100; i += 1) engine.step({ move: { x: 0, y: -1 } });
  const scoreAt100 = state.score;
  const snapshot1 = { score: state.score, player: { ...state.player }, hazards: state.hazards.map(h => ({ ...h })) };

  // Reset
  engine.reset();

  // Run 100 ticks again with same inputs
  for (let i = 0; i < 100; i += 1) engine.step({ move: { x: 0, y: -1 } });
  const snapshot2 = { score: state.score, player: { ...state.player }, hazards: state.hazards.map(h => ({ ...h })) };

  assert.deepEqual(snapshot1, snapshot2, 'Reset + same inputs must produce same state');
  console.log('  PASS');
}

function testReplayCompatibility() {
  console.log('Testing: replay compatibility (record inputs, replay with same seed)...');
  const steps = 200;
  const inputs = [];
  for (let i = 0; i < steps; i += 1) {
    inputs.push(i % 30 === 0 ? { move: { x: 1, y: 0 }, dash: true } : { move: { x: 0, y: -1 } });
  }

  // Record run
  const engine1 = createEngine({ mode: 'aiHunt', seed: 555 });
  for (const input of inputs) {
    if (engine1.state.gameOver) break;
    engine1.step(input);
  }
  const recordedScore = engine1.state.score;

  // Replay with same seed and inputs
  const engine2 = createEngine({ mode: 'aiHunt', seed: 555 });
  for (const input of inputs) {
    if (engine2.state.gameOver) break;
    engine2.step(input);
  }
  const replayedScore = engine2.state.score;

  assert.equal(recordedScore, replayedScore, 'Replay must match recorded score exactly');
  console.log('  PASS');
}

function testRNGQuality() {
  console.log('Testing: RNG statistical quality (no obvious patterns)...');
  const rng = createRNG(42);
  const samples = Array.from({ length: 10000 }, () => rng());
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert(mean > 0.45 && mean < 0.55, `RNG mean ${mean} should be ~0.5`);
  console.log('  PASS');
}

// Run all tests
console.log('\n=== Signal Rush Determinism Tests ===\n');

try {
  testRNGQuality();
  testSameSeedProducesIdenticalRuns();
  testDifferentSeedsProduceDifferentRuns();
  testDirectRNGInjection();
  testFroggerModeDeterminism();
  testStringSeed();
  testResetPreservesDeterminism();
  testReplayCompatibility();
  console.log('\n✅ ALL DETERMINISM TESTS PASSED');
} catch (e) {
  console.error('\n❌ TEST FAILED:', e.message);
  process.exit(1);
}