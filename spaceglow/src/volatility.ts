import {
  add,
  clonePoint,
  distance,
  easeInOutCubic,
  lerpPoint,
  pointWithinBounds,
  scale,
} from "./geometry.ts";
import { SETTINGS, TAU } from "./settings.ts";

export function createDriftPlan(rng, currentNode, targetNode, width, height, orbitRadius, targetRadius) {
  if (!rng.chance(SETTINGS.volatility.driftChance)) {
    return {
      scheduled: false,
      occurred: false,
      completed: false,
      from: clonePoint(targetNode),
      to: clonePoint(targetNode),
      startOffsetSeconds: null,
      durationSeconds: 0,
    };
  }

  const margin = Math.max(72, orbitRadius + targetRadius + 24);
  let finalTarget = clonePoint(targetNode);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const angle = rng.range(0, TAU);
    const amount = rng.range(SETTINGS.volatility.driftMinDistance, SETTINGS.volatility.driftMaxDistance);
    const candidate = add(targetNode, scale({ x: Math.cos(angle), y: Math.sin(angle) }, amount));
    const reachable = distance(currentNode, candidate) > orbitRadius + targetRadius + 70;
    if (reachable && pointWithinBounds(candidate, width, height, margin)) {
      finalTarget = candidate;
      break;
    }
  }

  return {
    scheduled: true,
    occurred: false,
    completed: false,
    from: clonePoint(targetNode),
    to: finalTarget,
    startOffsetSeconds: rng.range(
      SETTINGS.volatility.driftDelayMinSeconds,
      SETTINGS.volatility.driftDelayMaxSeconds,
    ),
    durationSeconds: rng.range(
      SETTINGS.volatility.driftDurationMinSeconds,
      SETTINGS.volatility.driftDurationMaxSeconds,
    ),
  };
}

export function updateDriftPlan(plan, elapsedSeconds) {
  if (!plan.scheduled || plan.startOffsetSeconds === null) {
    return {
      position: clonePoint(plan.from),
      occurred: plan.occurred,
      stillDrifting: false,
      completed: plan.completed,
      progress: 0,
    };
  }

  if (elapsedSeconds < plan.startOffsetSeconds) {
    return {
      position: clonePoint(plan.from),
      occurred: plan.occurred,
      stillDrifting: false,
      completed: plan.completed,
      progress: 0,
    };
  }

  plan.occurred = true;
  const raw = (elapsedSeconds - plan.startOffsetSeconds) / plan.durationSeconds;
  const progress = Math.min(1, raw);
  if (progress >= 1) plan.completed = true;

  return {
    position: lerpPoint(plan.from, plan.to, easeInOutCubic(progress)),
    occurred: plan.occurred,
    stillDrifting: progress < 1,
    completed: plan.completed,
    progress,
  };
}
