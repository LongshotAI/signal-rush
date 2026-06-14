// Snapshot script: drives the widget through the 4 agent-CLI
// lifecycle states and dumps the rendered frame for each. This is
// the visual evidence the audit promises — a literal picture of
// what the user would see at each point in the agent's flow.
//
// Output: four labeled frame dumps to stdout, separated by banners.
// No TTY required.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpPersist = path.join(os.tmpdir(), 'signal-rush-snap-' + process.pid + '-' + Date.now() + '.json');
try { fs.unlinkSync(tmpPersist); } catch {}

const embedded = require('../src/embedded');
const { createEngine } = require('../src/core/engine');

// Use a captured-output stream so we can see exactly what the widget
// would render in a real TTY, with ANSI codes preserved.
const ANSI = { off: false };
const out = process.stdout;

function banner(title) {
  out.write('\n');
  out.write('\x1b[7m' + '═'.repeat(78) + '\x1b[0m\n');
  out.write('\x1b[7m  ' + title.padEnd(76) + '  \x1b[0m\n');
  out.write('\x1b[7m' + '═'.repeat(78) + '\x1b[0m\n');
}

// We render each state by manually composing what the agent area
// would look like + what the widget would look like. The widget is
// driven via the actual render path (renderCompact) — not mocked —
// so the frames are real.

const persistence = require('../src/state/persistence');
const { renderCompact } = require('../src/cli/renderCompact');

function makeStateForMode(mode, options = {}) {
  const engine = createEngine({ mode, rng: () => 0.5 });
  if (mode === 'frogger') engine.state.getReadyTicks = 0;
  if (options.score) engine.state.score = options.score;
  if (options.lives !== undefined) engine.state.lives = options.lives;
  if (options.timeLeft !== undefined) engine.state.timeLeft = options.timeLeft;
  if (options.level !== undefined) engine.state.level = options.level;
  if (options.homeSlots) engine.state.homeSlots = options.homeSlots;
  if (options.pickups) engine.state.pickups = options.pickups;
  if (options.hazards) engine.state.hazards = options.hazards;
  if (options.player) engine.state.player = { ...engine.state.player, ...options.player };
  if (options.health !== undefined) engine.state.player.health = options.health;
  return engine.state;
}

function dumpAgentArea(lines) {
  out.write('\x1b[2J\x1b[H');
  for (const l of lines) out.write(l + '\n');
}

function dumpFrame(state, presentation, rows, cols, opts = {}) {
  const { lines, height } = renderCompact(state, presentation, {
    rows, cols, noColor: opts.noColor, stats: opts.stats, isNewBest: opts.isNewBest,
  });
  // Separator
  out.write('─'.repeat(cols) + '\n');
  for (const l of lines) out.write(l + '\n');
  return { lines, height };
}

const ROWS = 32;
const COLS = 80;
const WIDGET_ROWS = 8;

// === State 1: idle, agent just opened ===
{
  const state = makeStateForMode('aiHunt', { score: 0, health: 8 });
  const fakeAgentOutput = [
    '\x1b[36m❯\x1b[0m Welcome to Hermes. Type a message or /help.',
    '',
    '  • /commit  /pr  /review',
    '  • !signal-rush  ← bonus command (plays the embed)',
    '',
  ];
  dumpAgentArea(fakeAgentOutput);
  out.write('\n');
  out.write('\x1b[2m[STATE 1 of 4] IDLE — agent just opened, nothing happening\x1b[0m\n');
  dumpFrame(state, 'idle', WIDGET_ROWS, COLS, { noColor: true, stats: { best: 0 } });
}

