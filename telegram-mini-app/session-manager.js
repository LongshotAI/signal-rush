/**
 * session-manager.js — Signal Rush Game Session Lifecycle
 *
 * Manages game sessions: start, input recording, end with receipt submission.
 * Each session tracks all inputs for server-side verification.
 */

export class SessionManager {
  constructor() {
    this.sessionId = null;
    this.startTime = 0;
    this.inputs = [];
    this.mode = null;
    this.seed = null;
    this.active = false;
  }

  /**
   * Start a new game session.
   */
  startSession(mode, seed) {
    this.sessionId = _randomUUID();
    this.mode = mode;
    this.seed = seed;
    this.startTime = Date.now();
    this.inputs = [];
    this.active = true;
    return this.sessionId;
  }

  /**
   * Record a player input for the current session.
   */
  recordInput(move, tick) {
    if (!this.active) return;
    this.inputs.push({
      tick: tick ?? this.inputs.length,
      move: move || { x: 0, y: 0 },
    });
  }

  /**
   * End the current session and generate receipt data.
   */
  endSession(finalState) {
    if (!this.active) return null;
    this.active = false;
    return {
      sessionId: this.sessionId,
      seed: this.seed,
      mode: this.mode,
      inputs: [...this.inputs],
      score: finalState?.score || 0,
      level: finalState?.level || 1,
      duration_ms: Date.now() - this.startTime,
      move_count: this.inputs.length,
    };
  }

  /**
   * Get current session stats (mid-game).
   */
  getSessionStats() {
    return {
      active: this.active,
      sessionId: this.sessionId,
      mode: this.mode,
      moveCount: this.inputs.length,
      duration_ms: this.active ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Reset for a new game.
   */
  reset() {
    this.sessionId = null;
    this.startTime = 0;
    this.inputs = [];
    this.mode = null;
    this.seed = null;
    this.active = false;
  }
}

function _randomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
