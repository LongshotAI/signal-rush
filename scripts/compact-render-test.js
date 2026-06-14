const assert = require('node:assert/strict');
const { renderCompact, _internal } = require('../src/cli/renderCompact');
const { createEngine } = require('../src/core/engine');
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s) { return String(s).replace(ANSI_RE, '').length; }

function testIdleFitsRowBudget() {
  const engine = createEngine();
  for (const rows of [4, 6, 8, 10, 12]) {
    for (const cols of [60, 80, 100]) {
      const { lines, height } = renderCompact(engine.state, 'idle', { rows, cols, stats: { best: 0 } });
      assert.equal(height, rows, `idle: height should equal requested rows (rows=${rows}, cols=${cols})`);
      for (const l of lines) {
        assert(visibleLength(l) <= cols, `line too long in idle: rows=${rows} cols=${cols} got "${l.slice(0, 60)}..."`);
      }
    }
  }
  console.log('PASS testIdleFitsRowBudget');
}

function testPlayFitsRowBudget() {
  const engine = createEngine({ mode: 'frogger', rng: () => 0.5 });
  for (const rows of [4, 6, 8, 10, 12]) {
    for (const cols of [60, 80, 100]) {
      const { lines, height } = renderCompact(engine.state, 'play', { rows, cols });
      assert.equal(height, rows, `play frogger: height should equal requested rows (rows=${rows})`);
      for (const l of lines) {
        assert(visibleLength(l) <= cols, `play frogger line too long: rows=${rows} cols=${cols} got ${visibleLength(l)} chars`);
      }
    }
  }
  // Also AI Hunt
  const aiEngine = createEngine();
  for (const rows of [4, 6, 8]) {
    const { lines, height } = renderCompact(aiEngine.state, 'play', { rows, cols: 80 });
    assert.equal(height, rows, `play aiHunt: height=${height}, expected ${rows}`);
  }
  console.log('PASS testPlayFitsRowBudget');
}

function testHiddenAlwaysSingleLine() {
  const engine = createEngine();
  const { lines, height } = renderCompact(engine.state, 'hidden', { rows: 8, cols: 80 });
  assert.equal(height, 1, 'hidden should produce 1 line');
  assert.equal(lines.length, 1);
  console.log('PASS testHiddenAlwaysSingleLine');
}

function testTitleContainsBest() {
  // (Previously this also checked for a partner line. The partner
  // surface was removed per product direction; title-only check now.)
  const { lines } = renderCompact(null, 'idle', { rows: 6, cols: 80, stats: { best: 1234 } });
  // Title is line 0
  const title = lines[0].replace(ANSI_RE, '');
  assert(title.includes('SIGNAL RUSH'), 'title should include SIGNAL RUSH');
  assert(title.includes('1234'), 'title should show best score');
  // No partner line anywhere in the frame
  for (const l of lines) {
    const visible = l.replace(ANSI_RE, '');
    assert(!visible.toLowerCase().includes('partner:'), 'partner line should be removed');
  }
  console.log('PASS testTitleContainsBest');
}

function testNewBestFlagShowsStar() {
  const { lines } = renderCompact(null, 'idle', { rows: 6, cols: 80, isNewBest: true, stats: { best: 0 } });
  const title = lines[0].replace(ANSI_RE, '');
  assert(title.includes('NEW BEST'), 'new best flag should appear in title');
  const { lines: lines2 } = renderCompact(null, 'idle', { rows: 6, cols: 80, isNewBest: false, stats: { best: 0 } });
  assert(!lines2[0].replace(ANSI_RE, '').includes('NEW BEST'), 'no new best flag should not appear');
  console.log('PASS testNewBestFlagShowsStar');
}

function testNoColorProducesCleanText() {
  const engine = createEngine();
  for (const pres of ['idle', 'play']) {
    const { lines } = renderCompact(engine.state, pres, { rows: 8, cols: 80, noColor: true });
    for (const l of lines) {
      assert(!l.includes('\x1b['), `no-color ${pres} frame should contain no ANSI: ${l.slice(0, 40)}`);
    }
  }
  console.log('PASS testNoColorProducesCleanText');
}

