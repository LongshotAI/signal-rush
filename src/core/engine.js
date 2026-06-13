const { GAME_CONFIG } = require('../config/gameConfig');
const { createInitialState, createPlayer } = require('./createInitialState');
const { randInt, clamp, moveToward } = require('./utils');

function randomOpenCell(state, avoidCenter = false) {
  for (let tries = 0; tries < 200; tries += 1) {
    const x = randInt(1, GAME_CONFIG.width - 2);
    const y = randInt(1, GAME_CONFIG.height - 2);
    if (avoidCenter) {
      const dist = Math.abs(x - state.player.x) + Math.abs(y - state.player.y);
      if (dist < 7) continue;
    }
    const occupiedByHazard = state.hazards.some((h) => h.x === x && h.y === y);
    const occupiedByPickup = state.pickups.some((p) => p.x === x && p.y === y);
    const occupiedByPlayer = state.player && state.player.x === x && state.player.y === y;
    if (!occupiedByHazard && !occupiedByPickup && !occupiedByPlayer) return { x, y };
  }
  return null;
}

function spawnPickup(state) {
  const cell = randomOpenCell(state, true);
  if (!cell) return null;
  const pickup = {
    x: cell.x,
    y: cell.y,
    value: randInt(GAME_CONFIG.pickupValueMin, GAME_CONFIG.pickupValueMax),
    ttl: randInt(GAME_CONFIG.pickupTtlMin, GAME_CONFIG.pickupTtlMax),
  };
  state.pickups.push(pickup);
  return pickup;
}

function spawnHazard(state) {
  const edges = [];
  for (let x = 2; x < GAME_CONFIG.width - 2; x += 1) {
    edges.push({ x, y: 1 });
    edges.push({ x, y: GAME_CONFIG.height - 2 });
  }
  for (let y = 2; y < GAME_CONFIG.height - 2; y += 1) {
    edges.push({ x: 1, y });
    edges.push({ x: GAME_CONFIG.width - 2, y });
  }
  for (let tries = 0; tries < 200; tries += 1) {
    const cell = edges[randInt(0, edges.length - 1)];
    const conflict = state.hazards.some((h) => h.x === cell.x && h.y === cell.y);
    const playerConflict = state.player.x === cell.x && state.player.y === cell.y;
    if (!conflict && !playerConflict) {
      const hazard = {
        x: cell.x,
        y: cell.y,
        kind: Math.random() < 0.18 ? 'corruptor' : 'packet',
      };
      state.hazards.push(hazard);
      return hazard;
    }
  }
  return null;
}

function createDeathState(state, killerType) {
  return {
    inactive: true,
    cause: 'hazard_contact',
    killerType,
    finalTick: state.tick,
    finalPosition: { x: state.player.x, y: state.player.y },
    finalScore: state.score,
    finalCombo: state.combo,
    finalCredits: state.credits,
    bestScoreUpdated: state.score >= state.bestScore,
  };
}

function resetState(state) {
  const fresh = createInitialState();
  state.running = fresh.running;
  state.paused = fresh.paused;
  state.gameOver = fresh.gameOver;
  state.tick = fresh.tick;
  state.score = fresh.score;
  state.credits = fresh.credits;
  state.combo = fresh.combo;
  state.bestScore = fresh.bestScore || state.bestScore || 0;
  state.dashCooldown = fresh.dashCooldown;
  state.invulnerable = fresh.invulnerable;
  state.message = fresh.message;
  state.player = createPlayer();
  state.hazards = [];
  state.pickups = [];
  state.lastMove = { x: 0, y: -1 };
  state.currentMove = null;
  state.lastEvents = [];
  state.deathState = null;
  state.lastMilestoneIndex = -1;
  state.sponsorLabelIndex = 0;
  state.trail = null;
  state.inputPulse = 0;
  state.moveFlash = 0;
  for (let i = 0; i < GAME_CONFIG.initialPickupCount; i += 1) {
    spawnPickup(state);
  }
}

