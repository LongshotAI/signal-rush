const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistence = require('../src/state/persistence');

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(p) {
  try { fs.unlinkSync(p); } catch {}
  // Tmp file left over from atomic write.
  try { fs.unlinkSync(p + '.tmp'); } catch {}
}

function testEmptyWhenFileMissing() {
  const p = tmpStatePath();
  cleanup(p);
  const s = persistence.load(p);
  assert.equal(s.bestScores.aiHunt, 0);
  assert.equal(s.bestScores.frogger, 0);
  assert.equal(s.totalRuns.aiHunt, 0);
  assert.equal(s.totalRuns.frogger, 0);
  assert.equal(s.lastPlayedAt, null);
  console.log('PASS testEmptyWhenFileMissing');
}

function testRoundTrip() {
  const p = tmpStatePath();
  cleanup(p);
  const start = persistence.emptyState();
  const { state: afterRun, isNewBest } = persistence.recordRun(start, { mode: 'aiHunt', score: 1200, level: 1 });
  assert.equal(isNewBest, true, 'first run should be a new best');
  assert.equal(afterRun.bestScores.aiHunt, 1200);
  assert.equal(afterRun.totalRuns.aiHunt, 1);
  assert.equal(afterRun.lastMode, 'aiHunt');
  assert(afterRun.lastPlayedAt, 'lastPlayedAt should be set');

  persistence.save(afterRun, p);
  const reloaded = persistence.load(p);
  assert.equal(reloaded.bestScores.aiHunt, 1200);
  assert.equal(reloaded.totalRuns.aiHunt, 1);
  assert.equal(reloaded.lastMode, 'aiHunt');
  cleanup(p);
  console.log('PASS testRoundTrip');
}

function testNewBestOnlyWhenHigher() {
  const p = tmpStatePath();
  cleanup(p);
  let s = persistence.emptyState();
  s = persistence.recordRun(s, { mode: 'frogger', score: 500, level: 1 }).state;
  const r2 = persistence.recordRun(s, { mode: 'frogger', score: 300, level: 1 });
  assert.equal(r2.isNewBest, false, 'lower score should not be a new best');
  assert.equal(r2.state.bestScores.frogger, 500, 'best score should remain 500');
  const r3 = persistence.recordRun(s, { mode: 'frogger', score: 800, level: 2 });
  assert.equal(r3.isNewBest, true, 'higher score should be a new best');
  assert.equal(r3.state.bestScores.frogger, 800);
  assert.equal(r3.state.bestLevels.frogger, 2, 'best level should also update');
  cleanup(p);
  console.log('PASS testNewBestOnlyWhenHigher');
}

function testCorruptFileGetsBackedUp() {
  const p = tmpStatePath();
  cleanup(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not valid JSON', 'utf8');
  const s = persistence.load(p);
  assert.equal(s.bestScores.aiHunt, 0, 'corrupt file should fall back to empty state');
  // Verify a backup was created
  const dir = path.dirname(p);
  const files = fs.readdirSync(dir);
  const backup = files.find((f) => f.startsWith(path.basename(p) + '.corrupt-'));
  assert(backup, 'corrupt file should be backed up');
  // Clean up the backup
  if (backup) fs.unlinkSync(path.join(dir, backup));
  cleanup(p);
  console.log('PASS testCorruptFileGetsBackedUp');
}

function testAtomicWriteDoesNotLeaveTmpOnSuccess() {
  const p = tmpStatePath();
  cleanup(p);
  const s = persistence.emptyState();
  persistence.save(s, p);
  assert(fs.existsSync(p), 'state file should exist after save');
  assert(!fs.existsSync(p + '.tmp'), 'tmp file should be removed after rename');
  cleanup(p);
  console.log('PASS testAtomicWriteDoesNotLeaveTmpOnSuccess');
}

function testBackwardCompatibleMerge() {
  const p = tmpStatePath();
  cleanup(p);
  // Simulate a state file from a future version that has extra fields
  // the current code doesn't know about. Load should not drop them.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const futureData = {
    version: 99,
    bestScores: { aiHunt: 999, frogger: 1 },
    someFutureField: 'preserve-me',
    totalRuns: { aiHunt: 5, frogger: 2 },
  };
  fs.writeFileSync(p, JSON.stringify(futureData), 'utf8');
  const s = persistence.load(p);
  assert.equal(s.bestScores.aiHunt, 999);
  assert.equal(s.bestScores.frogger, 1);
  assert.equal(s.someFutureField, 'preserve-me', 'unknown fields should be preserved');
  assert.equal(s.totalRuns.frogger, 2);
  cleanup(p);
  console.log('PASS testBackwardCompatibleMerge');
}

function testRecordPickup() {
  const s = persistence.emptyState();
  const a = persistence.recordPickup(s);
  const b = persistence.recordPickup(a);
  assert.equal(b.totalPickups, 2);
  console.log('PASS testRecordPickup');
}

function testPathResolution() {
  // Default path includes the user's home dir + .signal-rush
  const def = persistence.resolvePath();
  assert(def.endsWith('.signal-rush/state.json'), 'default path should end in .signal-rush/state.json');
  // Explicit overrides env
  const prev = process.env.SIGNAL_RUSH_STATE;
  process.env.SIGNAL_RUSH_STATE = '/tmp/from-env.json';
  assert.equal(persistence.resolvePath(), '/tmp/from-env.json');
  assert.equal(persistence.resolvePath('/tmp/explicit.json'), '/tmp/explicit.json', 'explicit path overrides env');
  if (prev) process.env.SIGNAL_RUSH_STATE = prev;
  else delete process.env.SIGNAL_RUSH_STATE;
  console.log('PASS testPathResolution');
}

const tests = [
  testEmptyWhenFileMissing,
  testRoundTrip,
  testNewBestOnlyWhenHigher,
  testCorruptFileGetsBackedUp,
  testAtomicWriteDoesNotLeaveTmpOnSuccess,
  testBackwardCompatibleMerge,
  testRecordPickup,
  testPathResolution,
];

let failed = 0;
for (const t of tests) {
  try { t(); } catch (e) { failed += 1; console.error(`FAIL ${t.name}: ${e.message}`); console.error(e.stack); }
}
if (failed) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log(`\nPersistence tests passed: ${tests.length}`);
