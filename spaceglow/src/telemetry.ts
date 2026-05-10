import { APP_VERSION, SETTINGS } from "./settings.ts";

export function createTelemetry({ sessionId, seed, width, height, timestamp }) {
  return {
    sessionId,
    timestamp,
    appVersion: APP_VERSION,
    screen: { width, height },
    randomSeed: seed,
    settings: SETTINGS,
    trials: [],
    tapEvents: [],
    driftEvents: [],
    summary: null,
  };
}

export function beginTrial(telemetry, trial) {
  telemetry.trials.push({
    id: trial.id,
    trialStartTime: round(trial.startTime),
    phase: trial.phase,
    currentNode: roundPoint(trial.currentNode),
    targetNode: roundPoint(trial.targetNode),
    volatilityActive: trial.volatilityActive,
    targetDriftOccurred: false,
    targetOriginalPosition: roundPoint(trial.targetOriginalPosition),
    targetFinalPosition: roundPoint(trial.targetFinalPosition),
    outcome: "pending",
    trialDuration: null,
  });
}

export function markDriftEvent(telemetry, trial, driftState, sessionTime) {
  const existing = telemetry.driftEvents.find((event) => event.trialId === trial.id);
  if (!existing) {
    telemetry.driftEvents.push({
      trialId: trial.id,
      sessionTime: round(sessionTime),
      phase: trial.phase,
      from: roundPoint(trial.targetOriginalPosition),
      to: roundPoint(trial.targetFinalPosition),
      durationSeconds: round(trial.driftPlan.durationSeconds),
    });
  }

  const row = telemetry.trials.find((item) => item.id === trial.id);
  if (row) {
    row.targetDriftOccurred = true;
    row.targetFinalPosition = roundPoint(trial.targetFinalPosition);
    row.driftProgressAtLastUpdate = round(driftState.progress);
  }
}

export function recordTap(telemetry, event) {
  telemetry.tapEvents.push({
    id: event.id,
    sessionTime: round(event.sessionTime),
    phase: event.phase,
    trialId: event.trialId,
    inputKind: event.inputKind,
    currentNodePosition: roundPoint(event.currentNodePosition),
    targetNodePosition: roundPoint(event.targetNodePosition),
    particleAngleRadians: round(event.particleAngleRadians),
    idealLaunchAngleRadians: round(event.idealLaunchAngleRadians),
    idealLaunchTimingSeconds: round(event.idealLaunchTimingSeconds),
    timingDifferenceSeconds: round(event.timingDifferenceSeconds),
    timingDirection: event.timingDirection,
    wouldHitTarget: event.wouldHitTarget,
    waitTimeBeforeTapSeconds: round(event.waitTimeBeforeTapSeconds),
    rotationsWaited: round(event.rotationsWaited),
    targetHadDrifted: event.targetHadDrifted,
    targetStillDrifting: event.targetStillDrifting,
    launchSucceeded: event.launchSucceeded,
    rapidTap: event.rapidTap,
    extraRapidTap: event.extraRapidTap,
  });
}

export function finishTrial(telemetry, trialId, outcome, sessionTime, targetPosition) {
  const row = telemetry.trials.find((item) => item.id === trialId);
  if (!row) return;
  row.outcome = outcome;
  row.trialDuration = round(sessionTime - row.trialStartTime);
  row.targetFinalPosition = roundPoint(targetPosition);
}

export function round(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  return Math.round(value * 10000) / 10000;
}

export function roundPoint(point) {
  return { x: round(point.x), y: round(point.y) };
}
