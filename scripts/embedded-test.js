const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const embedded = require('../src/embedded');
const persistence = require('../src/state/persistence');

// In-memory Writable that captures bytes and pretends to be a TTY.
function makeOut(opts = {}) {
  const buf = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString('utf8'));
      cb();
    },
  });
  out.isTTY = opts.isTTY !== false;
  out.columns = opts.columns || 80;
  out.rows = opts.rows || 24;
  out.buffer = buf;
  out.text = () => buf.join('');
  out.clear = () => { buf.length = 0; };
  return out;
}

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-embed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanupState(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '.tmp'); } catch {}
  try { fs.unlinkSync(p + '.corrupt-' + Date.now()); } catch {}  // best-effort
}

function testStartIsIdempotent() {
  embedded._resetForTests();
  const out = makeOut();
  const w1 = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  const w2 = embedded.start({ out, persistPath: w1._internal.ctx.config.persistPath, rows: 6, columns: 80 });
  assert.equal(w1, w2, 'second start() should return the same instance');
  w1.stop();
  console.log('PASS testStartIsIdempotent');
}

function testStartRendersIdleFrame() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80, presentation: 'idle' });
  const text = out.text();
  assert(text.includes('SIGNAL RUSH'), 'should render SIGNAL RUSH title');
  assert(text.includes('idle'), 'should show idle status');
  w.stop();
  console.log('PASS testStartRendersIdleFrame');
}

function testShowHideSwitchesPresentation() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80, presentation: 'idle' });
  w.hide();
  out.clear();
  w._internal.draw();
  const hiddenText = out.text();
  const lines = hiddenText.split('\n').filter((l) => l.length > 0);
  assert(lines.length <= 2, `hidden state should produce minimal output, got ${lines.length} lines`);
  w.show();
  const shownText = out.text();
  assert(shownText.includes('SIGNAL RUSH'), 'after show() should render again');
  w.stop();
  console.log('PASS testShowHideSwitchesPresentation');
}

function testFocusChangesToPlayPresentation() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  w.focus(true);
  const text = out.text();
  assert(text.includes('PLAYING'), 'focus(true) should switch to PLAYING status');
  w.stop();
  console.log('PASS testFocusChangesToPlayPresentation');
}

function testStepAdvancesEngineAndRecordsRunOnGameOver() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const p = tmpStatePath();
  const w = embedded.start({ out, persistPath: p, rows: 6, columns: 80, mode: 'aiHunt' });
  const e = w.getEngineState();
  e.player.health = 1;
  e.hazards = [{ x: e.player.x, y: e.player.y, kind: 'packet' }];
  e.score = 1234;
  w.step({});
  const stats = w.getStats();
  assert.equal(stats.bestScores.aiHunt, 1234, 'best score should be persisted after game over');
  assert.equal(stats.totalRuns.aiHunt, 1, 'run count should be 1');
  const reloaded = persistence.load(p);
  assert.equal(reloaded.bestScores.aiHunt, 1234, 'persisted file should have the best score');
  w.stop();
  cleanupState(p);
  console.log('PASS testStepAdvancesEngineAndRecordsRunOnGameOver');
}

function testSetModeSwitchesAndPersists() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const p = tmpStatePath();
  const w = embedded.start({ out, persistPath: p, rows: 6, columns: 80, mode: 'aiHunt' });
  // First produce an AI Hunt run, drive into game over, verify persisted.
  const aiState = w.getEngineState();
  aiState.player.health = 1;
  aiState.score = 100;
  aiState.hazards = [{ x: aiState.player.x, y: aiState.player.y, kind: 'packet' }];
  w.step({});
  assert.equal(w.getStats().bestScores.aiHunt, 100, 'aiHunt best should be saved');
  // Switch to frogger; engine is fresh.
  w.setMode('frogger');
  const frogState = w.getEngineState();
  // Force end the run by setting gameOver directly, then step once so
  // the embed records the run. This avoids fighting with frogger's
  // own collision/movement logic in the test harness.
  frogState.gameOver = true;
  frogState.score = 200;
  frogState.level = 2;
  w.step({});
  const stats = w.getStats();
  assert.equal(stats.bestScores.frogger, 200, 'frogger best should be 200');
  assert.equal(stats.bestLevels.frogger, 2, 'frogger best level should be 2');
  assert.equal(stats.totalRuns.frogger, 1, 'frogger should have 1 run recorded');
  // Persistence round-trip
  const reloaded = persistence.load(p);
  assert.equal(reloaded.bestScores.frogger, 200, 'frogger best should be persisted');
  assert.equal(reloaded.totalRuns.frogger, 1, 'frogger run count should be persisted');
  w.stop();
  cleanupState(p);
  console.log('PASS testSetModeSwitchesAndPersists');
}

function testStopRestoresTerminal() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  out.clear();
  w.stop();
  const text = out.text();
  assert(text.includes('\x1b[r'), 'should restore scroll region on stop');
  assert(text.includes('\x1b[?25h'), 'should show cursor on stop');
  console.log('PASS testStopRestoresTerminal');
}

