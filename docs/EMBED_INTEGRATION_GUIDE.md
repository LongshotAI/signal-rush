# Signal Rush — Agent CLI Embed Integration Guide

This document is for **agent plugin authors** who want to ship Signal Rush as a sibling widget in the bottom band of their agent's CLI chat. It describes the public API, lifecycle hooks, and proven patterns for safe coexistence with the host TUI.

## What this is (and isn't)

**What it is:** A small Node.js library that renders a clean 6–10 row band of Signal Rush at the bottom of a terminal. The widget **never steals keystrokes** and **never takes ownership of the terminal**. It claims a fixed bottom band via ANSI scroll-region, and paints inside it.

**What it isn't:** A standalone process. The widget is a library you `require()` from inside your agent's plugin process. It does not fork, does not spawn a child, does not PIPE. The host process owns it.

## Hard rules (enforced in the library)

1. `setRawMode(true)` is **never** called. The host agent's TUI keeps all keystrokes.
2. The library uses ANSI `CSI Ps;Ps r` (scroll region) and absolute cursor positioning (`CSI row;col H`) to claim a fixed bottom band. The host's scroll region is set to `1..(terminalHeight - widgetHeight)`, so the host's output scrolls above the widget.
3. The library restores the terminal on `stop()`, `SIGINT`, `SIGTERM`, and `process.exit`.
4. Persistent state is written atomically (tmp + rename) to `~/.signal-rush/state.json` by default.
5. The library is **idempotent** — calling `start()` twice returns the same widget instance. To reset between test runs, call `_resetForTests()`.

## Public API

```js
const signalRush = require('signal-rush-cli/embedded');

const w = signalRush.start({
  rows: 8,                 // row budget for the widget (4–12)
  columns: 80,             // column budget (40–120)
  mode: 'aiHunt',          // or 'frogger' — initial mode
  presentation: 'idle',    // 'idle' | 'play' | 'hidden'
  noColor: false,          // strip ANSI for log-style hosts
  persistPath: null,       // override ~/.signal-rush/state.json
  out: process.stdout,     // any Writable stream (default: process.stdout)
  fpsCap: 15,              // max redraws per second
});

// === Lifecycle API ===
w.show();           // Render in 'idle' mode (low-noise: title + mode chips + partner line)
w.hide();           // Render as a single blank line; host gets all the visual space
w.focus(true);      // Take input-equivalent focus: switch to 'play' mode, engine ticks
w.focus(false);     // Release focus: return to 'idle' mode
w.pause();          // Stop the redraw ticker
w.resume();         // Restart the redraw ticker
w.setMode('frogger');   // Switch mode (auto-persists the in-flight run)
w.setPresentation('play');  // Force a presentation state
w.step({ move: { x: 1, y: 0 } });  // Advance the engine one tick with optional input
w.setRows(10);      // Resize the widget's row budget (clamps to 4–12)
w.getStats();       // { bestScores, bestLevels, totalRuns, lastPlayedAt, ... }
w.getEngineState(); // Raw engine state object (read-only intent)
w.stop();           // Restore terminal, persist, remove listeners
```

## Lifecycle pattern (recommended)

Map your agent's TUI events to widget calls. The exact hooks differ per agent, but the pattern is consistent:

```js
// === Boot ===
const w = signalRush.start({ rows: 8, columns: 80 });
w.show();  // visible by default when nothing's happening

// === User submits a prompt ===
agentEvents.on('promptSubmitted', () => {
  w.hide();          // yield the band to the agent's response
  w.focus(false);    // release focus if we had it
});

// === Agent starts streaming tokens ===
agentEvents.on('responseStarted', () => {
  w.hide();          // (already hidden from promptSubmitted, idempotent)
});

// === Agent rate-limited (HTTP 429) ===
agentEvents.on('rateLimited', ({ retryAfterMs }) => {
  w.show();
  w.focus(true);     // widget becomes playable during the wait
});

// === Agent back online ===
agentEvents.on('resumed', () => {
  w.focus(false);
  w.hide();
});

// === User idle for N seconds (optional) ===
agentEvents.on('idleTimeout', () => {
  w.show();           // surface the widget when nothing else is happening
});

// === Plugin unload / agent exit ===
process.on('SIGINT', () => { w.stop(); process.exit(0); });
process.on('SIGTERM', () => { w.stop(); process.exit(0); });
process.on('exit', () => { /* stop() also wired automatically */ });
```

