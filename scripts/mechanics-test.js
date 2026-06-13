const assert = require('node:assert/strict');

const { createEngine } = require('../src/core/engine');
const { createInitialState } = require('../src/core/createInitialState');
const { createInputBuffer } = require('../src/cli/input');
const { renderFrame } = require('../src/cli/render');

function testRawInitialStateRendersCleanSponsorLabel() {
  const frame = renderFrame(createInitialState(), { columns: 100, rows: 40 });
  assert(!frame.includes('undefined'), 'raw initial state should not render undefined sponsor label');
}

function testDirectionalInputIsOneShotWithoutKeyupSupport() {
  const input = createInputBuffer();
  input.handleKeypress('d', { name: 'd', sequence: 'd' });
  assert.deepEqual(input.consume().move, { x: 1, y: 0 }, 'first consume should include right move');
  assert.equal(input.consume().move, null, 'second consume should not keep moving forever without a fresh keypress');
}

function testPickupCollectedBeforeExpiryOnSameTick() {
  const engine = createEngine();
  const { state } = engine;
  state.pickups = [{ x: state.player.x, y: state.player.y, value: 40, ttl: 1 }];
  const scoreBefore = state.score;
  const creditsBefore = state.credits;

  engine.step({});

  assert(state.score > scoreBefore, 'pickup on player with ttl=1 should be collected before expiring');
  assert(state.credits > creditsBefore, 'pickup collection should award credits');
  assert.equal(state.pickups.some((p) => p.x === state.player.x && p.y === state.player.y), false, 'collected pickup should be removed');
}

function testDashUsesLastMoveAndCooldown() {
  const engine = createEngine();
  const start = { ...engine.state.player };
  engine.step({ move: { x: 1, y: 0 } });
  const afterMove = { ...engine.state.player };
  engine.step({ dash: true });
  const afterDash = { ...engine.state.player };

  assert.equal(afterMove.x, start.x + 1, 'normal move should move one cell');
  assert.equal(afterDash.x, afterMove.x + 2, 'dash with no current move should reuse last move for two cells');
  assert(engine.state.dashCooldown > 0, 'dash should start cooldown');
}

const tests = [
  testRawInitialStateRendersCleanSponsorLabel,
  testDirectionalInputIsOneShotWithoutKeyupSupport,
  testPickupCollectedBeforeExpiryOnSameTick,
  testDashUsesLastMoveAndCooldown,
];

for (const test of tests) {
  test();
  console.log(`PASS ${test.name}`);
}

console.log(`Mechanics tests passed: ${tests.length}`);
