import {
  clonePoint,
  distance,
  idealLaunchAngle,
  normalize,
  orbitPoint,
  pointWithinBounds,
  rayCircleIntersectionDistance,
  signedAngleDelta,
  sub,
  tangentDirection,
  vec,
  wrapRadians,
} from "./geometry.ts";
import { phaseForSessionTime, PHASES } from "./phases.ts";
import { SeededRandom } from "./rng.ts";
import { APP_VERSION, SETTINGS, TAU } from "./settings.ts";
import {
  beginTrial,
  createTelemetry,
  finishTrial,
  markDriftEvent,
  recordTap,
} from "./telemetry.ts";
import { computeSummary } from "./summary.ts";
import { createDriftPlan, updateDriftPlan } from "./volatility.ts";

export class SpaceGlowGame {
  constructor(options = {}) {
    const seed = options.seed ?? String(Date.now());
    this.seed = seed;
    this.rng = new SeededRandom(seed);
    this.width = options.width ?? 960;
    this.height = options.height ?? 640;
    this.debug = Boolean(options.debug);
    this.mode = "start";
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.practiceElapsed = 0;
    this.practiceHits = 0;
    this.sessionElapsed = 0;
    this.globalElapsed = 0;
    this.trialCounter = 0;
    this.tapCounter = 0;
    this.currentNode = vec(this.width * 0.42, this.height * 0.52);
    this.targetNode = vec(this.width * 0.68, this.height * 0.45);
    this.targetOriginalPosition = clonePoint(this.targetNode);
    this.particleAngle = this.rng.range(0, TAU);
    this.launch = null;
    this.trial = null;
    this.telemetry = null;
    this.summary = null;
    this.lastTapGlobalTime = null;
    this.trail = [];
    this.feedback = [];
    this.stars = [];
    this.audioEvents = [];
    this.resize(this.width, this.height);
  }

  resize(width, height) {
    this.width = Math.max(320, width);
    this.height = Math.max(420, height);
    this.scale = Math.max(0.72, Math.min(1.18, Math.min(this.width, this.height) / 720));
    this.orbitRadius = SETTINGS.orbitRadius * this.scale;
    this.nodeRadius = SETTINGS.nodeRadius * this.scale;
    this.targetRadius = SETTINGS.targetRadius * this.scale;
    this.hitGraceRadius = SETTINGS.hitGraceRadius * this.scale;
    this.projectileSpeed = SETTINGS.projectileSpeed * this.scale;
    this.angularSpeed = TAU / SETTINGS.orbitPeriodSeconds;
    if (!this.stars.length) this.createStars();
  }

  createStars() {
    this.stars = [];
    const count = Math.round(Math.max(80, Math.min(170, (this.width * this.height) / 6500)));
    for (let i = 0; i < count; i += 1) {
      this.stars.push({
        x: this.rng.range(0, this.width),
        y: this.rng.range(0, this.height),
        radius: this.rng.range(0.35, 1.35),
        alpha: this.rng.range(0.15, 0.8),
        pulse: this.rng.range(0.35, 1.8),
      });
    }
  }

  startPractice() {
    this.mode = "practice";
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.practiceElapsed = 0;
    this.practiceHits = 0;
    this.sessionElapsed = 0;
    this.summary = null;
    this.telemetry = null;
    this.launch = null;
    this.trail = [];
    this.feedback = [];
    this.currentNode = vec(this.width * 0.43, this.height * 0.53);
    this.particleAngle = this.rng.range(0, TAU);
    this.startNewTrial();
  }

  startMeasured() {
    this.mode = "running";
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.sessionElapsed = 0;
    this.launch = null;
    this.trail = [];
    this.feedback = [];
    this.telemetry = createTelemetry({
      sessionId: makeSessionId(this.seed),
      seed: this.seed,
      width: Math.round(this.width),
      height: Math.round(this.height),
      timestamp: new Date().toISOString(),
    });
    this.startNewTrial();
    this.queueAudio("start");
  }

  restart() {
    this.rng = new SeededRandom(this.seed);
    this.mode = "start";
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.practiceElapsed = 0;
    this.practiceHits = 0;
    this.sessionElapsed = 0;
    this.globalElapsed = 0;
    this.trialCounter = 0;
    this.tapCounter = 0;
    this.launch = null;
    this.trial = null;
    this.telemetry = null;
    this.summary = null;
    this.lastTapGlobalTime = null;
    this.trail = [];
    this.feedback = [];
    this.stars = [];
    this.createStars();
  }

