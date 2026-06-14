#!/usr/bin/env node
// Standalone embedded widget — useful for plugin authors to verify
// the widget renders correctly inside their agent before plugging in
// the real lifecycle hooks.
//
// Usage:
//   node src/cli/embedded.js --rows=8 --columns=80 --mode=aiHunt
//   node src/cli/embedded.js --demo    # cycle through scenarios
//
// This script does NOT bind raw input. It renders the widget and
// idles. Useful for screenshot tooling.

const args = process.argv.slice(2);
const get = (k, d) => {
  const a = args.find((a) => a.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const bool = (k, d) => {
  const a = args.find((a) => a === '--' + k || a.startsWith('--' + k + '='));
  return a ? (a.includes('=') ? a.split('=')[1] === 'true' : true) : d;
};

const rows = parseInt(get('rows', '8'), 10);
const cols = parseInt(get('columns', process.stdout.columns || '80'), 10);
const mode = get('mode', 'aiHunt');
const isDemo = bool('demo', false);

if (isDemo) {
  // Run the demo harness instead
  require('../examples/agent-cli-with-embed.js');
} else {
  const embedded = require('../embedded');
  const w = embedded.start({
    rows,
    columns: cols,
    mode,
    noColor: bool('no-color', false),
    // autoStep: standalone CLI runs without a host loop that drives
    // the engine. Set true so the game actually animates when the
    // user is in PLAY mode.
    autoStep: bool('auto-step', true),
  });

  process.on('SIGINT', () => { w.stop(); process.exit(0); });
  process.on('SIGTERM', () => { w.stop(); process.exit(0); });

  // Show the widget in idle by default
  w.show();
  // Print usage hint once
  process.stdout.write(`\x1b[H\x1b[1;1H\x1b[7m signal-rush embedded widget — ${rows}x${cols} — mode=${mode} — press Ctrl-C to stop \x1b[0m\n`);
  // Keep alive
  setInterval(() => {}, 1 << 30);
}
