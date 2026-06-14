// Verify that engine-recorded runs actually persist through the file
// layer with a real signal-rush game, not just synthetic numbers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistence = require('../src/state/persistence');
const { createEngine } = require('../src/core/engine');

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function testEngineFroggerRunPersists() {
  const p = tmpStatePath();
  let s = persistence.load(p);
  assert.equal(s.bestScores.frogger, 0, 'should start at 0');

  // Simulate a real frogger run that fills 3 slots then dies.
  const engine = createEngine({ mode: 'frogger', rng: () => 0.5 });
  engine.state.getReadyTicks = 0;
  engine.state.player.x = 6;       // slot 0
  engine.state.player.y = 1;
  engine.state.score = 200;
  engine.state.combo = 1;
  engine.step({});
  engine.state.player.x = 17;      // slot 1
  engine.step({});
  engine.state.player.x = 28;      // slot 2
  engine.step({});
  const finalScore = engine.state.score;
  const finalLevel = engine.state.level;

  s = persistence.recordRun(s, { mode: 'frogger', score: finalScore, level: finalLevel }).state;
  persistence.save(s, p);

  // Simulate a fresh process: load from disk and confirm.
  const fresh = persistence.load(p);
  assert.equal(fresh.bestScores.frogger, finalScore, 'best score should match what the engine produced');
  assert.equal(fresh.totalRuns.frogger, 1, 'run count should be 1');
  assert.equal(fresh.lastMode, 'frogger');
  assert(fresh.lastPlayedAt, 'last played timestamp should be set');

  // Now a worse run should not overwrite the best.
  let s2 = persistence.recordRun(fresh, { mode: 'frogger', score: 50, level: 1 }).state;
  assert.equal(s2.bestScores.frogger, finalScore, 'worse run should not lower the best');

  try { fs.unlinkSync(p); } catch {}
  console.log('PASS testEngineFroggerRunPersists (engine finalScore=' + finalScore + ', level=' + finalLevel + ')');
}

function testEngineAiHuntRunPersists() {
  const p = tmpStatePath();
  let s = persistence.load(p);

  // Simulate an AI Hunt run that picks up some signals and dies.
  const engine = createEngine();
  engine.state.pickups = [{ x: engine.state.player.x, y: engine.state.player.y, value: 50, ttl: 10 }];
  engine.state.score = 0;
  engine.state.credits = 0;
  engine.step({});
  // Add another pickup and step
  engine.state.pickups = [{ x: engine.state.player.x, y: engine.state.player.y, value: 80, ttl: 10 }];
  engine.step({});
  const finalScore = engine.state.score;

  s = persistence.recordRun(s, { mode: 'aiHunt', score: finalScore, level: 1 }).state;
  persistence.save(s, p);

  const fresh = persistence.load(p);
  assert.equal(fresh.bestScores.aiHunt, finalScore, 'AI Hunt best should match engine');
  assert.equal(fresh.totalRuns.aiHunt, 1);

  try { fs.unlinkSync(p); } catch {}
  console.log('PASS testEngineAiHuntRunPersists (engine finalScore=' + finalScore + ')');
}

const tests = [testEngineFroggerRunPersists, testEngineAiHuntRunPersists];
let failed = 0;
for (const t of tests) {
  try { t(); } catch (e) { failed += 1; console.error(`FAIL ${t.name}: ${e.message}`); console.error(e.stack); }
}
if (failed) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log(`\nEngine-to-disk persistence tests passed: ${tests.length}`);