  update(dt) {
    const step = Math.max(0, Math.min(dt, 0.05));
    this.globalElapsed += step;
    this.feedback = this.feedback
      .map((item) => ({ ...item, age: item.age + step }))
      .filter((item) => item.age < item.life);

    if (this.mode === "practice") {
      this.practiceElapsed += step;
      if (this.practiceElapsed >= SETTINGS.practiceMaxSeconds) {
        this.startMeasured();
        return;
      }
    }

    if (this.mode === "running") {
      this.sessionElapsed = Math.min(SETTINGS.sessionSeconds, this.sessionElapsed + step);
      if (this.sessionElapsed >= SETTINGS.sessionSeconds) {
        this.endSession();
        return;
      }
    }

    if (this.mode !== "practice" && this.mode !== "running") return;

    if (this.launch) {
      this.updateLaunch(step);
    } else {
      this.particleAngle = wrapRadians(this.particleAngle + this.angularSpeed * step);
      this.updateTargetDrift();
      this.pushTrail(this.currentParticlePosition());
    }
  }

  tap(inputKind = "tap") {
    if (this.mode === "start") {
      this.startPractice();
      return;
    }
    if (this.mode !== "practice" && this.mode !== "running") return;

    const rapid =
      this.lastTapGlobalTime !== null &&
      this.globalElapsed - this.lastTapGlobalTime < SETTINGS.rapidTapWindowSeconds;
    this.lastTapGlobalTime = this.globalElapsed;

    if (this.launch) {
      this.logTap(inputKind, {
        rapid,
        rapidTap: rapid,
        extraRapidTap: true,
        wouldHitTarget: false,
        launchSucceeded: false,
      });
      this.queueAudio("rapid");
      return;
    }

    this.updateTargetDrift();
    const origin = this.currentParticlePosition();
    const direction = tangentDirection(this.particleAngle);
    const hitDistance = rayCircleIntersectionDistance(
      origin,
      direction,
      this.targetNode,
      this.hitGraceRadius,
    );
    const willHit = hitDistance !== null;

    this.logTap(inputKind, {
      rapid,
      rapidTap: rapid,
      extraRapidTap: false,
      wouldHitTarget: willHit,
      launchSucceeded: willHit,
    });

    this.launch = {
      origin,
      direction,
      elapsed: 0,
      duration: willHit
        ? Math.max(0.12, hitDistance / this.projectileSpeed + SETTINGS.hitSettleSeconds)
        : SETTINGS.missResetSeconds,
      hitDistance: hitDistance ?? this.projectileSpeed * SETTINGS.missResetSeconds,
      willHit,
      particlePosition: clonePoint(origin),
      frozenTarget: clonePoint(this.targetNode),
      trialId: this.trial?.id ?? null,
    };
    this.queueAudio("launch");
  }

  logTap(inputKind, overrides) {
    if (this.mode !== "running" || !this.telemetry || !this.trial) return;

    const phase = phaseForSessionTime(this.sessionElapsed);
    const ideal = idealLaunchAngle(this.currentNode, this.targetNode, this.orbitRadius);
    const signedDelta = signedAngleDelta(this.particleAngle, ideal);
    const timingDifference = signedDelta / this.angularSpeed;
    const nextIdeal =
      signedDelta <= 0
        ? -signedDelta / this.angularSpeed
        : (TAU - signedDelta) / this.angularSpeed;
    const waitTime = this.sessionElapsed - this.trial.startTime;
    const direction =
      Math.abs(timingDifference) < 0.035 ? "on-time" : timingDifference < 0 ? "early" : "late";

    recordTap(this.telemetry, {
      id: `tap-${++this.tapCounter}`,
      sessionTime: this.sessionElapsed,
      phase: phase.id,
      trialId: this.trial.id,
      inputKind,
      currentNodePosition: this.currentNode,
      targetNodePosition: this.targetNode,
      particleAngleRadians: this.particleAngle,
      idealLaunchAngleRadians: ideal,
      idealLaunchTimingSeconds: nextIdeal,
      timingDifferenceSeconds: timingDifference,
      timingDirection: direction,
      wouldHitTarget: overrides.wouldHitTarget,
      waitTimeBeforeTapSeconds: waitTime,
      rotationsWaited: waitTime / SETTINGS.orbitPeriodSeconds,
      targetHadDrifted: Boolean(this.trial.driftPlan?.occurred),
      targetStillDrifting: Boolean(this.trial.targetStillDrifting),
      launchSucceeded: overrides.launchSucceeded,
      rapidTap: overrides.rapidTap,
      extraRapidTap: overrides.extraRapidTap,
    });
  }