function createEngine() {
  const state = createInitialState();
  state.bestScore = 0;
  resetState(state);

  function step(input = {}) {
    const events = [];
    state.lastEvents = events;

    if (input.pause && !state.gameOver) {
      state.paused = !state.paused;
      state.message = state.paused ? 'Paused.' : 'Back in the run.';
      events.push({ type: 'pause_toggled', paused: state.paused });
      return state;
    }

    if (state.gameOver) {
      if (input.restart) {
        resetState(state);
        state.message = 'Signal live. New run.';
        state.lastEvents = [{ type: 'run_restarted' }];
      }
      return state;
    }

    if (state.paused) {
      return state;
    }

    state.tick += 1;
    state.dashCooldown = Math.max(0, state.dashCooldown - 1);
    state.invulnerable = Math.max(0, state.invulnerable - 1);
    if (state.inputPulse > 0) state.inputPulse -= 1;
    if (state.moveFlash > 0) state.moveFlash -= 1;
    if (state.trail && state.trail.ttl > 0) {
      state.trail.ttl -= 1;
      if (state.trail.ttl <= 0) state.trail = null;
    }

    const player = state.player;
    let move = input.move || null;
    let steps = 1;

    const moveChanged = Boolean(
      (move && (!state.currentMove || move.x !== state.currentMove.x || move.y !== state.currentMove.y)) ||
      (!move && state.currentMove)
    );

    if (move) {
      state.lastMove = move;
      if (moveChanged) {
        state.inputPulse = GAME_CONFIG.inputFeedbackTicks;
      }
    }
    state.currentMove = move;

    if (input.dash && state.dashCooldown === 0) {
      const dashVector = move || state.lastMove;
      if (dashVector && (dashVector.x !== 0 || dashVector.y !== 0)) {
        move = dashVector;
        steps = 2;
        state.dashCooldown = GAME_CONFIG.dashCooldownTicks;
        state.message = 'Dash.';
        events.push({ type: 'dash_used' });
      }
    }

    if (move) {
      const startX = player.x;
      const startY = player.y;
      for (let i = 0; i < steps; i += 1) {
        player.x = clamp(player.x + move.x, 1, GAME_CONFIG.width - 2);
        player.y = clamp(player.y + move.y, 1, GAME_CONFIG.height - 2);
      }
      if (player.x !== startX || player.y !== startY) {
        state.trail = { x: startX, y: startY, ttl: GAME_CONFIG.trailTicks, from: { x: startX, y: startY }, to: { x: player.x, y: player.y } };
        state.moveFlash = GAME_CONFIG.moveFlashTicks;
        events.push({ type: 'player_moved', from: { x: startX, y: startY }, to: { x: player.x, y: player.y } });
      }
    }

    const safeWindowActive = state.tick <= GAME_CONFIG.hazardRamp.safeStartTicks;
    const hazardFloor = Math.min(
      GAME_CONFIG.hazardRamp.max,
      GAME_CONFIG.hazardRamp.base + Math.floor(state.tick / GAME_CONFIG.hazardRamp.growthIntervalTicks),
    );

    if (!safeWindowActive && state.hazards.length < hazardFloor && Math.random() < GAME_CONFIG.hazardRamp.randomSpawnChance) {
      const spawned = spawnHazard(state);
      if (spawned) events.push({ type: 'hazard_spawned', kind: spawned.kind });
    }

    if (
      !safeWindowActive &&
      state.tick % GAME_CONFIG.hazardRamp.lowCountPulseEvery === 0 &&
      state.hazards.length < GAME_CONFIG.hazardRamp.lowCountThreshold
    ) {
      const spawned = spawnHazard(state);
      if (spawned) events.push({ type: 'hazard_spawned', kind: spawned.kind });
    }

    for (const hazard of state.hazards) {
      const next = moveToward(player.x, player.y, hazard.x, hazard.y);
      hazard.x = clamp(next.x, 1, GAME_CONFIG.width - 2);
      hazard.y = clamp(next.y, 1, GAME_CONFIG.height - 2);
    }

    let lethal = false;
    state.hazards = state.hazards.filter((hazard) => {
      const hit = hazard.x === player.x && hazard.y === player.y;
      if (!hit) return true;
      if (state.invulnerable > 0) return false;
      const damage = hazard.kind === 'corruptor' ? 2 : 1;
      player.health -= damage;
      state.combo = 1;
      state.invulnerable = GAME_CONFIG.invulnerableTicks;
      events.push({ type: 'player_hit', killerType: hazard.kind, damage });
      if (player.health <= 0) {
        lethal = true;
        state.deathState = createDeathState(state, hazard.kind);
        state.message = `Destroyed by ${hazard.kind}. Final score ${state.score}. Press r.`;
        return false;
      }
      state.message = hazard.kind === 'corruptor' ? 'Corruptor impact.' : 'Packet hit.';
      return false;
    });

    if (lethal) {
      state.bestScore = Math.max(state.bestScore, state.score);
      state.gameOver = true;
      events.push({ type: 'run_ended', deathState: state.deathState });
      return state;
    }

    state.pickups = state.pickups.filter((pickup) => {
      if (pickup.x === player.x && pickup.y === player.y) {
        events.push({ type: 'pickup_collected', value: pickup.value });
        const priorCombo = state.combo;
        state.combo = Math.min(9.9, Number((state.combo + 0.3).toFixed(1)));
        if (state.combo !== priorCombo) {
          events.push({ type: 'combo_changed', combo: state.combo });
        }
        const gained = Math.floor(pickup.value * state.combo);
        state.score += gained;
        const credits = Math.max(1, Math.floor(gained / 25));
        state.credits += credits;
        events.push({ type: 'credits_awarded', credits });
        state.message = `Signal secured +${gained}. Keep moving.`;
        return false;
      }
      pickup.ttl -= 1;
      if (pickup.ttl <= 0) return false;
      return true;
    });

    state.score += Math.floor(GAME_CONFIG.baseScorePerTick * state.combo);

    if (safeWindowActive && state.tick === 1) {
      state.message = 'Calibration window live. Test movement, reversals, and dash.';
    }

    while (state.pickups.length < GAME_CONFIG.minPickups) {
      const pickup = spawnPickup(state);
      if (pickup) events.push({ type: 'pickup_spawned' });
      else break;
    }
    if (state.tick % GAME_CONFIG.pickupRamp.pulseEvery === 0 && state.pickups.length < GAME_CONFIG.maxPickups) {
      const pickup = spawnPickup(state);
      if (pickup) events.push({ type: 'pickup_spawned' });
    }

    const reachedMilestoneIndex = GAME_CONFIG.scoreMilestones.reduce((best, threshold, index) => {
      return state.score >= threshold ? index : best;
    }, -1);
    if (reachedMilestoneIndex > state.lastMilestoneIndex) {
      state.lastMilestoneIndex = reachedMilestoneIndex;
      state.message = `Score surge ${GAME_CONFIG.scoreMilestones[reachedMilestoneIndex]}. Pressure rising.`;
    }

    if (state.tick % GAME_CONFIG.sponsorImpressionEveryTicks === 0) {
      state.sponsorLabelIndex = (state.sponsorLabelIndex + 1) % 3;
      events.push({ type: 'sponsor_impression' });
    }

    return state;
  }

  return {
    state,
    step,
    reset: () => resetState(state),
    spawnHazard: () => spawnHazard(state),
    spawnPickup: () => spawnPickup(state),
  };
}

module.exports = {
  createEngine,
};