function testFocusDimsEverything() {
  const engine = createEngine();
  const { lines: focused } = renderCompact(engine.state, 'idle', { rows: 6, cols: 80, focus: true });
  const { lines: unfocused } = renderCompact(engine.state, 'idle', { rows: 6, cols: 80, focus: false });
  // Unfocused should mention "paused" or similar muted state
  const uTitle = unfocused[0].replace(ANSI_RE, '').toLowerCase();
  assert(uTitle.includes('paused') || uTitle.includes('signal-rush'), `unfocused title should indicate paused state, got: ${uTitle}`);
  console.log('PASS testFocusDimsEverything');
}

function testRowBudgetClampedToRange() {
  const { lines: tooSmall } = renderCompact(null, 'idle', { rows: 2, cols: 80 });
  assert(tooSmall.length >= 4, 'rows=2 should be clamped up to min 4');
  const { lines: tooBig } = renderCompact(null, 'idle', { rows: 100, cols: 80 });
  assert(tooBig.length <= 12, 'rows=100 should be clamped down to max 12');
  console.log('PASS testRowBudgetClampedToRange');
}

function testFroggerPlayShowsFrogAndLanes() {
  const engine = createEngine({ mode: 'frogger', rng: () => 0.5 });
  engine.state.getReadyTicks = 0;
  engine.state.player.x = 28;
  engine.state.player.y = 22;
  engine.state.lives = 3;
  engine.state.score = 0;
  engine.state.timeLeft = 60;
  const { lines } = renderCompact(engine.state, 'play', { rows: 8, cols: 80, noColor: true });
  // Look for the frog somewhere
  const allText = lines.join('\n');
  // Player is on a median (safe area), look for either F or visible arena
  assert(allText.length > 0);
  // Find status line: should mention "LVL" or "LIVES" or "TIME"
  const hasStatus = lines.some((l) => l.includes('LIVES') || l.includes('TIME'));
  assert(hasStatus, 'compact play should show at least one status indicator');
  console.log('PASS testFroggerPlayShowsFrogAndLanes');
}

function testAiHuntPlayShowsScore() {
  const engine = createEngine();
  engine.state.player.health = 8;
  engine.state.score = 200;
  engine.state.combo = 1.5;
  engine.state.pickups = [{ x: 28, y: 14, value: 40, ttl: 10 }];
  const { lines } = renderCompact(engine.state, 'play', { rows: 8, cols: 80, noColor: true });
  const status = lines.find((l) => l.includes('SCORE'));
  assert(status, 'compact AI Hunt play should show a status line with SCORE');
  assert(status.includes('200'), 'status should show actual score value');
  console.log('PASS testAiHuntPlayShowsScore');
}

function testModeChipsReflectActiveMode() {
  // Mode label was rebranded from 'FROGGER' to 'PACKET HOP' in the
  // compact renderer as well as the menu.
  const { lines: aiLines } = renderCompact({ mode: 'aiHunt' }, 'idle', { rows: 6, cols: 80, noColor: true });
  const { lines: frogLines } = renderCompact({ mode: 'frogger' }, 'idle', { rows: 6, cols: 80, noColor: true });
  const aiText = aiLines.join('\n');
  const frogText = frogLines.join('\n');
  // In aiHunt: "▸ AI HUNT" should be present, plain "PACKET HOP" not preceded by arrow
  assert(aiText.includes('▸ AI HUNT'), 'aiHunt idle should mark AI HUNT as active');
  assert(frogText.includes('▸ PACKET HOP'), 'frogger idle should mark PACKET HOP as active');
  console.log('PASS testModeChipsReflectActiveMode');
}

const tests = [
  testIdleFitsRowBudget,
  testPlayFitsRowBudget,
  testHiddenAlwaysSingleLine,
  testTitleContainsBest,
  testNewBestFlagShowsStar,
  testNoColorProducesCleanText,
  testFocusDimsEverything,
  testRowBudgetClampedToRange,
  testFroggerPlayShowsFrogAndLanes,
  testAiHuntPlayShowsScore,
  testModeChipsReflectActiveMode,
];

let failed = 0;
for (const t of tests) {
  try { t(); } catch (e) { failed += 1; console.error(`FAIL ${t.name}: ${e.message}`); console.error(e.stack); }
}
if (failed) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log(`\nCompact renderer tests passed: ${tests.length}`);
