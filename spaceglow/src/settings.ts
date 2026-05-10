export const APP_VERSION = "0.1.0-mvp";

export const SETTINGS = {
  practiceMaxSeconds: 20,
  practiceHitsToStart: 3,
  sessionSeconds: 120,
  phaseSeconds: {
    stable: 40,
    drift: 80,
    recovery: 120,
  },
  orbitRadius: 72,
  orbitPeriodSeconds: 1.65,
  projectileSpeed: 520,
  targetRadius: 32,
  hitGraceRadius: 36,
  nodeRadius: 20,
  minTargetDistance: 245,
  maxTargetDistance: 335,
  rapidTapWindowSeconds: 0.35,
  missResetSeconds: 0.72,
  hitSettleSeconds: 0.08,
  volatility: {
    driftChance: 0.58,
    driftDelayMinSeconds: 0.55,
    driftDelayMaxSeconds: 1.55,
    driftDurationMinSeconds: 0.62,
    driftDurationMaxSeconds: 0.95,
    driftMinDistance: 34,
    driftMaxDistance: 76,
  },
  scoring: {
    hit: 1,
    streakBonusEvery: 5,
  },
};

export const TAU = Math.PI * 2;