## Visual contract (what the user sees)

| Presentation | What renders |
|---|---|
| `idle` | Title bar (`🏓 SIGNAL RUSH · AI HUNT · idle ··· BEST 1500`), mode chips, partner line, hotkey hint. 3 lines of real content + filler to the row budget. |
| `play` | Title bar with `● PLAYING` indicator, full arena scaled to the row budget, status line (only when rows ≥ 8), hint line with WASD/Space/P/R/Esc. |
| `hidden` | A single blank line. The host's content fills the rest of the screen. |

The widget ALWAYS shows the partner line in idle mode. This is the partner value proposition: when the user is reading agent output, they still see the brand in the band, with zero keystroke or attention cost. The brand swap is `SPONSOR_CONTENT.rotatingShellLabels` in `src/content/sponsors.js`.

## Row budget guidance

| Terminal | Recommended `rows` |
|---|---|
| 24-row terminal (default Linux) | 6–8 |
| 30-row terminal | 8 |
| 40+ row terminal | 8–10 |
| Smaller than 24 rows | 4–6 (auto-clamped) |

The widget auto-adapts to terminal resize. `setRows(n)` re-clamps the scroll region.

## Test before you ship

Run the visual snapshot to capture all four states:

```bash
node scripts/visual-snapshot.js
```

You'll see IDLE, WORKING (hidden), RATE-LIMITED (play), and RESUMED (idle with NEW BEST) frames dumped to stdout. Confirm they match your visual contract before integrating.

Run the test suite to confirm you haven't broken anything:

```bash
npm test
```

Expected: 69 mechanics + 2 smoke + 10 persistence + 11 compact + 11 embed + frogger render = 103 tests, zero failures.

## Reference integrations

### Hermes agent

```js
// In your Hermes plugin's onLoad:
const w = require('signal-rush-cli/embedded').start({ rows: 8 });

// On 'onPromptSubmitted' lifecycle:
w.hide();

// On 'onIdle' (no prompts in last 10s):
w.show();

// On 'onRateLimited':
w.show();
w.focus(true);
```

### Claude Code

Claude Code exposes lifecycle events through its plugin SDK. The exact hook names vary by version, but the binding pattern is the same:

```js
const w = require('signal-rush-cli/embedded').start({ rows: 8 });

sdk.on('userSubmit', () => w.hide());
sdk.on('responseStream', () => w.hide());
sdk.on('responseEnd', () => w.show());
sdk.on('rateLimit', () => { w.show(); w.focus(true); });
```

### OpenAI Codex CLI

Same pattern. Codex doesn't currently expose rate-limit events; check the agent's response for `429` or `rate_limit` and trigger `w.focus(true)` manually.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Widget overwrites agent output | Host doesn't write to the area above the widget | Host's `process.stdout.write` will go through the agent's scroll region (the upper part); if it doesn't, check that you're not calling `out.write('\x1b[2J')` (clear whole screen) anywhere |
| Widget disappears on resize | Adaptive cap pushed height below minimum | `w.setRows(N)` to a value within `4–12` |
| Best scores don't persist | File permission issue on `~/.signal-rush/state.json` | Check `ls -la ~/.signal-rush/`; the library falls back to defaults on read errors but logs the issue to stderr |
| Two widgets running at once | `start()` called from two plugins | `start()` is idempotent; the second call returns the first. Use `_resetForTests()` if you need a fresh instance in tests |
| Host agent uses `setRawMode` itself | The widget still works — it doesn't touch raw mode | No action needed |

## Performance

- Render budget: 15 FPS default (`fpsCap`). Each redraw is O(rows × cols) which is < 1 ms for the default 8×80 budget.
- File IO: one write per game-over (atomic) and one write per `stop()` (atomic). Best score file is small JSON (< 1 KB).
- Memory: one engine state per widget (~5 KB), no timers leak (cleared on `stop()`).
- The widget is **CPU-quiet** — it spends < 5 ms per second rendering. It will not interfere with the host agent's token streaming latency.

## Future work (out of scope for this MVP)

- Web-based leaderboard (the `state.json` schema already has placeholders for this)
- Multiplayer / live tournaments
- Plugin auto-discovery for Hermes / Claude Code / Codex
- Theming API for partner surfaces
- Sound effects (gated behind user opt-in)
