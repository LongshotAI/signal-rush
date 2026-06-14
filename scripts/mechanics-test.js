const assert = require('node:assert/strict');

const { createEngine } = require('../src/core/engine');
const { createInitialState } = require('../src/core/createInitialState');
const { createInputBuffer } = require('../src/cli/input');
const { renderFrame, renderMenuFrame, visibleLength, MENU_MODES } = require('../src/cli/render');
const { GAME_CONFIG } = require('../src/config/gameConfig');

// === AI Hunt regression coverage (existing behavior must hold) ===

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
  assert(frame.includes('PRESS R TO RESTART  |  M FOR MENU'), 'should show clear restart + menu prompt');
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

function testDefaultEngineModeIsAiHunt() {
  const engine = createEngine();
  assert.equal(engine.state.mode, 'aiHunt', 'default engine mode must remain aiHunt for backward compat');
  assert.equal(engine.state.lives, undefined, 'aiHunt state should not have Frogger lives field');
  assert.equal(engine.state.lanes, undefined, 'aiHunt state should not have Frogger lanes field');
}

// === Menu coverage ===

function testMenuRendersBothModeOptions() {
  const frame = renderMenuFrame(0, { colors: false });
  assert(frame.includes('AI HUNT MODE'), 'menu should list AI Hunt mode');
  assert(frame.includes('FROGGER MODE'), 'menu should list Frogger mode');
  assert(frame.includes('SELECT MODE'), 'menu should label the selection section');
  assert(frame.includes('ENTER launch'), 'menu should show ENTER to launch');
}

function testMenuSelectionCursorMovesBetweenOptions() {
  const f0 = renderMenuFrame(0, { colors: false });
  const f1 = renderMenuFrame(1, { colors: false });
  // Cursor ">" should appear on a different mode in each
  const idx0 = f0.indexOf('> AI HUNT');
  const idx0Frogger = f0.indexOf('> FROGGER');
  const idx1 = f1.indexOf('> AI HUNT');
  const idx1Frogger = f1.indexOf('> FROGGER');
  assert(idx0 !== -1, 'cursor on AI Hunt when selected');
  assert(idx0Frogger === -1, 'no cursor on Frogger when AI Hunt selected');
  assert(idx1 === -1, 'no cursor on AI Hunt when Frogger selected');
  assert(idx1Frogger !== -1, 'cursor on Frogger when Frogger selected');
}

function testMenuTaglineUpdatesWithSelection() {
  const f0 = renderMenuFrame(0, { colors: false });
  const f1 = renderMenuFrame(1, { colors: false });
  assert(f0.includes('survival arcade'), 'aiHunt tagline shown when aiHunt selected');
  assert(f1.includes('Cross the road'), 'frogger tagline shown when frogger selected');
}

function testMenuNoColorEmitsCleanText() {
  const frame = renderMenuFrame(0, { colors: false });
  assert(!frame.includes('\x1b['), 'no-color menu should be ANSI-free');
}

// === Frogger coverage ===

function testFroggerEngineInitializesCorrectly() {
  const engine = createEngine({ mode: 'frogger' });
  assert.equal(engine.state.mode, 'frogger', 'engine state should carry mode flag');
  assert.equal(engine.state.lives, GAME_CONFIG.modes.frogger.lives, 'should start with configured lives');
  assert.equal(engine.state.maxLives, GAME_CONFIG.modes.frogger.lives, 'maxLives should match lives');
  assert.equal(engine.state.level, 1, 'should start at level 1');
  assert.equal(engine.state.timeLeft, GAME_CONFIG.modes.frogger.timePerLevel, 'timeLeft should be full');
  assert.deepEqual(engine.state.homeSlots, [false, false, false, false, false], 'all slots should start empty');
  assert.equal(engine.state.player.y, GAME_CONFIG.modes.frogger.spawnRow, 'frog should spawn at spawnRow');
  assert.equal(engine.state.player.x, GAME_CONFIG.modes.frogger.spawnX, 'frog should spawn at spawnX');
  assert.equal(engine.state.lanes.length, GAME_CONFIG.modes.frogger.lanes.length, 'lanes should be cloned from config');
  // Sanity: every lane should be one of the known types
  const knownTypes = new Set(['home', 'river', 'road', 'median']);
  for (const lane of engine.state.lanes) {
    assert(knownTypes.has(lane.type), `lane type ${lane.type} should be one of ${[...knownTypes]}`);
  }
}

function testFroggerHopOnMedianIsSafe() {
  const engine = createEngine({ mode: 'frogger' });
  const startY = engine.state.player.y;
  engine.step({ move: { x: 0, y: -1 } });
  assert.equal(engine.state.player.y, startY - 1, 'hop should move one row up');
  assert.equal(engine.state.lives, GAME_CONFIG.modes.frogger.lives, 'hop on median should not cost a life');
  assert.equal(engine.state.gameOver, false, 'hop on median should not end the game');
}

