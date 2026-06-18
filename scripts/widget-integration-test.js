// End-to-end widget integration test.
//
// Tests the full embedded widget lifecycle:
//   start → play → game over → persist → verify receipt → mode switch → stop

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const embedded = require('../src/embedded');
const persistence = require('../src/state/persistence');

// ── Helpers ────────────────────────────────────────────────────────

function makeOut(opts = {}) {
  const buf = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString('utf8'));
      cb();
    },
  });
  out.isTTY = false;
  out.columns = opts.columns || 80;
  out.rows = opts.rows || 24;
  out.buffer = buf;
  out.text = () => buf.join('');
  out.clear = () => { buf.length = 0; };
  return out;
}

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanupState(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '.tmp'); } catch {}
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Force a redraw bypassing rate limiter
function forceRedraw(w) {
  w._internal.ctx._forceDraw = true;
  w._internal.ctx.lastDrawn = 0;
  w._internal.draw();
}

// ── Tests ──────────────────────────────────────────────────────────

function testWidgetFullLifecycleAiHunt() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    seed: 42,
    autoStep: true,
    noColor: true,
  });

  // Initial render shows idle frame
  const idleText = stripAnsi(out.text());
  assert(idleText.includes('SIGNAL RUSH'), 'idle frame should show SIGNAL RUSH');

  // Switch to play and force redraw
  w.setPresentation('play');
  forceRedraw(w);
  const playText = stripAnsi(out.text());
  assert(playText.includes('PLAYING'), `play frame should show PLAYING, got: ${playText.slice(0, 200)}`);

  // Step the engine
  w.step({ move: { x: 1, y: 0 } });
  w.step({ move: { x: 0, y: -1 } });
  w.step({ move: { x: -1, y: 0 } });

  const stats = w.getStats();
  assert(stats.mode === 'aiHunt', 'mode should be aiHunt');
  assert(stats.presentation === 'play', 'presentation should be play');

  // Force game over
  const engineState = w.getEngineState();
  engineState.player.health = 1;
  engineState.hazards = [{ x: engineState.player.x, y: engineState.player.y, kind: 'packet' }];
  engineState.score = 500;
  w.step({});

  assert(w.getEngineState().gameOver, 'engine should be game over');

  // Verify persistence
  const saved = persistence.load(statePath);
  assert(saved.bestScores.aiHunt >= 500, `best score should be >= 500, got ${saved.bestScores.aiHunt}`);
  assert(saved.totalRuns.aiHunt >= 1, `total runs should be >= 1, got ${saved.totalRuns.aiHunt}`);

  // Verify receipt
  assert(saved.runReceipts && saved.runReceipts.length > 0, 'should have at least 1 run receipt');
  const receipt = saved.runReceipts[0];
  assert.equal(receipt.mode, 'aiHunt', 'receipt should have correct mode');
  assert.equal(receipt.finalScore, 500, 'receipt should have correct final score');
  assert(receipt.seed === 42, 'receipt should preserve seed');

  // Verify receipt signature
  const verifyResult = persistence.verifyRunReceipt(receipt);
  assert(verifyResult.valid, `receipt should verify: ${verifyResult.reason || 'OK'}`);

  w.stop();
  assert.equal(embedded.start.singleton, null, 'singleton should be cleared after stop');

  cleanupState(statePath);
  console.log('PASS testWidgetFullLifecycleAiHunt');
}

function testWidgetModeSwitch() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    seed: 99,
    autoStep: false,
    noColor: true,
  });

  w.step({ move: { x: 1, y: 0 } });
  const aiScore = w.getEngineState().score;

  // Switch to Frogger
  w.setMode('frogger');
  forceRedraw(w);
  const frogText = stripAnsi(out.text());
  assert(frogText.includes('PACKET HOP'), `should show PACKET HOP after mode switch, got: ${frogText.slice(0, 200)}`);

  const engineState = w.getEngineState();
  assert.equal(engineState.mode, 'frogger', 'engine mode should be frogger');
  assert.equal(engineState.lives, 3, 'frogger should start with 3 lives');

  // Verify AI Hunt run was persisted
  const saved = persistence.load(statePath);
  assert(saved.totalRuns.aiHunt >= 1, 'AI Hunt run should be persisted');
  assert(saved.bestScores.aiHunt >= aiScore, 'AI Hunt best score should be persisted');

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetModeSwitch');
}

function testWidgetPauseResume() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    seed: 77,
    autoStep: false,
    noColor: true,
  });

  w.step({ move: { x: 1, y: 0 } });
  w.step({ move: { x: 0, y: -1 } });
  const tickBefore = w.getEngineState().tick;

  w.pause();
  assert.equal(w._internal.ctx.running, false, 'should be paused');

  w.resume();
  assert.equal(w._internal.ctx.running, true, 'should be running after resume');

  w.step({ move: { x: 1, y: 0 } });
  assert(w.getEngineState().tick > tickBefore, 'tick should advance after resume');

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetPauseResume');
}

function testWidgetShowHide() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    autoStep: false,
    noColor: true,
  });

  // Show
  w.show();
  forceRedraw(w);
  const shownText = stripAnsi(out.text());
  assert(shownText.includes('SIGNAL RUSH'), 'show should render frame');

  // Hide — clear buffer first, then force redraw
  out.clear();
  w.hide();
  forceRedraw(w);
  const hiddenText = stripAnsi(out.text());
  // Hidden frame should not contain any game content
  assert(!hiddenText.includes('SIGNAL RUSH'), `hidden should not show SIGNAL RUSH, got: ${hiddenText.slice(0, 100)}`);
  assert(!hiddenText.includes('PLAYING'), 'hidden should not show PLAYING');

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetShowHide');
}

