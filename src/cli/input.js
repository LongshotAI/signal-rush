function createInputBuffer(options = {}) {
  // AI Hunt wants continuous movement: hold a direction to keep gliding
  // that way. Frogger wants discrete hops: a tap moves one tile, releasing
  // the key stops the frog. The singleShot option toggles the second
  // behaviour on — after consume() returns the direction, it is cleared
  // so the next tick produces no movement unless the user has pressed
  // again. The terminal's auto-repeat then still gives a "hold to rapid-
  // hop" feel for Frogger, but a single tap is a single hop.
  const singleShot = options.singleShot === true;
  // Active direction persists across consumes so that holding a key
  // (or pressing it once and waiting for the next tick) feels continuous.
  // Press the same direction again after a pause to toggle off.
  const state = {
    activeDirection: null,
    lastDirPressAt: 0,
    dashQueued: false,
    restartQueued: false,
    quitQueued: false,
    pauseQueued: false,
    lastInputAt: 0,
  };

  const DIRECTION_KEYS = {
    up: { x: 0, y: -1 },
    w: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    s: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    a: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    d: { x: 1, y: 0 },
  };

  // Auto-repeat window in ms. Terminals send repeated keypress events
  // for held keys at this rate; presses within the window are treated
  // as continuous hold, presses outside it are deliberate toggles.
  const REPEAT_WINDOW_MS = 200;

  function touchInput() {
    state.lastInputAt = Date.now();
  }

  function queueDirection(keyName) {
    const vector = DIRECTION_KEYS[keyName];
    if (!vector) return false;
    const now = Date.now();
    const sameAsActive =
      state.activeDirection &&
      state.activeDirection.x === vector.x &&
      state.activeDirection.y === vector.y;
    const isAutoRepeat =
      sameAsActive && (now - state.lastDirPressAt) < REPEAT_WINDOW_MS;
    if (isAutoRepeat) {
      // Held key; keep the active direction as-is.
      touchInput();
      return true;
    }
    if (sameAsActive && !singleShot) {
      // Same direction pressed deliberately after a pause -> stop.
      // (In singleShot mode the active direction is cleared after each
      // consume, so the only way it could be the same is if the user
      // tapped it twice quickly — treat that as "hop again" not "stop".)
      state.activeDirection = null;
    } else {
      // Different direction (or first press) -> set/overwrite.
      state.activeDirection = vector;
    }
    state.lastDirPressAt = now;
    touchInput();
    return true;
  }

  function handleKeypress(sequence, key = {}) {
    if (key.sequence === '\u0003') {
      state.quitQueued = true;
      return;
    }

    const name = (key.name || '').toLowerCase();
    const seq = typeof sequence === 'string' ? sequence.toLowerCase() : '';
    const lookupName = name || seq;

    if (queueDirection(lookupName)) return;
    if (name === 'space' || seq === ' ') {
      state.dashQueued = true;
      touchInput();
    }
    else if (name === 'r' || seq === 'r') {
      state.restartQueued = true;
      touchInput();
    }
    else if (name === 'q' || seq === 'q') {
      state.quitQueued = true;
      touchInput();
    }
    else if (name === 'p' || seq === 'p') {
      state.pauseQueued = true;
      touchInput();
    }
  }

  function consume() {
    const snapshot = {
      move: state.activeDirection,
      dash: state.dashQueued,
      restart: state.restartQueued,
      quit: state.quitQueued,
      pause: state.pauseQueued,
      lastInputAt: state.lastInputAt,
    };
    state.dashQueued = false;
    state.restartQueued = false;
    state.quitQueued = false;
    state.pauseQueued = false;
    if (singleShot) {
      // Discrete-hop model: each consume drains the active direction so
      // the next tick produces no movement unless the user re-pressed.
      state.activeDirection = null;
    }
    return snapshot;
  }

  return {
    handleKeypress,
    consume,
  };
}

module.exports = {
  createInputBuffer,
};