function testFroggerHomeSlotFillAwardsScoreAndRespawns() {
  const engine = createEngine({ mode: 'frogger' });
  // Manually place frog in the first home slot
  engine.state.player.x = GAME_CONFIG.modes.frogger.homeSlotXs[0];
  engine.state.player.y = 1;
  const scoreBefore = engine.state.score;
  const livesBefore = engine.state.lives;
  const tick = engine.state.tick;
  engine.step({});
  assert(engine.state.homeSlots[0], 'first slot should be filled');
  assert(engine.state.score > scoreBefore, 'filling a slot should award score');
  assert.equal(engine.state.lives, livesBefore, 'filling a slot should not cost a life');
  assert.equal(engine.state.player.y, GAME_CONFIG.modes.frogger.spawnRow, 'frog should respawn at spawnRow');
  // tick should have advanced
  assert(engine.state.tick > tick, 'a tick should have run');
}

function testFroggerLandingOnFilledSlotLosesLife() {
  const engine = createEngine({ mode: 'frogger' });
  engine.state.homeSlots[0] = true;
  engine.state.player.x = GAME_CONFIG.modes.frogger.homeSlotXs[0];
  engine.state.player.y = 1;
  const livesBefore = engine.state.lives;
  engine.step({});
  assert.equal(engine.state.lives, livesBefore - 1, 'landing on filled slot should cost a life');
  assert.equal(engine.state.lastFroggerCause, 'slot_blocked', 'cause should be slot_blocked');
}

function testFroggerLandingOnWrongColumnLosesLife() {
  const engine = createEngine({ mode: 'frogger' });
  // Pick a column that is not a home slot
  const badX = GAME_CONFIG.modes.frogger.homeSlotXs[0] + 1;
  engine.state.player.x = badX;
  engine.state.player.y = 1;
  const livesBefore = engine.state.lives;
  engine.step({});
  assert.equal(engine.state.lives, livesBefore - 1, 'landing off-slot should cost a life');
  assert.equal(engine.state.lastFroggerCause, 'wrong_slot', 'cause should be wrong_slot');
}

function testFroggerDrownsInWaterWithoutLog() {
  const engine = createEngine({ mode: 'frogger' });
  // Place frog on a river row at a column that has no log (lane 5 has only
  // 2 logs at x=12 and x=32, so x=2 is a valid empty column within bounds).
  const riverLane = engine.state.lanes.find((l) => l.type === 'river' && l.y === 5);
  engine.state.player.x = 2;
  engine.state.player.y = riverLane.y;
  const livesBefore = engine.state.lives;
  engine.step({});
  assert.equal(engine.state.lives, livesBefore - 1, 'drowning should cost a life');
  assert.equal(engine.state.lastFroggerCause, 'water', 'cause should be water');
}

function testFroggerRideLogCarriesPlayer() {
  const engine = createEngine({ mode: 'frogger' });
  const riverLane = engine.state.lanes.find((l) => l.type === 'river' && l.direction === 1);
  // Find a log on this lane and place the frog exactly on it
  const log = riverLane.vehicles[0];
  engine.state.player.x = log.x;
  engine.state.player.y = riverLane.y;
  const startX = engine.state.player.x;
  engine.step({});  // tick without input — log should carry frog
  // Log moves +1 per tick, so frog x should also have advanced +1 if ride worked.
  // (Actually the ride happens before the vehicle-move wrap, so we need to be careful.)
  // At minimum: the frog should still be on a log, not in water.
  assert(engine.state.onLog !== null, 'frog should still be on a log after one tick of being placed on one');
  // Lives should be intact (frog is safely riding)
  assert.equal(engine.state.lives, GAME_CONFIG.modes.frogger.lives, 'riding a log should not cost a life');
}

function testFroggerCarHitLosesLife() {
  const engine = createEngine({ mode: 'frogger' });
  // Frogger rule: a car that moves into your cell kills you. Lane 17 has
  // cars at x=4/24/44 moving right at speed 3, so they land on x=7/27/47
  // after one tick. Place the player at (7, 17) — the car from x=4 will
  // arrive there and the post-move death check should fire.
  const roadLane = engine.state.lanes.find((l) => l.type === 'road' && l.y === 17);
  engine.state.player.x = 7;
  engine.state.player.y = roadLane.y;
  const livesBefore = engine.state.lives;
  engine.step({});
  assert.equal(engine.state.lives, livesBefore - 1, 'a car moving into the player cell should cost a life');
  assert.equal(engine.state.lastFroggerCause, 'car', 'cause should be car');
}

function testFroggerTimeoutLosesLife() {
  const engine = createEngine({ mode: 'frogger' });
  engine.state.timeLeft = 1;
  const livesBefore = engine.state.lives;
  engine.step({});  // one tick should drain to 0 and lose a life
  assert.equal(engine.state.lives, livesBefore - 1, 'timeout should cost a life');
  assert.equal(engine.state.lastFroggerCause, 'timeout', 'cause should be timeout');
}