  updateLaunch(dt) {
    this.launch.elapsed += dt;
    const progress = Math.min(1, this.launch.elapsed / this.launch.duration);
    const maxDistance = this.launch.willHit
      ? this.launch.hitDistance
      : this.projectileSpeed * this.launch.duration;
    this.launch.particlePosition = {
      x: this.launch.origin.x + this.launch.direction.x * maxDistance * progress,
      y: this.launch.origin.y + this.launch.direction.y * maxDistance * progress,
    };
    this.pushTrail(this.launch.particlePosition);

    if (progress < 1) return;

    const trialId = this.launch.trialId;
    if (this.launch.willHit) {
      this.currentNode = clonePoint(this.launch.frozenTarget);
      this.particleAngle = this.angleFromNode(this.launch.particlePosition, this.currentNode);
      this.score += SETTINGS.scoring.hit;
      if ((this.streak + 1) % SETTINGS.scoring.streakBonusEvery === 0) this.score += 1;
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      if (this.mode === "practice") this.practiceHits += 1;
      if (this.mode === "running" && this.telemetry) {
        finishTrial(this.telemetry, trialId, "hit", this.sessionElapsed, this.currentNode);
      }
      this.addFeedback("catch", this.currentNode);
      this.queueAudio("hit");
      this.launch = null;
      if (this.mode === "practice" && this.practiceHits >= SETTINGS.practiceHitsToStart) {
        this.startMeasured();
      } else {
        this.startNewTrial();
      }
      return;
    }

    this.streak = 0;
    if (this.mode === "running" && this.telemetry) {
      finishTrial(this.telemetry, trialId, "miss", this.sessionElapsed, this.targetNode);
    }
    this.addFeedback("miss", this.targetNode);
    this.queueAudio("miss");
    this.launch = null;
    this.startNewTrial();
  }

  startNewTrial() {
    const phase = this.mode === "running" ? phaseForSessionTime(this.sessionElapsed) : PHASES.practice;
    const target = this.generateTarget();
    this.targetNode = clonePoint(target);
    this.targetOriginalPosition = clonePoint(target);
    const volatilityActive = this.mode === "running" && phase.id === "drift";
    const driftPlan = volatilityActive
      ? createDriftPlan(
          this.rng,
          this.currentNode,
          target,
          this.width,
          this.height,
          this.orbitRadius,
          this.targetRadius,
        )
      : null;

    this.trial = {
      id: `trial-${++this.trialCounter}`,
      startTime: this.mode === "running" ? this.sessionElapsed : this.practiceElapsed,
      phase: phase.id,
      currentNode: clonePoint(this.currentNode),
      targetNode: clonePoint(target),
      targetOriginalPosition: clonePoint(target),
      targetFinalPosition: driftPlan?.to ? clonePoint(driftPlan.to) : clonePoint(target),
      volatilityActive,
      driftPlan,
      targetStillDrifting: false,
    };

    if (this.mode === "running" && this.telemetry) beginTrial(this.telemetry, this.trial);
  }

  updateTargetDrift() {
    if (!this.trial?.driftPlan || this.mode !== "running") return;
    if (this.sessionElapsed >= SETTINGS.phaseSeconds.drift) {
      this.trial.targetStillDrifting = false;
      return;
    }
    const elapsed = this.sessionElapsed - this.trial.startTime;
    const driftState = updateDriftPlan(this.trial.driftPlan, elapsed);
    this.targetNode = driftState.position;
    this.trial.targetStillDrifting = driftState.stillDrifting;
    if (driftState.occurred && this.telemetry) {
      markDriftEvent(this.telemetry, this.trial, driftState, this.sessionElapsed);
    }
  }

  generateTarget() {
    const margin = Math.max(78, this.orbitRadius + this.targetRadius + 16);
    const minDistance = Math.min(SETTINGS.minTargetDistance * this.scale, Math.min(this.width, this.height) * 0.35);
    const maxDistance = Math.min(SETTINGS.maxTargetDistance * this.scale, Math.min(this.width, this.height) * 0.48);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      const angle = this.rng.range(0, TAU);
      const d = this.rng.range(minDistance, Math.max(minDistance + 24, maxDistance));
      const candidate = {
        x: this.currentNode.x + Math.cos(angle) * d,
        y: this.currentNode.y + Math.sin(angle) * d,
      };
      if (
        pointWithinBounds(candidate, this.width, this.height, margin) &&
        distance(candidate, this.currentNode) > this.orbitRadius + this.targetRadius + 70
      ) {
        return candidate;
      }
    }