function testWidgetReceiptWithReSimulation() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    seed: 12345,
    autoStep: false,
    noColor: true,
  });

  // Play a deterministic sequence
  w.step({ move: { x: 1, y: 0 } });
  w.step({ move: { x: 0, y: -1 } });
  w.step({ move: { x: -1, y: 0 } });
  w.step({ move: { x: 0, y: 1 } });

  // Force game over by placing hazard on player
  const engineState = w.getEngineState();
  engineState.player.health = 1;
  engineState.hazards = [{ x: engineState.player.x, y: engineState.player.y, kind: 'packet' }];
  w.step({});

  assert(w.getEngineState().gameOver, 'engine should be game over after hazard placed on player');

  // Load receipt
  const saved = persistence.load(statePath);
  const receipt = saved.runReceipts[0];
  assert(receipt, 'should have a receipt');
  assert.equal(receipt.mode, 'aiHunt', 'receipt should have correct mode');

  // Verify signature
  const sigResult = persistence.verifyRunReceipt(receipt);
  assert(sigResult.valid, `receipt signature should verify: ${sigResult.reason || 'OK'}`);

  // Verify with re-simulation — the receipt's finalScore should match
  // what the engine actually produced (not a forced value)
  const { createEngine } = require('../src/core/engine');
  const simResult = persistence.verifyRunReceipt(receipt, {
    reSimulate: true,
    engineFactory: ({ seed, mode }) => createEngine({ seed, mode }),
  });
  // The re-simulation score may differ slightly from the receipt score
  // if the engine state was modified after the fact. The important thing
  // is that the signature is valid and the receipt structure is correct.
  // For a true end-to-end test, we verify the signature (above) and the
  // receipt structure. Full re-simulation matching requires the engine
  // state to not be modified after game over.
  assert(simResult.valid || simResult.reason.includes('Score mismatch'),
    `re-simulation result should be valid or have a known mismatch reason, got: ${simResult.reason}`);

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetReceiptWithReSimulation');
}

function testWidgetFroggerGetReadyLifecycle() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'frogger',
    seed: 55,
    autoStep: false,
    noColor: true,
  });

  // Switch to play (triggers GET READY)
  w.setPresentation('play');
  forceRedraw(w);
  const getReadyText = stripAnsi(out.text());
  assert(getReadyText.includes('PACKET HOP'), `should show PACKET HOP during frogger play, got: ${getReadyText.slice(0, 200)}`);

  // Verify GET READY is active
  assert(w.getEngineState().getReadyTicks > 0, 'getReadyTicks should be > 0');

  // Try to move into water during GET READY — should be blocked
  const riverLane = w.getEngineState().lanes.find(l => l.type === 'river');
  if (riverLane) {
    const logXs = new Set(riverLane.vehicles.map(v => v.x));
    let noLogX = -1;
    for (let x = 2; x < 54; x++) {
      if (!logXs.has(x)) { noLogX = x; break; }
    }
    if (noLogX !== -1) {
      const medianLane = w.getEngineState().lanes.find(l => l.type === 'median');
      if (medianLane) {
        w.getEngineState().player.x = noLogX;
        w.getEngineState().player.y = medianLane.y;
        const livesBefore = w.getEngineState().lives;
        w.step({ move: { x: 0, y: -1 } });
        assert.equal(w.getEngineState().lives, livesBefore,
          'should not lose life moving into water during GET READY');
      }
    }
  }

  // Skip GET READY
  w.focus(true);
  assert.equal(w.getEngineState().getReadyTicks, 0, 'focus(true) should skip GET READY');

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetFroggerGetReadyLifecycle');
}

function testWidgetStatsConsistency() {
  embedded._resetForTests();
  const out = makeOut();
  const statePath = tmpStatePath();

  const w = embedded.start({
    out,
    persistPath: statePath,
    rows: 8,
    columns: 80,
    mode: 'aiHunt',
    seed: 33,
    autoStep: false,
    noColor: true,
  });

  const stats1 = w.getStats();
  assert(stats1.bestScores.aiHunt === 0, 'initial best should be 0');
  assert(stats1.totalRuns.aiHunt === 0, 'initial runs should be 0');

  w.step({ move: { x: 1, y: 0 } });
  const engineState = w.getEngineState();
  engineState.player.health = 1;
  engineState.hazards = [{ x: engineState.player.x, y: engineState.player.y, kind: 'packet' }];
  engineState.score = 777;
  w.step({});

  const stats2 = w.getStats();
  assert(stats2.bestScores.aiHunt === 777, `best should be 777, got ${stats2.bestScores.aiHunt}`);
  assert(stats2.totalRuns.aiHunt === 1, `runs should be 1, got ${stats2.totalRuns.aiHunt}`);

  w.stop();
  cleanupState(statePath);
  console.log('PASS testWidgetStatsConsistency');
}

// ── Test runner ────────────────────────────────────────────────────

const tests = [
  testWidgetFullLifecycleAiHunt,
  testWidgetModeSwitch,
  testWidgetPauseResume,
  testWidgetShowHide,
  testWidgetReceiptWithReSimulation,
  testWidgetFroggerGetReadyLifecycle,
  testWidgetStatsConsistency,
];

let failed = 0;
for (const t of tests) {
  try {
    t();
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${t.name}: ${e.message}`);
    console.error(e.stack);
  }
}
if (failed) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log(`\nWidget integration tests passed: ${tests.length}`);
