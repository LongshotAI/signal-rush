const { GAME_CONFIG } = require('../config/gameConfig');
const { createInitialState, createPlayer } = require('./createInitialState');
const { randInt, clamp, moveToward } = require('./utils');
const { createRNG } = require('./rng');

// Safe RNG accessor — falls back to Math.random when no seeded RNG is attached.
// Prevents TypeError on code paths that build state without going through createEngine
// (e.g. tests, partial mocks, or future callers that skip the RNG wiring).
function getRng(state) {
  return state.rng || Math.random;
}

function randomOpenCell(state, avoidCenter = false) {
  const rng = getRng(state);
  for (let tries = 0; tries < 200; tries += 1) {
    const x = randInt(1, GAME_CONFIG.width - 2, rng);
    const y = randInt(1, GAME_CONFIG.height - 2, rng);
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
  const rng = getRng(state);
  const cell = randomOpenCell(state, true);
  if (!cell) return null;
  const pickup = {
    x: cell.x,
    y: cell.y,
    value: randInt(GAME_CONFIG.pickupValueMin, GAME_CONFIG.pickupValueMax, rng),
    ttl: randInt(GAME_CONFIG.pickupTtlMin, GAME_CONFIG.pickupTtlMax, rng),
  };
  // Deterministic pickup type — no RNG shift
  const typeSeed = (state.tick * 11 + cell.x * 17 + cell.y * 23) % 100;
  pickup.type = typeSeed >= GAME_CONFIG.pickupTypes.shieldThreshold ? 'shield' : 'credit';
  state.pickups.push(pickup);
  return pickup;
}

function spawnHazard(state) {
  const rng = getRng(state);
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
    const cell = edges[randInt(0, edges.length - 1, rng)];
    const conflict = state.hazards.some((h) => h.x === cell.x && h.y === cell.y);
    const playerConflict = state.player.x === cell.x && state.player.y === cell.y;
    const pickupConflict = state.pickups.some((p) => p.x === cell.x && p.y === cell.y);
    if (!conflict && !playerConflict && !pickupConflict) {
      const hazard = {
        x: cell.x,
        y: cell.y,
        kind: rng() < 0.18 ? 'corruptor' : 'packet',
      };
      // Deterministic behavior selection — no extra RNG call needed.
      // Hash is derived from tick + position so same seed = same result.
      const behaviorSeed = (state.tick * 7 + cell.x * 13 + cell.y * 31 + (state.hazards.length + 1) * 37) % 100;
      hazard.behavior = behaviorSeed >= GAME_CONFIG.hazardBehavior.patrolThreshold ? 'patrol' : 'homing';
      // Patrol direction: deterministic from position (so it's consistent per seed)
      if (hazard.behavior === 'patrol') {
        hazard.dirX = (cell.x + cell.y + state.tick) % 2 === 0 ? 1 : -1;
        hazard.dirY = 0;
      }
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

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function awardNearMisses(state, events) {
  const cfg = GAME_CONFIG.nearMiss || {};
  const radius = cfg.radius || 1;
  const maxPerTick = cfg.maxPerTick || 1;
  const nearCount = Math.min(
    maxPerTick,
    state.hazards.filter((hazard) => {
      const distance = manhattan(state.player, hazard);
      return distance > 0 && distance <= radius;
    }).length,
  );
  if (nearCount <= 0) return;
  const gained = nearCount * (cfg.score || 0);
  const bump = nearCount * (cfg.comboBump || 0);
  state.nearMissStreak = (state.nearMissStreak || 0) + nearCount;
  state.score += gained;
  state.combo = Math.min(9.9, Number((state.combo + bump).toFixed(1)));
  state.message = nearCount === 1
    ? `Near miss +${gained}. Thread the signal.`
    : `Near misses x${nearCount} +${gained}. Risk pays.`;
  events.push({ type: 'near_miss', count: nearCount, score: gained, streak: state.nearMissStreak });
}

function resetState(state) {
  if (state.mode === 'frogger') {
    return resetStateFrogger(state);
  }
  return resetStateAiHunt(state);
}

function resetStateAiHunt(state) {
  const fresh = createInitialState({ mode: 'aiHunt' });
  state.running = fresh.running;
  state.paused = fresh.paused;
  state.gameOver = fresh.gameOver;
  state.tick = fresh.tick;
  state.score = fresh.score;
  state.credits = fresh.credits;
  state.combo = fresh.combo;
  state.bestScore = state.bestScore || 0;
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
  state.nearMissStreak = 0;
  state.trail = null;
  state.inputPulse = 0;
  state.moveFlash = 0;
  state.consecutivePickups = 0;
  state.comboDecayTimer = 0;
  state.shieldPickupActive = false;
  state.telegraphs = [];
  state.difficultyTier = 0;
  for (let i = 0; i < GAME_CONFIG.initialPickupCount; i += 1) {
    spawnPickup(state);
  }
}

function resetStateFrogger(state) {
  const fresh = createInitialState({ mode: 'frogger' });
  state.mode = 'frogger';
  state.running = fresh.running;
  state.paused = fresh.paused;
  state.gameOver = fresh.gameOver;
  state.tick = fresh.tick;
  state.score = fresh.score;
  state.credits = fresh.credits;
  state.combo = 1;
  state.bestScore = state.bestScore || 0;
  state.dashCooldown = 0;
  state.invulnerable = 0;
  state.message = fresh.message;
  state.player = { ...fresh.player };
  state.hazards = [];
  state.pickups = [];
  state.trail = null;
  state.inputPulse = 0;
  state.moveFlash = 0;
  state.deathState = null;
  // Frogger-specific
  state.lives = fresh.lives;
  state.maxLives = fresh.maxLives;
  state.level = fresh.level;
  state.homeSlots = [...fresh.homeSlots];
  state.timeLeft = fresh.timeLeft;
  state.maxTime = fresh.maxTime;
  state.onLog = null;
  state.lastFroggerCause = null;
  state.bestProgressY = fresh.bestProgressY;
  state.lanes = fresh.lanes.map((l) => ({
    y: l.y, type: l.type, direction: l.direction || 0, speed: l.speed || 0,
    vehicles: (l.vehicles || []).map((v) => ({ x: v.x })),
  }));
}

function respawnFrog(state) {
  const cfg = GAME_CONFIG.modes.frogger;
  state.player.x = cfg.spawnX;
  state.player.y = cfg.spawnRow;
  state.onLog = null;
  state.bestProgressY = cfg.spawnRow;
  state.timeLeft = cfg.timePerLevel;
}

function laneAt(state, y) {
  return state.lanes.find((l) => l.y === y);
}

// Sync onLog with the player's current position.
// Called at the start of every step so that:
//   - a player manually placed on a log (e.g. by a test) rides it immediately
//   - a player who hops onto a log via input gets the ride on the very next tick
//   - a player who falls off a log has onLog cleared
function syncOnLog(state) {
  const lane = state.lanes.find((l) => l.y === state.player.y);
  if (lane && lane.type === 'river') {
    const log = lane.vehicles.find((v) => v.x === state.player.x);
    if (log) {
      state.onLog = log;
      return;
    }
  }
  state.onLog = null;
}

function loseFroggerLife(state, cause) {
  state.lives -= 1;
  state.lastFroggerCause = cause;
  state.onLog = null;
  if (state.lives <= 0) {
    state.gameOver = true;
    state.deathState = {
      inactive: true,
      cause,
      killerType: cause,
      finalTick: state.tick,
      finalPosition: { x: state.player.x, y: state.player.y },
      finalScore: state.score,
      finalCombo: state.combo,
      finalCredits: state.credits,
      bestScoreUpdated: state.score >= state.bestScore,
      mode: 'frogger',
      level: state.level,
      homeSlots: [...state.homeSlots],
    };
    state.message = `${cause}. Game over. Press R or M.`;
    return;
  }
  respawnFrog(state);
  // Re-arm GET READY so the player has a beat to read the new layout
  // before the cars start moving again.
  state.getReadyTicks = GAME_CONFIG.modes.frogger.getReadyTicks;
  state.message = `${cause}. ${state.lives} ${state.lives === 1 ? 'frog' : 'frogs'} left.`;
}

function tryFillHomeSlot(state) {
  const cfg = GAME_CONFIG.modes.frogger;
  const slotIndex = cfg.homeSlotXs.indexOf(state.player.x);
  if (slotIndex === -1) {
    loseFroggerLife(state, 'wrong_slot');
    return;
  }
  if (state.homeSlots[slotIndex]) {
    loseFroggerLife(state, 'slot_blocked');
    return;
  }
  state.homeSlots[slotIndex] = true;
  state.score += cfg.slotScore;
  state.combo = Math.min(9.9, Number((state.combo + 0.5).toFixed(1)));
  state.lastEvents.push({ type: 'home_slot_filled', slotIndex });
  if (state.homeSlots.every((s) => s)) {
    const timeBonus = state.timeLeft * cfg.timeBonusPerTick;
    const levelBonus = cfg.levelClearBonus * state.level;
    state.score += timeBonus + levelBonus;
    state.level += 1;
    state.homeSlots = [false, false, false, false, false];
    state.timeLeft = cfg.timePerLevel + state.level * 5;
    state.maxTime = state.timeLeft;
    // Re-arm GET READY so the next level starts with a beat for the
    // player to read the (now-faster) layout.
    state.getReadyTicks = cfg.getReadyTicks;
    state.lastEvents.push({ type: 'level_cleared', level: state.level - 1 });
    respawnFrog(state);
    state.message = `Level cleared. +${timeBonus} time + ${levelBonus} bonus. Level ${state.level}.`;
    return;
  }
  respawnFrog(state);
  state.message = `Slot ${slotIndex + 1} filled. ${state.homeSlots.filter((s) => !s).length} to go.`;
}

function stepFrogger(state, input) {
  const events = state.lastEvents = [];

  // GET READY window: when getReadyTicks > 0 the level hasn't started yet.
  // Vehicles don't move, the timer doesn't tick, and the frog can hop
  // freely to read the layout — but cannot move into lethal positions
  // (water without a log, or onto a car). If the player tries, the
  // move is rejected (position reset to pre-move). This prevents the
  // exploit of repositioning into danger and dying instantly when GO hits.
  if (state.getReadyTicks > 0) {
    if (input.pause) {
      // Allow toggling pause during GET READY.
      state.paused = !state.paused;
      state.message = state.paused ? 'Paused.' : 'Back in the run.';
      events.push({ type: 'pause_toggled', paused: state.paused });
      return state;
    }
    if (state.paused) return state;
    const move = input.move || null;
    if (move) {
      const prevX = state.player.x;
      const prevY = state.player.y;
      // Pac-Man wrap on horizontal edges
      const rawX = state.player.x + move.x;
      const newX = rawX < 0 ? GAME_CONFIG.width - 1 : rawX >= GAME_CONFIG.width ? 0 : clamp(rawX, 1, GAME_CONFIG.width - 2);
      const newY = clamp(state.player.y + move.y, 1, GAME_CONFIG.height - 2);
      // Check if the new position would be lethal
      const lane = state.lanes.find((l) => l.y === newY);
      let isLethal = false;
      if (lane) {
        if (lane.type === 'river') {
          // Lethal if no log at the new position
          const log = lane.vehicles.find((v) => v.x === newX);
          if (!log) isLethal = true;
        } else if (lane.type === 'road') {
          // Lethal if a car is at the new position
          const car = lane.vehicles.find((v) => v.x === newX);
          if (car) isLethal = true;
        }
        // home, median, and unknown lane types are safe
      }
      if (isLethal) {
        // Reject the move — player stays put
        state.message = 'Blocked. Find another route.';
      } else {
        state.player.x = newX;
        state.player.y = newY;
        state.lastMove = move;
        state.inputPulse = 2;
        events.push({ type: 'player_hop', to: { x: state.player.x, y: state.player.y } });
      }
    }
    if (state.inputPulse > 0) state.inputPulse -= 1;
    state.getReadyTicks -= 1;
    if (state.getReadyTicks === 0) {
      state.message = 'GO!';
      events.push({ type: 'level_started', level: state.level });
    } else if (state.getReadyTicks <= 6) {
      // Countdown aligned with render overlay (render shows "GET READY — {seconds}…"
      // where seconds = ceil(getReadyTicks / 10)). For ticks <= 6 that's "GET READY — 1…".
      const seconds = Math.max(0, Math.ceil(state.getReadyTicks / 10));
      state.message = seconds > 0 ? `GET READY — ${seconds}…` : 'GO!';
    }
    return state;
  }

  if (input.pause && !state.gameOver) {
    state.paused = !state.paused;
    state.message = state.paused ? 'Paused.' : 'Back in the run.';
    events.push({ type: 'pause_toggled', paused: state.paused });
    return state;
  }
  if (state.gameOver) {
    if (input.restart) {
      state.lives = GAME_CONFIG.modes.frogger.lives;
      state.level = 1;
      state.score = 0;
      state.combo = 1;
      state.credits = 0;
      state.timeLeft = GAME_CONFIG.modes.frogger.timePerLevel;
      state.maxTime = state.timeLeft;
      state.homeSlots = [false, false, false, false, false];
      state.player = { x: GAME_CONFIG.modes.frogger.spawnX, y: GAME_CONFIG.modes.frogger.spawnRow };
      state.onLog = null;
      state.gameOver = false;
      state.deathState = null;
      state.getReadyTicks = GAME_CONFIG.modes.frogger.getReadyTicks;
      state.message = 'New run. New pattern.';
      events.push({ type: 'run_restarted' });
    }
    return state;
  }
  if (state.paused) return state;

  state.tick += 1;
  state.timeLeft -= 1;
  if (state.timeLeft <= 0) {
    loseFroggerLife(state, 'timeout');
    if (state.gameOver) return state;
  }

  // 1. Sync onLog with the player's current position. This ensures a player
  //    who begins the tick on a log (e.g. just hopped onto one, or was placed
  //    there by a test) is recognized as riding it before vehicles move.
  syncOnLog(state);

  // 2. Apply player hop input (one-tile).
  const move = input.move || null;
  if (move) {
    // Pac-Man wrap on horizontal edges
    const rawX = state.player.x + move.x;
    state.player.x = rawX < 0 ? GAME_CONFIG.width - 1 : rawX >= GAME_CONFIG.width ? 0 : clamp(rawX, 1, GAME_CONFIG.width - 2);
    state.player.y = clamp(state.player.y + move.y, 1, GAME_CONFIG.height - 2);
    state.lastMove = move;
    state.inputPulse = 2;
    events.push({ type: 'player_hop', to: { x: state.player.x, y: state.player.y } });
    if (move.y < 0 && state.player.y < state.bestProgressY) {
      const rowsGained = state.bestProgressY - state.player.y;
      const gained = rowsGained * GAME_CONFIG.modes.frogger.forwardProgressScore;
      state.bestProgressY = state.player.y;
      state.score += gained;
      state.message = `Forward +${gained}. Keep climbing.`;
      events.push({ type: 'forward_progress', rows: rowsGained, score: gained });
    }
  }
  if (state.inputPulse > 0) state.inputPulse -= 1;
  if (state.moveFlash > 0) state.moveFlash -= 1;

  // 2b. Pre-movement collision check: if the player is already on a car
  //     or in water (e.g. placed there by a test, or landed on a log that
  //     then carried them to an edge), catch it before vehicles move.
  //     Without this, a player standing on a car survives because the car
  //     drives away before the post-movement check at step 5.
  {
    const preLane = laneAt(state, state.player.y);
    if (preLane) {
      if (preLane.type === 'road') {
        const hit = preLane.vehicles.some((v) => v.x === state.player.x);
        if (hit) {
          loseFroggerLife(state, 'car');
          if (state.gameOver) return state;
        }
      } else if (preLane.type === 'river' && !state.onLog) {
        // onLog is already synced by syncOnLog above; if null, player is in water
        loseFroggerLife(state, 'water');
        if (state.gameOver) return state;
      }
    }
  }

  // 3. Move all vehicles; wrap around the arena. Per-level speed multiplier
  //    softens level 1 (a speed-3 car becomes 1 there) without ever stopping
  //    a vehicle entirely.
  const mults = GAME_CONFIG.modes.frogger.levelSpeedMultipliers || [1];
  const speedMult = mults[state.level - 1] != null ? mults[state.level - 1] : 1;
  for (const lane of state.lanes) {
    if (lane.type !== 'road' && lane.type !== 'river') continue;
    for (const v of lane.vehicles) {
      const effectiveSpeed = Math.max(1, Math.floor(lane.speed * speedMult));
      v.x += lane.direction * effectiveSpeed;
      if (v.x < 1) v.x = GAME_CONFIG.width - 2;
      else if (v.x > GAME_CONFIG.width - 2) v.x = 1;
    }
  }

  // 4. If player was on a log, move with it; off-screen = drown.
  if (state.onLog) {
    const log = state.onLog;
    const lane = state.lanes.find((l) => l.y === state.player.y);
    if (lane && lane.type === 'river') {
      state.player.x = clamp(log.x, 1, GAME_CONFIG.width - 2);
    } else {
      state.onLog = null;
    }
  }
  if (state.player.x < 1 || state.player.x > GAME_CONFIG.width - 2) {
    loseFroggerLife(state, 'off_screen');
    if (state.gameOver) return state;
  }

  // 5. Check collisions / rides based on the player's current row.
  //    Re-sync onLog AFTER the ride too, so a player who is now sitting on a
  //    log keeps the reference fresh for the next tick.
  const playerRow = state.player.y;
  const lane = laneAt(state, playerRow);
  if (lane) {
    if (lane.type === 'road') {
      const hit = lane.vehicles.some((v) => v.x === state.player.x);
      if (hit) {
        loseFroggerLife(state, 'car');
        if (state.gameOver) return state;
      }
    } else if (lane.type === 'river') {
      const log = lane.vehicles.find((v) => v.x === state.player.x);
      if (log) {
        state.onLog = log;
      } else {
        loseFroggerLife(state, 'water');
        if (state.gameOver) return state;
      }
    } else if (lane.type === 'home') {
      tryFillHomeSlot(state);
    } else {
      // median or unknown: clear onLog
      state.onLog = null;
    }
  }

  // Reset the "GO!" message from the GET READY window so the player gets
  // a neutral play-state hint on the first normal tick instead of seeing
  // "GO!" stuck in the message line for the whole run.
  if (state.message === 'GO!') {
    state.message = 'Move WASD/arrows. Hop logs. Avoid cars. Fill the slots.';
  }

  // Sponsor impressions: fire on the same cadence as AI Hunt
  if (!state.paused && !state.gameOver && state.tick % GAME_CONFIG.sponsorImpressionEveryTicks === 0) {
    events.push({ type: 'sponsor_impression' });
  }

  return state;
}

function step(input = {}) {
  const state = this.state;
  if (state.mode === 'frogger') {
    return stepFrogger(state, input);
  }
  return stepAiHunt(this, state, input);
}

function stepAiHunt(engine, state, input) {
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

  // ── Difficulty tier ────────────────────────────────────────────────
  // Derived from tick — deterministic, no RNG needed.
  const tierCfg = GAME_CONFIG.difficultyTier || {};
  const tier = Math.min(
    tierCfg.maxTier || 10,
    Math.floor(state.tick / (tierCfg.intervalTicks || 80))
  );
  state.difficultyTier = tier;
  const tierSpawnBonus = tier * (tierCfg.spawnChancePerTier || 0);
  const tierSpeedBoost = 1 + tier * (tierCfg.speedBoostPerTier || 0);

  // ── Hazard spawn telegraph ──────────────────────────────────────────
  // Decrement existing telegraphs; if any reach 0, spawn hazard there.
  const telegraphTTL = GAME_CONFIG.spawnTelegraphTicks || 8;
  let spawnedFromTelegraph = false;
  state.telegraphs = state.telegraphs
    .map(t => ({ ...t, ttl: t.ttl - 1 }))
    .filter(t => {
      if (t.ttl <= 0) {
        // Spawn hazard at telegraph position
        const cell = { x: t.x, y: t.y };
        const conflict = state.hazards.some((h) => h.x === cell.x && h.y === cell.y);
        const playerConflict = state.player.x === cell.x && state.player.y === cell.y;
        const pickupConflict = state.pickups.some((p) => p.x === cell.x && p.y === cell.y);
        if (!conflict && !playerConflict && !pickupConflict) {
          const hazard = {
            x: cell.x,
            y: cell.y,
            kind: (t.kind === 'corruptor' || Math.floor(state.tick / telegraphTTL) % 5 === 0) ? 'corruptor' : 'packet',
          };
          const behaviorSeed = (state.tick * 7 + cell.x * 13 + cell.y * 31 + (state.hazards.length + 1) * 37) % 100;
          hazard.behavior = behaviorSeed >= GAME_CONFIG.hazardBehavior.patrolThreshold ? 'patrol' : 'homing';
          if (hazard.behavior === 'patrol') {
            hazard.dirX = (cell.x + cell.y + state.tick) % 2 === 0 ? 1 : -1;
            hazard.dirY = 0;
          }
          state.hazards.push(hazard);
          spawnedFromTelegraph = true;
          events.push({ type: 'hazard_spawned', kind: hazard.kind });
        }
        return false; // remove expired telegraph
      }
      return true;
    });

  // ── Hazard spawning ─────────────────────────────────────────────────
  const rng = getRng(state);
  const hazardFloor = Math.min(
    GAME_CONFIG.hazardRamp.max,
    GAME_CONFIG.hazardRamp.base + Math.floor(state.tick / GAME_CONFIG.hazardRamp.growthIntervalTicks),
  );

  const effectiveSpawnChance = Math.min(0.85, GAME_CONFIG.hazardRamp.randomSpawnChance + tierSpawnBonus);
  if (!safeWindowActive && state.hazards.length < hazardFloor && rng() < effectiveSpawnChance) {
    // Instead of spawning immediately, create a telegraph
    const edges = [];
    for (let x = 2; x < GAME_CONFIG.width - 2; x += 1) {
      edges.push({ x, y: 1 });
      edges.push({ x, y: GAME_CONFIG.height - 2 });
    }
    for (let y = 2; y < GAME_CONFIG.height - 2; y += 1) {
      edges.push({ x: 1, y });
      edges.push({ x: GAME_CONFIG.width - 2, y });
    }
    const edgeCell = edges[randInt(0, edges.length - 1, rng)];
    const conflict = state.hazards.some((h) => h.x === edgeCell.x && h.y === edgeCell.y);
    const playerConflict = state.player.x === edgeCell.x && state.player.y === edgeCell.y;
    const pickupConflict = state.pickups.some((p) => p.x === edgeCell.x && p.y === edgeCell.y);
    const telegraphConflict = state.telegraphs.some((t) => t.x === edgeCell.x && t.y === edgeCell.y);
    if (!conflict && !playerConflict && !pickupConflict && !telegraphConflict) {
      state.telegraphs.push({
        x: edgeCell.x,
        y: edgeCell.y,
        ttl: telegraphTTL,
        kind: rng() < 0.18 ? 'corruptor' : 'packet',
      });
      events.push({ type: 'telegraph_spawned', x: edgeCell.x, y: edgeCell.y });
    }
  }

  if (
    !safeWindowActive &&
    state.tick % GAME_CONFIG.hazardRamp.lowCountPulseEvery === 0 &&
    state.hazards.length < GAME_CONFIG.hazardRamp.lowCountThreshold
  ) {
    // Telegraph for low-count pulse too
    const edges = [];
    for (let x = 2; x < GAME_CONFIG.width - 2; x += 1) {
      edges.push({ x, y: 1 });
      edges.push({ x, y: GAME_CONFIG.height - 2 });
    }
    for (let y = 2; y < GAME_CONFIG.height - 2; y += 1) {
      edges.push({ x: 1, y });
      edges.push({ x: GAME_CONFIG.width - 2, y });
    }
    const edgeCell = edges[randInt(0, edges.length - 1, rng)];
    const conflict = state.hazards.some((h) => h.x === edgeCell.x && h.y === edgeCell.y);
    const playerConflict = state.player.x === edgeCell.x && state.player.y === edgeCell.y;
    const pickupConflict = state.pickups.some((p) => p.x === edgeCell.x && p.y === edgeCell.y);
    const telegraphConflict = state.telegraphs.some((t) => t.x === edgeCell.x && t.y === edgeCell.y);
    if (!conflict && !playerConflict && !pickupConflict && !telegraphConflict) {
      state.telegraphs.push({
        x: edgeCell.x,
        y: edgeCell.y,
        ttl: telegraphTTL,
        kind: rng() < 0.18 ? 'corruptor' : 'packet',
      });
      events.push({ type: 'telegraph_spawned', x: edgeCell.x, y: edgeCell.y });
    }
  }

  for (const hazard of state.hazards) {
    if (hazard.behavior === 'patrol') {
      // Patrol hazard: moves in a straight line, bounces off walls
      const speedMult = Math.min(2.5, tierSpeedBoost);
      const step = Math.max(1, Math.floor(speedMult));
      for (let s = 0; s < step; s++) {
        const newX = hazard.x + (hazard.dirX || 1);
        const newY = hazard.y + (hazard.dirY || 0);
        // Bounce off walls
        if (newX < 1 || newX > GAME_CONFIG.width - 2) {
          hazard.dirX = -(hazard.dirX || 1);
        }
        if (newY < 1 || newY > GAME_CONFIG.height - 2) {
          hazard.dirY = -(hazard.dirY || 0);
        }
        hazard.x = clamp(hazard.x + (hazard.dirX || 1), 1, GAME_CONFIG.width - 2);
        hazard.y = clamp(hazard.y + (hazard.dirY || 0), 1, GAME_CONFIG.height - 2);
      }
    } else {
      // Homing: moves toward player (existing behavior)
      const speedMult = Math.min(2.5, tierSpeedBoost);
      const step = Math.max(1, Math.floor(speedMult));
      for (let s = 0; s < step; s++) {
        const next = moveToward(player.x, player.y, hazard.x, hazard.y);
        hazard.x = clamp(next.x, 1, GAME_CONFIG.width - 2);
        hazard.y = clamp(next.y, 1, GAME_CONFIG.height - 2);
      }
    }
  }

  let lethal = false;
  state.hazards = state.hazards.filter((hazard) => {
    const hit = hazard.x === player.x && hazard.y === player.y;
    if (!hit) return true;
    if (state.invulnerable > 0) return false;
    const damage = hazard.kind === 'corruptor' ? 2 : 1;
    // Shield absorbs damage first
    if (state.player.shield > 0) {
      const absorbed = Math.min(state.player.shield, damage);
      state.player.shield -= absorbed;
      const remaining = damage - absorbed;
      if (remaining > 0) {
        player.health -= remaining;
      }
      state.combo = 1;
      state.nearMissStreak = 0;
      state.invulnerable = GAME_CONFIG.invulnerableTicks;
      events.push({ type: 'shield_blocked', absorbed, remaining });
      state.message = `Shield blocked ${absorbed}. ${state.player.shield} charges left.`;
      if (player.health <= 0) {
        lethal = true;
        state.deathState = createDeathState(state, hazard.kind);
        state.message = `Destroyed through shield. Final score ${state.score}. Press r.`;
        return false;
      }
      return false;
    }
    player.health -= damage;
    state.combo = 1;
    state.nearMissStreak = 0;
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

  awardNearMisses(state, events);

  // ── Pickup magnetism ────────────────────────────────────────────────
  // On mobile, pickups within radius drift toward the player (1 cell per tick).
  const magnetRadius = GAME_CONFIG.pickupMagnetRadius || 0;
  if (magnetRadius > 0) {
    for (const pickup of state.pickups) {
      const dx = player.x - pickup.x;
      const dy = player.y - pickup.y;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist > 0 && dist <= magnetRadius) {
        // Move pickup one step toward player
        pickup.x += Math.sign(dx);
        pickup.y += Math.sign(dy);
      }
    }
  }

  let collectedAny = false;

  state.pickups = state.pickups.filter((pickup) => {
    if (pickup.x === player.x && pickup.y === player.y) {
      collectedAny = true;
      events.push({ type: 'pickup_collected', value: pickup.value });

      if (pickup.type === 'shield') {
        // Shield pickup: grants shield charges instead of score/credits
        const shieldGain = GAME_CONFIG.pickupTypes.shieldCharges;
        state.player.shield = Math.min(5, (state.player.shield || 0) + shieldGain);
        state.consecutivePickups += 1;
        state.comboDecayTimer = 0;
        state.message = `🛡 Shield +${shieldGain}. ${state.player.shield} charges.`;
        events.push({ type: 'shield_pickup', shieldGain, total: state.player.shield });
        return false;
      }

      // Credit pickup (existing behavior)
      const priorCombo = state.combo;
      state.combo = Math.min(9.9, Number((state.combo + 0.3).toFixed(1)));
      if (state.combo !== priorCombo) {
        events.push({ type: 'combo_changed', combo: state.combo });
      }
      const gained = Math.floor(pickup.value * state.combo);
      state.score += gained;
      state.message = `Signal secured +${gained}. Keep moving.`;

      // Consecutive pickup streak
      state.consecutivePickups += 1;
      state.comboDecayTimer = 0;
      if (state.consecutivePickups > 0 && state.consecutivePickups % 5 === 0) {
        const streakBonus = 50 + state.consecutivePickups * 5;
        state.score += streakBonus;
        state.message = `⚡ Streak x${state.consecutivePickups}! +${streakBonus} bonus.`;
        events.push({ type: 'streak_bonus', count: state.consecutivePickups, bonus: streakBonus });
      }

      return false;
    }
    pickup.ttl -= 1;
    if (pickup.ttl <= 0) return false;
    return true;
  });

  state.score += Math.floor(GAME_CONFIG.baseScorePerTick * state.combo);

  // Combo decay: combo decreases when player is not collecting pickups
  // Resets timer on collect, decays 0.05/tick otherwise
  if (!collectedAny && state.combo > 1 && state.tick > GAME_CONFIG.hazardRamp.safeStartTicks) {
    state.comboDecayTimer += 1;
    if (state.comboDecayTimer >= 1) {
      state.combo = Math.max(1, Number((state.combo - GAME_CONFIG.comboDecay).toFixed(2)));
      state.comboDecayTimer = 0;
    }
  }

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

  // Only emit sponsor impressions when the game is actively being played
  // (not paused, not game over). This ensures ad billing accuracy —
  // impressions are only counted when the HUD is actually visible.
  if (!state.paused && !state.gameOver && state.tick % GAME_CONFIG.sponsorImpressionEveryTicks === 0) {
    state.sponsorLabelIndex = (state.sponsorLabelIndex + 1) % 3;
    events.push({ type: 'sponsor_impression' });
  }

  return state;
}

function createEngine(options = {}) {
  const mode = options.mode || 'aiHunt';
  const seed = options.seed;
  // RNG factory: controls whether reset() re-randomizes.
  //   - seed provided: factory creates a fresh mulberry32 from the seed each
  //     time, so reset() returns the engine to a deterministic starting point.
  //   - rng provided: factory returns the same caller-managed instance, so
  //     the caller controls RNG lifecycle. reset() does NOT re-randomize —
  //     the engine's randomness is whatever the caller's RNG yields next.
  //     This lets advanced users (e.g. distributed simulations, custom PRNGs)
  //     keep full control.
  const rngFactory = options.rng
    ? () => options.rng
    : (seed != null ? () => createRNG(seed) : null);
  const initialRng = rngFactory ? rngFactory() : null;
  const state = createInitialState({ mode });
  state.bestScore = 0;
  if (initialRng) state.rng = initialRng;
  resetState(state);

  function resetEngine() {
    if (rngFactory) state.rng = rngFactory();
    resetState(state);
  }

  return {
    state,
    step,
    reset: resetEngine,
    spawnHazard: () => spawnHazard(state),
    spawnPickup: () => spawnPickup(state),
  };
}

module.exports = {
  createEngine,
};
