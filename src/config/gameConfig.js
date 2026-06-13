const GAME_CONFIG = {
  width: 56,
  height: 28,
  tickMs: 120,
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
  scoreMilestones: [100, 250, 500, 900, 1400],
  sponsorImpressionEveryTicks: 40,
};

module.exports = {
  GAME_CONFIG,
};
