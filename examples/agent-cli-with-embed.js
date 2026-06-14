// Agent CLI demo harness.
//
// Pretends to be an agent CLI (Hermes-style) and embeds the Signal
// Rush widget in the bottom band. Drives the widget through the four
// real-world lifecycle states the user described:
//   1. idle         — user just opened the agent, nothing happening
//   2. working      — user submitted a prompt, agent is "thinking"
//   3. rate-limited — agent hit a 429, widget should be the focus
//   4. playing      — user explicitly chose to play during downtime
//
// All state transitions are scripted. Press the indicated keys to
// step through. ESC or Q to quit. NO real keystrokes are captured
// from the agent's prompt — we drive everything from scripted timers
// so this demo can be run unattended in CI/recordings.
//
// Output is plain stdout (no TTY required) so the demo can be
// piped to a recorder. ANSI escape codes still work for visuals.

const readline = require('node:readline');
const embedded = require('../src/embedded');

const ROWS = 30;
const COLS = 90;
const WIDGET_ROWS = 8;

// === Agent "screen" state ===
// We don't actually own a TTY for the agent. We just print the agent
// "output" above the widget, then call widget.show()/hide()/focus()
// to control the widget.

// === Scenarios ===
const SCENARIOS = [
  {
    name: 'idle-just-opened',
    duration: 1500,
    description: 'User just opened Hermes. Nothing happening yet.',
    run: ({ widget, agent }) => {
      widget.show();
      agent.print('  ℹ  Hermes CLI v0.4.2 — type a message or /help');
      agent.print('  ℹ  Try: "explain this repo"');
    },
  },
  {
    name: 'prompt-submitted',
    duration: 3000,
    description: 'User submitted a prompt. Agent is "thinking" — widget should yield.',
    run: ({ widget, agent }) => {
      widget.hide();
      agent.clear();
      agent.print('  ❯ Write a function that returns the Fibonacci sequence up to n');
      agent.print('');
      agent.stream([
        '> Analyzing your request…',
        '> Reading repository structure…',
        '> Drafting implementation…',
        '',
        'Here is a clean implementation:',
        '',
        '```js',
        'function fib(n) {',
        '  if (n <= 1) return n;',
        '  let [a, b] = [0, 1];',
        '  for (let i = 2; i <= n; i++) [a, b] = [b, a + b];',
        '  return a;',
        '}',
        '```',
      ]);
    },
  },
  {
    name: 'rate-limited',
    duration: 5000,
    description: 'Agent was rate-limited (HTTP 429). User is waiting — widget comes back to play.',
    run: ({ widget, agent }) => {
      agent.clear();
      agent.print('  ⚠  Rate limit reached. Backing off for 8s.');
      agent.print('  ℹ  This is a great time to take a break.');
      widget.show();
      widget.focus(true);  // turn into play mode automatically
      agent.print('  ℹ  Try Signal Rush while you wait.');
    },
  },
  {
    name: 'idle-after-rate-limit',
    duration: 2000,
    description: 'Rate limit cleared. Agent is back, widget yields again.',
    run: ({ widget, agent }) => {
      agent.clear();
      agent.print('  ✓  Rate limit cleared. Resuming…');
      widget.hide();
    },
  },
];

// === Agent simulator ===
class AgentSim {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.lines = [];
    this.maxLines = rows - 12;  // leave room for the widget and a header
  }
  clear() {
    this.lines = [];
    process.stdout.write('\x1b[H');
  }
  print(s) {
    this.lines.push(s);
  }
  stream(lines) {
    let i = 0;
    const tick = () => {
      if (i >= lines.length) return;
      this.print(lines[i]);
      i += 1;
      setTimeout(tick, 120);
    };
    tick();
  }
  flush() {
    // Truncate to fit
    const visible = this.lines.slice(-this.maxLines);
    process.stdout.write('\x1b[H');
    for (const l of visible) process.stdout.write(l + '\n');
  }
}

// === Demo runner ===
async function main() {
  // Banner
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
  process.stdout.write('╔════════════════════════════════════════════════════════════════════════════════════╗\n');
  process.stdout.write('║                  SIGNAL RUSH — AGENT CLI DEMO HARNESS                              ║\n');
  process.stdout.write('║                                                                                  ║\n');
  process.stdout.write('║  This simulates a Hermes / Claude Code agent with the Signal Rush widget         ║\n');
  process.stdout.write('║  embedded at the bottom. Watch the widget change as the agent cycles            ║\n');
  process.stdout.write('║  through its lifecycle. Press Ctrl-C to stop.                                    ║\n');
  process.stdout.write('╚════════════════════════════════════════════════════════════════════════════════════╝\n');
  process.stdout.write('\n');
  await sleep(1500);

  // Start the widget
  const out = process.stdout;
  const widget = embedded.start({
    out,
    rows: WIDGET_ROWS,
    columns: COLS,
    presentation: 'hidden',  // start hidden, scenarios will show
    // autoStep: the demo doesn't have a host loop driving the
    // engine. We want the Frogger play view to actually animate
    // during the rate-limited scenario, so opt in.
    autoStep: true,
  });

  const agent = new AgentSim(ROWS, COLS);

  for (let i = 0; i < SCENARIOS.length; i += 1) {
    const s = SCENARIOS[i];
    process.stdout.write('\x1b[H');
    process.stdout.write(`\x1b[1;1H\x1b[7m [${i + 1}/${SCENARIOS.length}] ${s.name} — ${s.description} \x1b[0m\n\n`);
    s.run({ widget, agent });
    // Tick the agent flush + widget redraw for `duration` ms
    const start = Date.now();
    while (Date.now() - start < s.duration) {
      agent.flush();
      await sleep(80);
    }
  }

  // Wrap up
  process.stdout.write('\x1b[H');
  process.stdout.write('\x1b[1;1H\x1b[7m DEMO COMPLETE \x1b[0m\n\n');
  process.stdout.write('Final stats: ' + JSON.stringify(widget.getStats(), null, 2) + '\n\n');
  await sleep(500);
  widget.stop();
  process.stdout.write('\x1b[?25h');
  process.exit(0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  process.stdout.write('\x1b[?25h');
  console.error('Demo failed:', e);
  process.exit(1);
});