    const fallback = {
      x: this.width * (this.currentNode.x < this.width * 0.5 ? 0.72 : 0.28),
      y: this.height * this.rng.range(0.34, 0.66),
    };
    return fallback;
  }

  currentParticlePosition() {
    if (this.launch) return clonePoint(this.launch.particlePosition);
    return orbitPoint(this.currentNode, this.orbitRadius, this.particleAngle);
  }

  angleFromNode(point, node) {
    const delta = sub(point, node);
    const raw = Math.atan2(delta.y, delta.x);
    if (!Number.isFinite(raw)) return this.particleAngle;
    return wrapRadians(raw);
  }

  pushTrail(point) {
    this.trail.push({ x: point.x, y: point.y, age: 0 });
    this.trail = this.trail
      .map((item) => ({ ...item, age: item.age + 0.016 }))
      .filter((item) => item.age < 0.9)
      .slice(-42);
  }

  addFeedback(kind, point) {
    this.feedback.push({
      kind,
      x: point.x,
      y: point.y,
      age: 0,
      life: kind === "miss" ? 0.55 : 0.42,
    });
  }

  queueAudio(kind) {
    this.audioEvents.push(kind);
  }

  consumeAudioEvents() {
    const events = [...this.audioEvents];
    this.audioEvents.length = 0;
    return events;
  }

  endSession() {
    if (this.mode !== "running") return;
    this.mode = "ended";
    this.sessionElapsed = SETTINGS.sessionSeconds;
    if (this.telemetry) {
      this.summary = computeSummary(this.telemetry);
      this.telemetry.summary = this.summary;
    }
    this.queueAudio("end");
  }

  toggleDebug() {
    this.debug = !this.debug;
  }

  getRenderState() {
    const phase =
      this.mode === "running"
        ? phaseForSessionTime(this.sessionElapsed)
        : this.mode === "practice"
          ? PHASES.practice
          : null;
    const particle = this.currentParticlePosition();
    const ideal = idealLaunchAngle(this.currentNode, this.targetNode, this.orbitRadius);
    const timingDifference = signedAngleDelta(this.particleAngle, ideal) / this.angularSpeed;

    return {
      appVersion: APP_VERSION,
      mode: this.mode,
      width: this.width,
      height: this.height,
      currentNode: clonePoint(this.currentNode),
      targetNode: clonePoint(this.targetNode),
      targetOriginalPosition: clonePoint(this.targetOriginalPosition),
      targetFinalPosition: this.trial?.targetFinalPosition
        ? clonePoint(this.trial.targetFinalPosition)
        : clonePoint(this.targetNode),
      particle,
      particleAngle: this.particleAngle,
      orbitRadius: this.orbitRadius,
      targetRadius: this.targetRadius,
      nodeRadius: this.nodeRadius,
      trail: this.trail.map((item) => ({ x: item.x, y: item.y, age: item.age })),
      stars: this.stars,
      launchActive: Boolean(this.launch),
      driftActive: Boolean(this.trial?.driftPlan?.occurred),
      targetStillDrifting: Boolean(this.trial?.targetStillDrifting),
      phase,
      score: this.score,
      streak: this.streak,
      bestStreak: this.bestStreak,
      practiceHits: this.practiceHits,
      practiceTargetHits: SETTINGS.practiceHitsToStart,
      practiceElapsed: this.practiceElapsed,
      sessionElapsed: this.sessionElapsed,
      sessionRemaining: Math.max(0, SETTINGS.sessionSeconds - this.sessionElapsed),
      feedback: this.feedback,
      debug: {
        enabled: this.debug,
        idealLaunchAngle: ideal,
        timingDifferenceSeconds: timingDifference,
        trialId: this.trial?.id ?? null,
        trialPhase: this.trial?.phase ?? null,
        driftScheduled: Boolean(this.trial?.driftPlan?.scheduled),
        targetStillDrifting: Boolean(this.trial?.targetStillDrifting),
      },
    };
  }

  getHudState() {
    const finishedTrials = this.telemetry
      ? this.telemetry.trials.filter((trial) => trial.outcome === "hit" || trial.outcome === "miss")
      : [];
    const totalAttempts = finishedTrials.length || this.practiceHits;
    const hits = finishedTrials.filter((trial) => trial.outcome === "hit").length || this.practiceHits;
    const accuracy = totalAttempts ? Math.round((hits / totalAttempts) * 100) : 0;
    return {
      mode: this.mode,
      score: this.score,
      streak: this.streak,
      bestStreak: this.bestStreak,
      accuracy,
      sessionRemaining: Math.max(0, SETTINGS.sessionSeconds - this.sessionElapsed),
      practiceHits: this.practiceHits,
      practiceTargetHits: SETTINGS.practiceHitsToStart,
      summary: this.summary,
    };
  }

  getSessionData() {
    if (!this.telemetry) return null;
    return this.telemetry;
  }
}

function makeSessionId(seed) {
  const random = Math.random().toString(36).slice(2, 8);
  return `space-glow-${Date.now().toString(36)}-${String(seed).slice(0, 8)}-${random}`;
}