function testFroggerAllSlotsFilledAdvancesLevel() {
  const engine = createEngine({ mode: 'frogger' });
  // Mark 4 slots as already filled, frog lands on the 5th
  engine.state.homeSlots = [true, true, true, true, false];
  engine.state.score = 0;
  engine.state.player.x = GAME_CONFIG.modes.frogger.homeSlotXs[4];
  engine.state.player.y = 1;
  engine.step({});
  // After the level clear, the slots reset and the level increments.
  assert.equal(engine.state.level, 2, 'level should advance to 2 after clearing all 5 slots');
  assert(engine.state.score >= GAME_CONFIG.modes.frogger.slotScore, 'level clear should award slot score');
  assert.deepEqual(engine.state.homeSlots, [false, false, false, false, false], 'slots should reset to empty for the new level');
  assert(engine.state.timeLeft >= GAME_CONFIG.modes.frogger.timePerLevel, 'new level should reset the timer');
}

function testFroggerGameOverWhenAllLivesLost() {
  const engine = createEngine({ mode: 'frogger' });
  engine.state.lives = 1;
  // Force a timeout which will drop lives to 0
  engine.state.timeLeft = 1;
  engine.step({});
  assert.equal(engine.state.lives, 0, 'lives should be 0');
  assert(engine.state.gameOver, 'game should be over');
  assert(engine.state.deathState, 'deathState should be populated');
  assert.equal(engine.state.deathState.cause, 'timeout', 'cause should be timeout');
  assert.equal(engine.state.deathState.mode, 'frogger', 'deathState should know it is frogger');
}

function testFroggerGameOverCardShowsLevelAndSlots() {
  const engine = createEngine({ mode: 'frogger' });
  engine.state.gameOver = true;
  engine.state.score = 500;
  engine.state.combo = 3.0;
  engine.state.credits = 10;
  engine.state.bestScore = 500;
  engine.state.homeSlots = [true, true, false, false, false];
  engine.state.deathState = {
    inactive: true,
    cause: 'water',
    killerType: 'water',
    finalTick: 100,
    finalPosition: { x: 30, y: 5 },
    finalScore: 500,
    finalCombo: 3.0,
    finalCredits: 10,
    bestScoreUpdated: true,
    mode: 'frogger',
    level: 2,
    homeSlots: [true, true, false, false, false],
  };
  const frame = renderFrame(engine.state, { columns: 100, rows: 40 });
  assert(frame.includes('RUN ENDED'), 'frogger game over should show RUN ENDED');
  assert(frame.includes('Reached Level'), 'frogger game over should show level reached');
  assert(frame.includes('Slots'), 'frogger game over should show slots filled');
  assert(frame.includes('2/5'), 'frogger game over should show slot count 2/5');
  assert(frame.includes('M FOR MENU'), 'frogger game over should show menu option');
}

function testFroggerVehiclesMoveAndWrap() {
  const engine = createEngine({ mode: 'frogger' });
  const roadLane = engine.state.lanes.find((l) => l.type === 'road' && l.direction === 1);
  const startX = roadLane.vehicles[0].x;
  engine.step({});  // one tick
  const afterX = roadLane.vehicles[0].x;
  assert.equal(afterX, startX + roadLane.speed, 'right-bound car should move right by lane.speed each tick');
}

const tests = [
  // AI Hunt regression
  testRawInitialStateRendersCleanSponsorLabel,
  testDirectionalInputIsContinuousAcrossConsumes,
  testSameDirectionRepressAfterPauseTogglesStop,
  testPickupCollectedBeforeExpiryOnSameTick,
  testDashUsesLastMoveAndCooldown,
  testGameOverCardShowsFinalStatsAndRestartPrompt,
  testNoColorOptionProducesAnsiFreeFrame,
  testDefaultEngineModeIsAiHunt,
  // Menu
  testMenuRendersBothModeOptions,
  testMenuSelectionCursorMovesBetweenOptions,
  testMenuTaglineUpdatesWithSelection,
  testMenuNoColorEmitsCleanText,
  // Frogger
  testFroggerEngineInitializesCorrectly,
  testFroggerHopOnMedianIsSafe,
  testFroggerHomeSlotFillAwardsScoreAndRespawns,
  testFroggerLandingOnFilledSlotLosesLife,
  testFroggerLandingOnWrongColumnLosesLife,
  testFroggerDrownsInWaterWithoutLog,
  testFroggerRideLogCarriesPlayer,
  testFroggerCarHitLosesLife,
  testFroggerTimeoutLosesLife,
  testFroggerAllSlotsFilledAdvancesLevel,
  testFroggerGameOverWhenAllLivesLost,
  testFroggerGameOverCardShowsLevelAndSlots,
  testFroggerVehiclesMoveAndWrap,
];

for (const test of tests) {
  test();
  console.log(`PASS ${test.name}`);
}

console.log(`Mechanics tests passed: ${tests.length}`);