// === State 2: working, agent is thinking — widget is HIDDEN ===
{
  const state = makeStateForMode('aiHunt', { score: 0, health: 8 });
  const fakeAgentOutput = [
    '\x1b[36m❯\x1b[0m write a function that returns the Fibonacci sequence up to n',
    '',
    '\x1b[2m> Analyzing your request…\x1b[0m',
    '\x1b[2m> Reading repository structure…\x1b[0m',
    '\x1b[2m> Drafting implementation…\x1b[0m',
    '',
    '\x1b[32m✓\x1b[0m Done. Implementation:',
    '',
    '\x1b[2m  function fib(n) {\x1b[0m',
    '\x1b[2m    if (n <= 1) return n;\x1b[0m',
    '\x1b[2m    let [a, b] = [0, 1];\x1b[0m',
    '\x1b[2m    for (let i = 2; i <= n; i++) [a, b] = [b, a + b];\x1b[0m',
    '\x1b[2m    return a;\x1b[0m',
    '\x1b[2m  }\x1b[0m',
    '',
  ];
  dumpAgentArea(fakeAgentOutput);
  out.write('\n');
  out.write('\x1b[2m[STATE 2 of 4] WORKING — user submitted prompt, agent is responding, widget is HIDDEN\x1b[0m\n');
  // Widget is hidden — 1 blank line
  dumpFrame(state, 'hidden', WIDGET_ROWS, COLS, { noColor: true });
}

// === State 3: rate-limited, widget takes over ===
{
  const state = makeStateForMode('frogger', {
    score: 200, lives: 2, timeLeft: 30, level: 2,
    homeSlots: [true, false, true, false, false],
    player: { x: 28, y: 14, health: 1 },
  });
  const fakeAgentOutput = [
    '\x1b[33m⚠\x1b[0m  Rate limit reached (HTTP 429). Backing off for 8s.',
    '',
    '\x1b[2m> This is a great time to take a short break.\x1b[0m',
    '\x1b[2m> Signal Rush is live in the band below.\x1b[0m',
    '',
  ];
  dumpAgentArea(fakeAgentOutput);
  out.write('\n');
  out.write('\x1b[2m[STATE 3 of 4] RATE-LIMITED — agent backed off, widget expanded to PLAY mode (Frogger mid-run)\x1b[0m\n');
  dumpFrame(state, 'play', WIDGET_ROWS, COLS, { noColor: true, stats: { best: 1500 } });
}

// === State 4: idle again, agent is back, widget yields ===
{
  const state = makeStateForMode('aiHunt', { score: 0, health: 8 });
  // Pretend we just played a frogger run and got a new best
  const fakeAgentOutput = [
    '\x1b[32m✓\x1b[0m Rate limit cleared. Resuming where you left off…',
    '',
    'The previous response is still in your scrollback. Press ↑ to retrieve it.',
    '',
  ];
  dumpAgentArea(fakeAgentOutput);
  out.write('\n');
  out.write('\x1b[2m[STATE 4 of 4] IDLE — agent resumed, widget yielded (still visible at low noise)\x1b[0m\n');
  // Idle with new best badge
  const newBest = { best: 1500 };
  dumpFrame(state, 'idle', WIDGET_ROWS, COLS, { noColor: true, stats: newBest, isNewBest: true });
}

out.write('\n');
out.write('\x1b[7m END OF FRAMES — persisted best score file: ' + tmpPersist + ' \x1b[0m\n');
out.write('\n');

// Now also do a persistence round-trip: write a new score, load it back, print it.
const fs2 = require('node:fs');
const sampleState = persistence.load(tmpPersist);
sampleState.bestScores.frogger = 1500;
sampleState.bestScores.aiHunt = 850;
sampleState.totalRuns.frogger = 3;
sampleState.totalRuns.aiHunt = 7;
sampleState.lastPlayedAt = new Date().toISOString();
sampleState.lastMode = 'frogger';
persistence.save(sampleState, tmpPersist);
const reloaded = persistence.load(tmpPersist);
out.write('Persistence round-trip (file: ' + tmpPersist + '):\n');
out.write('  bestScores.frogger:  ' + reloaded.bestScores.frogger + '\n');
out.write('  bestScores.aiHunt:   ' + reloaded.bestScores.aiHunt + '\n');
out.write('  totalRuns.frogger:   ' + reloaded.totalRuns.frogger + '\n');
out.write('  totalRuns.aiHunt:    ' + reloaded.totalRuns.aiHunt + '\n');
out.write('  lastPlayedAt:        ' + reloaded.lastPlayedAt + '\n');
out.write('  lastMode:            ' + reloaded.lastMode + '\n');
out.write('\n');
out.write('Delete file: ' + (fs2.existsSync(tmpPersist) ? 'exists' : 'missing') + '\n');
try { fs2.unlinkSync(tmpPersist); } catch {}
out.write('Cleanup done.\n');