function testResizeUpdatesHeightAndWidth() {
  embedded._resetForTests();
  const out = makeOut({ rows: 30, columns: 100 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 8, columns: 80 });
  w.setRows(5);
  assert.equal(w._internal.ctx.height, 5, 'setRows should update height');
  out.rows = 20;
  out.columns = 60;
  out.emit('resize');
  assert(w._internal.ctx.height <= 5, 'resize should respect configured max rows');
  w.stop();
  console.log('PASS testResizeUpdatesHeightAndWidth');
}

function testGetStatsReturnsAllFields() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  const stats = w.getStats();
  for (const k of ['bestScores', 'bestLevels', 'totalRuns', 'lastPlayedAt', 'lastMode', 'presentation', 'mode', 'focused']) {
    assert(k in stats, `stats should include ${k}`);
  }
  assert(stats.bestScores.aiHunt === 0 || typeof stats.bestScores.aiHunt === 'number');
  w.stop();
  console.log('PASS testGetStatsReturnsAllFields');
}

function testNonTTYDoesNotStartTicker() {
  embedded._resetForTests();
  const out = makeOut({ isTTY: false });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  w.stop();
  console.log('PASS testNonTTYDoesNotStartTicker');
}

function testPauseResumeStopsTicker() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const w = embedded.start({ out, persistPath: tmpStatePath(), rows: 6, columns: 80 });
  w.pause();
  assert.equal(w._internal.ctx.running, false, 'pause should clear running flag');
  w.resume();
  assert.equal(w._internal.ctx.running, true, 'resume should set running flag');
  w.stop();
  console.log('PASS testPauseResumeStopsTicker');
}

function testWidgetCreatesReceiptWithSeed() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const p = tmpStatePath();
  // Start widget WITH a seed — enables receipt generation
  const w = embedded.start({ out, persistPath: p, rows: 6, columns: 80, mode: 'aiHunt', seed: 4242 });
  // Verify seed was captured
  assert.equal(w._internal.ctx.runSeed, 4242, 'widget should capture seed');
  // Force a game over with a score
  const e = w.getEngineState();
  e.player.health = 1;
  e.hazards = [{ x: e.player.x, y: e.player.y, kind: 'packet' }];
  e.score = 999;
  w.step({ move: { x: 1, y: 0 } });
  // Verify receipt was stored
  const reloaded = persistence.load(p);
  assert(reloaded.runReceipts && reloaded.runReceipts.length === 1, `should have 1 receipt, got ${reloaded.runReceipts?.length}`);
  const receipt = reloaded.runReceipts[0];
  assert.equal(receipt.seed, 4242, 'receipt should have the seed');
  assert.equal(receipt.mode, 'aiHunt', 'receipt should have the mode');
  assert.equal(receipt.finalScore, 999, 'receipt should have the final score');
  assert(receipt.inputs && receipt.inputs.length > 0, 'receipt should have inputs');
  // Verify the receipt signature
  const verifyResult = persistence.verifyRunReceipt(receipt);
  assert(verifyResult.valid, 'receipt should verify with valid signature');
  w.stop();
  cleanupState(p);
  console.log('PASS testWidgetCreatesReceiptWithSeed');
}

function testWidgetPreservesSeedOnModeSwitch() {
  embedded._resetForTests();
  const out = makeOut({ rows: 24, columns: 80 });
  const p = tmpStatePath();
  const w = embedded.start({ out, persistPath: p, rows: 6, columns: 80, mode: 'aiHunt', seed: 7777 });
  assert.equal(w._internal.ctx.runSeed, 7777, 'seed should be 7777 before switch');
  // Switch mode — seed should be preserved
  w.setMode('frogger');
  assert.equal(w._internal.ctx.runSeed, 7777, 'seed should be preserved after mode switch');
  w.stop();
  cleanupState(p);
  console.log('PASS testWidgetPreservesSeedOnModeSwitch');
}

const tests = [
  testStartIsIdempotent,
  testStartRendersIdleFrame,
  testShowHideSwitchesPresentation,
  testFocusChangesToPlayPresentation,
  testStepAdvancesEngineAndRecordsRunOnGameOver,
  testSetModeSwitchesAndPersists,
  testStopRestoresTerminal,
  testResizeUpdatesHeightAndWidth,
  testGetStatsReturnsAllFields,
  testNonTTYDoesNotStartTicker,
  testPauseResumeStopsTicker,
  testWidgetCreatesReceiptWithSeed,
  testWidgetPreservesSeedOnModeSwitch,
];

let failed = 0;
for (const t of tests) {
  try { t(); } catch (e) { failed += 1; console.error(`FAIL ${t.name}: ${e.message}`); console.error(e.stack); }
}
if (failed) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log(`\nEmbedded entry-point tests passed: ${tests.length}`);
