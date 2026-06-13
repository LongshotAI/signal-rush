function createInputBuffer() {
  const state = {
    queuedMove: null,
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

  function touchInput() {
    state.lastInputAt = Date.now();
  }

  function queueDirection(keyName) {
    const vector = DIRECTION_KEYS[keyName];
    if (!vector) return false;
    state.queuedMove = vector;
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
      move: state.queuedMove,
      dash: state.dashQueued,
      restart: state.restartQueued,
      quit: state.quitQueued,
      pause: state.pauseQueued,
      lastInputAt: state.lastInputAt,
    };
    state.queuedMove = null;
    state.dashQueued = false;
    state.restartQueued = false;
    state.quitQueued = false;
    state.pauseQueued = false;
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
