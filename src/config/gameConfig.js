// Top-level fields are the AI Hunt configuration.
// They are also the default values used when no mode is specified.
// Per-mode tick rate. Frogger runs a touch slower than AI Hunt so the
// player has time to time hops against moving cars. Centralised so the
// game loop and any test that simulates a full run use the same value.
function getTickMsForMode(mode) {
  if (mode === 'frogger') return GAME_CONFIG.froggerTickMs || GAME_CONFIG.tickMs;
  return GAME_CONFIG.tickMs;
}

const GAME_CONFIG = {
  width: 56,
  height: 28,
  tickMs: 120,
  // Frogger wants a slightly slower cadence than AI Hunt so the player
  // has time to time hops against the moving cars. Read this via
  // getTickMsForMode(mode) below.
  froggerTickMs: 150,
  startHealth: 8,
  dashCooldownTicks: 8,
  invulnerableTicks: 3,
  baseScorePerTick: 2,
  trailTicks: 2,
  inputFeedbackTicks: 3,
  moveFlashTicks: 2,
  minPickups: 2,
  maxPickups: 3,
  initialPickupCount: 2,
  initialMessage: 'Signal live. Route clean and stay alive.',
  pickupValueMin: 20,
  pickupValueMax: 45,
  pickupTtlMin: 36,
  pickupTtlMax: 60,
  hazardRamp: {
    base: 0,
    growthIntervalTicks: 32,
    max: 12,
    randomSpawnChance: 0.28,
    lowCountPulseEvery: 16,
    lowCountThreshold: 1,
    safeStartTicks: 18,
  },
  pickupRamp: {
    pulseEvery: 18,
  },
  nearMiss: {
    radius: 1,
    score: 12,
    comboBump: 0.1,
    maxPerTick: 3,
  },
  scoreMilestones: [100, 250, 500, 900, 1400],
  sponsorImpressionEveryTicks: 40,

  // ── Hazard behavior variety ──────────────────────────────────────────
  // When a hazard spawns, a deterministic hash decides its movement style.
  // Values in [0, 100) — lower threshold = less common.
  // homing: tracks player (existing default)
  // patrol: moves in a fixed direction, bounces off edges
  hazardBehavior: {
    patrolThreshold: 70,  // >=70 → patrol behavior (30% of spawns)
  },

  // ── Pickup type variety ──────────────────────────────────────────────
  // When a pickup spawns, type is chosen deterministically.
  // credit: existing behavior (score × combo)
  // shield: adds shield charges to the player
  pickupTypes: {
    shieldThreshold: 70,  // >=70 → shield pickup (30% of spawns)
    shieldCharges: 2,     // shield pickups grant this many charges
  },

  // ── Combo decay ──────────────────────────────────────────────────────
  // Combo decreases by this amount per tick when no pickup is collected.
  // Creates urgency to keep collecting.
  comboDecay: 0.05,

  // Mode-specific configurations.
  // The engine reads from `modes[modeName]` when constructing initial state.
  modes: {
    aiHunt: {
      label: 'AI HUNT MODE',
      tagline: 'Pilot the signal node. Dodge the homing noise. Collect credits.',
    },
    frogger: {
      label: 'FROGGER MODE',
      tagline: 'Cross the road. Ride the river. Fill all five home slots.',

      // Number of lives per level. Lose all = game over.
      lives: 3,

      // Per-level countdown in ticks (1 tick == 1 game step at froggerTickMs).
      timePerLevel: 60,

      // Score for landing in an empty home slot.
      slotScore: 100,

      // Bonus per tick remaining when the last slot is filled.
      timeBonusPerTick: 5,

      // Bonus per level cleared.
      levelClearBonus: 200,

      // Small constant reward for pushing upward into a new best row
      // during the current life/slot attempt. Gives players feedback
      // before they reach a home slot without making side/down hops farmable.
      forwardProgressScore: 5,

      // Number of GET READY ticks shown at the start of every level —
      // vehicles don't move and the frog doesn't drown/die during this
      // window so the player has a beat to read the layout.
      getReadyTicks: 30,

      // Per-level speed multiplier applied to every vehicle. Level 1 is
      // intentionally easy; speeds ramp up to 1.0× by level 4.
      //   index 0 = level 1, index 1 = level 2, ...
      // Multipliers < 1 floor a vehicle's effective speed to 1 so
      // nothing stops dead, but caps a level-1 speed-3 car at 2.
      levelSpeedMultipliers: [0.55, 0.8, 1.0, 1.0, 1.0, 1.0],

      // Columns of the five home slots on row 1.
      homeSlotXs: [6, 17, 28, 39, 50],

      // Where the frog respawns on each life (and on slot fill).
      spawnRow: 22,
      spawnX: 28,

      // Lane definitions. Pure data — the engine reads these on each tick.
      // type: 'road' (cars kill), 'river' (must be on a log, water kills),
      //       'median' (always safe), 'home' (top row, slot check)
      // direction: +1 = moves right, -1 = moves left
      // speed: cells per tick
      // vehicles: initial positions
      lanes: [
        // Home row (row 1) - marker only, slot logic lives in state
        { y: 1,  type: 'home' },

        // River lanes (rows 2-9) — must ride a log, water kills
        { y: 2,  type: 'river', direction:  1, speed: 1, vehicles: [{x:  6}, {x: 22}, {x: 38}] },
        { y: 3,  type: 'river', direction: -1, speed: 1, vehicles: [{x: 14}, {x: 30}, {x: 46}] },
        { y: 4,  type: 'river', direction:  1, speed: 1, vehicles: [{x:  8}, {x: 28}, {x: 48}] },
        { y: 5,  type: 'river', direction: -1, speed: 1, vehicles: [{x: 12}, {x: 32}] },
        { y: 6,  type: 'river', direction:  1, speed: 2, vehicles: [{x:  4}, {x: 24}, {x: 44}] },
        { y: 7,  type: 'river', direction: -1, speed: 1, vehicles: [{x: 18}, {x: 38}] },
        { y: 8,  type: 'river', direction:  1, speed: 1, vehicles: [{x: 10}, {x: 30}, {x: 50}] },
        { y: 9,  type: 'river', direction: -1, speed: 2, vehicles: [{x:  6}, {x: 26}, {x: 46}] },

        // Median (row 10) - always safe
        { y: 10, type: 'median' },

        // Road lanes (rows 11-20) - cars kill
        { y: 11, type: 'road', direction:  1, speed: 2, vehicles: [{x:  8}, {x: 28}, {x: 48}] },
        { y: 12, type: 'road', direction: -1, speed: 1, vehicles: [{x: 14}, {x: 34}, {x: 54}] },
        { y: 13, type: 'road', direction:  1, speed: 3, vehicles: [{x:  6}, {x: 26}, {x: 46}] },
        { y: 14, type: 'road', direction: -1, speed: 2, vehicles: [{x: 12}, {x: 32}, {x: 52}] },
        { y: 15, type: 'road', direction:  1, speed: 1, vehicles: [{x: 10}, {x: 30}, {x: 50}] },
        { y: 16, type: 'road', direction: -1, speed: 2, vehicles: [{x: 16}, {x: 36}] },
        { y: 17, type: 'road', direction:  1, speed: 3, vehicles: [{x:  4}, {x: 24}, {x: 44}] },
        { y: 18, type: 'road', direction: -1, speed: 1, vehicles: [{x: 14}, {x: 34}, {x: 54}] },
        { y: 19, type: 'road', direction:  1, speed: 2, vehicles: [{x:  8}, {x: 28}, {x: 48}] },
        { y: 20, type: 'road', direction: -1, speed: 1, vehicles: [{x: 18}, {x: 38}] },

        // Median (row 21) - always safe
        { y: 21, type: 'median' },
      ],
    },
  },
};

module.exports = {
  GAME_CONFIG,
  getTickMsForMode,
};
