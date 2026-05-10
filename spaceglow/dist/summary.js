const PHASE_IDS = ["stable", "drift", "recovery"];

export function computeSummary(telemetry) {
  const phaseSummaries = {};
  for (const phase of PHASE_IDS) {
    phaseSummaries[phase] = summarizePhase(telemetry, phase);
  }

  const comparisons = {
    driftVsStable: comparePhase(phaseSummaries.drift, phaseSummaries.stable),
    recoveryVsStable: comparePhase(phaseSummaries.recovery, phaseSummaries.stable),
  };

  const volatilityPenalty = timingDisruptionIndex(comparisons.driftVsStable);
  const recoveryProfile = computeRecoveryProfile(telemetry, phaseSummaries.stable);

  return {
    phaseSummaries,
    comparisons,
    volatilityPenalty,
    timingDisruptionIndex: volatilityPenalty,
    recoveryProfile,
    playerFacing: {
      timingStability: describeTimingStability(volatilityPenalty),
      rhythmRecovery: describeRecovery(recoveryProfile),
    },
  };
}

function summarizePhase(telemetry, phase) {
  const taps = telemetry.tapEvents.filter((tap) => tap.phase === phase);
  const validTaps = taps.filter((tap) => !tap.extraRapidTap);
  const trials = telemetry.trials.filter((trial) => trial.phase === phase && trial.outcome !== "pending");
  const successes = trials.filter((trial) => trial.outcome === "hit").length;
  const misses = trials.filter((trial) => trial.outcome === "miss").length;
  const timingErrors = validTaps.map((tap) => tap.timingDifferenceSeconds);
  const absTimingErrors = timingErrors.map(Math.abs);
  const rotations = validTaps.map((tap) => tap.rotationsWaited);
  const waitTimes = validTaps.map((tap) => tap.waitTimeBeforeTapSeconds);
  const rapidTapCount = taps.filter((tap) => tap.rapidTap || tap.extraRapidTap).length;

  return {
    validTapCount: validTaps.length,
    successfulCatches: successes,
    misses,
    missRate: rate(misses, successes + misses),
    medianTimingErrorSeconds: median(timingErrors),
    medianAbsoluteTimingErrorSeconds: median(absTimingErrors),
    timingVariabilitySeconds: std(timingErrors),
    averageRotationsWaited: mean(rotations),
    medianRotationsWaited: median(rotations),
    rapidTapCount,
    rapidTapRate: rate(rapidTapCount, taps.length),
    averageTimeAttachedBeforeLaunchSeconds: mean(waitTimes),
  };
}

function comparePhase(phase, baseline) {
  return {
    timingErrorDelta: safeDelta(
      phase.medianAbsoluteTimingErrorSeconds,
      baseline.medianAbsoluteTimingErrorSeconds,
    ),
    rotationsWaitedDelta: safeDelta(phase.averageRotationsWaited, baseline.averageRotationsWaited),
    missRateDelta: safeDelta(phase.missRate, baseline.missRate),
    rapidTapRateDelta: safeDelta(phase.rapidTapRate, baseline.rapidTapRate),
  };
}

function timingDisruptionIndex(comparison) {
  const timing = normalizePenalty(comparison.timingErrorDelta, 0.18);
  const rotations = normalizePenalty(comparison.rotationsWaitedDelta, 0.8);
  const misses = normalizePenalty(comparison.missRateDelta, 0.35);
  const rapid = normalizePenalty(comparison.rapidTapRateDelta, 0.25);
  return round((timing * 0.4 + rotations * 0.25 + misses * 0.25 + rapid * 0.1) * 100);
}

function computeRecoveryProfile(telemetry, baseline) {
  const recoveryTaps = telemetry.tapEvents
    .filter((tap) => tap.phase === "recovery" && !tap.extraRapidTap)
    .sort((a, b) => a.sessionTime - b.sessionTime);

  const timingThreshold = Math.max(0.08, baseline.medianAbsoluteTimingErrorSeconds * 1.35 + 0.035);
  const rotationThreshold = Math.max(1.15, baseline.averageRotationsWaited + 0.45);
  let streak = 0;

  for (let i = 0; i < recoveryTaps.length; i += 1) {
    const tap = recoveryTaps[i];
    const nearTiming = Math.abs(tap.timingDifferenceSeconds) <= timingThreshold;
    const nearRotation = tap.rotationsWaited <= rotationThreshold;
    if (nearTiming && nearRotation) {
      streak += 1;
      if (streak >= 3) {
        const firstRecovered = recoveryTaps[i - 2];
        return {
          recoveredWithinFinalPhase: true,
          tapsToNearBaseline: i - 1,
          secondsToNearBaseline: round(firstRecovered.sessionTime - 80),
          hesitationRemainedElevated: false,
          timingErrorRemainedElevated: false,
          timingThresholdSeconds: round(timingThreshold),
          rotationsThreshold: round(rotationThreshold),
        };
      }
    } else {
      streak = 0;
    }
  }

  const recoverySummary = summarizePhase(telemetry, "recovery");
  return {
    recoveredWithinFinalPhase: false,
    tapsToNearBaseline: null,
    secondsToNearBaseline: null,
    hesitationRemainedElevated:
      recoverySummary.averageRotationsWaited > baseline.averageRotationsWaited + 0.45,
    timingErrorRemainedElevated:
      recoverySummary.medianAbsoluteTimingErrorSeconds >
      baseline.medianAbsoluteTimingErrorSeconds * 1.35 + 0.035,
    timingThresholdSeconds: round(timingThreshold),
    rotationsThreshold: round(rotationThreshold),
  };
}

function describeTimingStability(index) {
  if (index < 18) return "Steady rhythm";
  if (index < 48) return "Moderate drift";
  return "Wide drift";
}

function describeRecovery(profile) {
  if (profile.recoveredWithinFinalPhase) return "Recovered near baseline";
  if (profile.hesitationRemainedElevated || profile.timingErrorRemainedElevated) return "Still settling";
  return "Near baseline";
}

function safeDelta(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return 0;
  return value - baseline;
}

function normalizePenalty(delta, scale) {
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.min(1, delta / scale);
}

function mean(values) {
  const filtered = values.filter(Number.isFinite);
  if (!filtered.length) return 0;
  return round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length);
}

function median(values) {
  const filtered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!filtered.length) return 0;
  const middle = Math.floor(filtered.length / 2);
  if (filtered.length % 2) return round(filtered[middle]);
  return round((filtered[middle - 1] + filtered[middle]) / 2);
}

function std(values) {
  const filtered = values.filter(Number.isFinite);
  if (filtered.length < 2) return 0;
  const avg = filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
  const variance =
    filtered.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (filtered.length - 1);
  return round(Math.sqrt(variance));
}

function rate(count, total) {
  if (!total) return 0;
  return round(count / total);
}

function round(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  return Math.round(value * 10000) / 10000;
}
