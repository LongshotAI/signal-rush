const assert = require('node:assert/strict');

const { createEngine } = require('../src/core/engine');
const { createInitialState } = require('../src/core/createInitialState');
const { createInputBuffer } = require('../src/cli/input');
const { renderFrame, visibleLength } = require('../src/cli/render');

function testRawInitialStateRendersCleanSponsorLabel() {
  const frame = renderFrame(createInitialState(), { columns: 100, rows: 40 });
  assert(!frame.includes('undefined'), 'raw initial state should not render undefined sponsor label');
}

function testDirectionalInputIsContinuousAcrossConsumes() {
  const input = createInputBuffer();
  input.handleKeypress('d', { name: 'd', sequence: 'd' });
  assert.deepEqual(input.consume().move, { x: 1, y: 0 }, 'first consume should include right move');
  assert.deepEqual(input.consume().move, { x: 1, y: 0 }, 'second consume should keep moving right (continuous)');

  input.handleKeypress('w', { name: 'w', sequence: 'w' });
  assert.deepEqual(input.consume().move, { x: 0, y: -1 }, 'different direction should switch');

  input.handleKeypress('s', { name: 's', sequence: 's' });
  assert.deepEqual(input.consume().move, { x: 0, y: 1 }, 'switch again');
}

function testSameDirectionRepressAfterPauseTogglesStop() {
  const realDateNow = Date.now;
  let mockTime = 1_000_000;
  Date.now = () => mockTime;
  try {
    const input = createInputBuffer();
    input.handleKeypress('d', { name: 'd', sequence: 'd' });
    assert.deepEqual(input.consume().move, { x: 1, y: 0 });
    // Advance well past the 200ms auto-repeat window
    mockTime += 500;
    input.handleKeypress('d', { name: 'd', sequence: 'd' });
    assert.equal(input.consume().move, null, 'same direction pressed after a pause should stop movement');
  } finally {
    Date.now = realDateNow;
  }
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

function testGameOverCardShowsFinalStatsAndRestartPrompt() {
  const engine = createEngine();
  engine.state.gameOver = true;
  engine.state.score = 1234;
  engine.state.combo = 5.6;
  engine.state.credits = 42;
  engine.state.bestScore = 1234;
  engine.state.deathState = {
    inactive: true,
    cause: 'hazard_contact',
    killerType: 'corruptor',
    finalTick: 100,
    finalPosition: { x: 10, y: 10 },
    finalScore: 1234,
    finalCombo: 5.6,
    finalCredits: 42,
    bestScoreUpdated: true,
  };
  const frame = renderFrame(engine.state, { columns: 100, rows: 40 });
  assert(frame.includes('RUN ENDED'), 'should show RUN ENDED header');
  assert(frame.includes('Final Score'), 'should label final score');
  assert(frame.includes('1234'), 'should show final score value');
  assert(frame.includes('x5.6'), 'should show final combo with x prefix');
  assert(frame.includes('Credits Earned'), 'should label credits earned');
  assert(frame.includes('NEW'), 'should mark new personal best when applicable');
  assert(frame.includes('PRESS R TO RESTART'), 'should show clear restart prompt');
  assert(frame.includes('MANUAL TEST MODE'), 'should keep the dev manual test mode line');
}

function testNoColorOptionProducesAnsiFreeFrame() {
  const engine = createEngine();
  engine.state.gameOver = true;
  engine.state.score = 500;
  engine.state.combo = 3.0;
  engine.state.credits = 20;
  engine.state.bestScore = 500;
  engine.state.deathState = {
    finalScore: 500, finalCombo: 3.0, finalCredits: 20, bestScoreUpdated: true,
  };
  const frame = renderFrame(engine.state, { columns: 100, rows: 40 }, { colors: false });
  assert(!frame.includes('\x1b['), 'no-color frame should contain no ANSI escape codes');
  assert.equal(visibleLength(frame), frame.length, 'no-color frame length should equal visible length');
}

const tests = [
  testRawInitialStateRendersCleanSponsorLabel,
  testDirectionalInputIsContinuousAcrossConsumes,
  testSameDirectionRepressAfterPauseTogglesStop,
  testPickupCollectedBeforeExpiryOnSameTick,
  testDashUsesLastMoveAndCooldown,
  testGameOverCardShowsFinalStatsAndRestartPrompt,
  testNoColorOptionProducesAnsiFreeFrame,
];

for (const test of tests) {
  test();
  console.log(`PASS ${test.name}`);
}

console.log(`Mechanics tests passed: ${tests.length}`);
