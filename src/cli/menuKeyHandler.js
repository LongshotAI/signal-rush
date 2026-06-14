// Pure menu keypress logic — no I/O, no stdout writes, no engine side effects.
// Returns the new menu state and an action the caller should take.
//
// Kept separate from index.js so it can be unit-tested without spawning a
// real terminal. The shape mirrors what index.js needs:
//   { menuMode, menuSelection }  →  { menuMode, menuSelection, action }
//
// `action` is one of:
//   'noop'         — no change (key ignored or no menu side-effect)
//   'select'       — user pressed Enter; caller should start the selected mode
//   'quit'         — user pressed Q / Ctrl-C; caller should schedule shutdown

function applyMenuKey(state, sequence, key = {}) {
  if (!state.menuMode) {
    // Critical guard: the menu handler must not act on game input.
    // Previously this leaked through and pressing Enter mid-game would
    // silently switch the active mode.
    return { menuMode: state.menuMode, menuSelection: state.menuSelection, action: 'noop' };
  }
  const name = (key.name || '').toLowerCase();
  const seq = typeof sequence === 'string' ? sequence.toLowerCase() : '';
  const lookup = name || seq;
  const len = state.menuLength || 2;

  if (key.sequence === '\u0003') {
    return { menuMode: state.menuMode, menuSelection: state.menuSelection, action: 'quit' };
  }
  if (lookup === 'q') {
    return { menuMode: state.menuMode, menuSelection: state.menuSelection, action: 'quit' };
  }
  // Up navigation. The fallback list covers:
  //   - 'up'  : readline-parsed key name (normal path)
  //   - 'w'/'k': WASD / vim alternatives
  //   - '\x1b[A': standard arrow-up escape (3 chars: ESC [ A)
  //   - '\x1bOA': alternate arrow-up from older xterm / VTE
  //               application cursor mode (3 chars: ESC O A)
  //   - '\x1b[a': lowercase variant (rare but seen in some terminals)
  // Some terminals don't parse the arrow key into a name, so we fall
  // through to the raw sequence match.
  if (lookup === 'up' || lookup === 'w' || lookup === 'k'
      || seq === '\x1b[a' || seq === '\x1boa') {
    const next = (state.menuSelection + len - 1) % len;
    return { menuMode: state.menuMode, menuSelection: next, action: 'noop' };
  }
  // Down navigation — same robustness.
  if (lookup === 'down' || lookup === 's' || lookup === 'j'
      || seq === '\x1b[b' || seq === '\x1bob') {
    const next = (state.menuSelection + 1) % len;
    return { menuMode: state.menuMode, menuSelection: next, action: 'noop' };
  }
  if (key.name === 'return' || key.name === 'enter' || seq === '\r' || seq === '\n') {
    return { menuMode: false, menuSelection: state.menuSelection, action: 'select' };
  }
  return { menuMode: state.menuMode, menuSelection: state.menuSelection, action: 'noop' };
}

module.exports = { applyMenuKey };
