import { SpaceGlowGame } from "./game.ts";

const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d");
const startScreen = document.querySelector("#startScreen");
const practiceScreen = document.querySelector("#practiceScreen");
const endScreen = document.querySelector("#endScreen");
const hud = document.querySelector("#hud");
const debugPanel = document.querySelector("#debugPanel");
const startButton = document.querySelector("#startButton");
const restartButton = document.querySelector("#restartButton");
const downloadButton = document.querySelector("#downloadButton");

const params = new URLSearchParams(window.location.search);
const game = new SpaceGlowGame({
  width: window.innerWidth,
  height: window.innerHeight,
  seed: params.get("seed") ?? String(Date.now()),
  debug: params.get("debug") === "1",
});

let audioContext = null;
let lastTime = performance.now();
let endScreenRendered = false;

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  game.resize(width, height);
}

function ensureAudio() {
  if (audioContext) return audioContext;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  audioContext = new AudioCtor();
  return audioContext;
}

function playTone(kind) {
  const ac = ensureAudio();
  if (!ac) return;
  const now = ac.currentTime;
  const oscillator = ac.createOscillator();
  const gain = ac.createGain();
  const palette = {
    start: [220, 0.04, 0.12],
    launch: [340, 0.025, 0.08],
    hit: [620, 0.035, 0.14],
    miss: [130, 0.03, 0.16],
    rapid: [190, 0.014, 0.05],
    end: [260, 0.04, 0.28],
  };
  const [frequency, volume, duration] = palette[kind] ?? palette.launch;
  oscillator.type = kind === "miss" ? "triangle" : "sine";
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * (kind === "hit" ? 1.5 : 0.85), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(gain).connect(ac.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function handleInput(kind) {
  ensureAudio();
  game.tap(kind);
}

function tick(now) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  game.update(dt);
  for (const event of game.consumeAudioEvents()) playTone(event);
  draw(game.getRenderState());
  syncUi(game.getHudState(), game.getRenderState());
  requestAnimationFrame(tick);
}

function draw(state) {
  const { width, height } = state;
  ctx.clearRect(0, 0, width, height);
  drawBackground(state);

  if (state.mode === "start" || state.mode === "ended") {
    drawAmbientNodes(state);
    return;
  }

  drawOrbit(state);
  drawTarget(state);
  drawTrail(state);
  drawTether(state);
  drawParticle(state);
  drawFeedback(state);
  if (state.debug.enabled) drawDebugGeometry(state);
}

function drawBackground(state) {
  const gradient = ctx.createLinearGradient(0, 0, state.width, state.height);
  gradient.addColorStop(0, "#05070d");
  gradient.addColorStop(0.48, "#07101a");
  gradient.addColorStop(1, "#040609");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, state.width, state.height);

  for (const star of state.stars) {
    const pulse = 0.55 + Math.sin(performance.now() * 0.001 * star.pulse) * 0.25;
    ctx.globalAlpha = star.alpha * pulse;
    ctx.fillStyle = "#eaf8ff";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawAmbientNodes(state) {
  const t = performance.now() * 0.001;
  const center = { x: state.width * 0.5, y: state.height * 0.52 };
  const orbit = Math.min(state.width, state.height) * 0.16;
  const particle = {
    x: center.x + Math.cos(t * 0.55) * orbit,
    y: center.y + Math.sin(t * 0.55) * orbit,
  };
  glowCircle(center.x, center.y, 22, "rgba(115,247,255,0.95)", 36);
  ring(center.x, center.y, orbit, "rgba(115,247,255,0.24)", 1.3);
  glowCircle(particle.x, particle.y, 8, "rgba(151,255,210,0.98)", 22);
}

function drawOrbit(state) {
  ring(
    state.currentNode.x,
    state.currentNode.y,
    state.orbitRadius,
    "rgba(115,247,255,0.28)",
    1.25,
  );
  glowCircle(
    state.currentNode.x,
    state.currentNode.y,
    state.nodeRadius,
    "rgba(115,247,255,0.96)",
    34,
  );
}

function drawTarget(state) {
  if (state.driftActive) {
    ring(
      state.targetOriginalPosition.x,
      state.targetOriginalPosition.y,
      state.targetRadius * 1.1,
      "rgba(255,201,111,0.16)",
      1,
    );
  }

  const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.04;
  glowCircle(
    state.targetNode.x,
    state.targetNode.y,
    state.targetRadius * 0.56 * pulse,
    state.targetStillDrifting ? "rgba(255,201,111,0.98)" : "rgba(151,255,210,0.96)",
    36,
  );
  ring(
    state.targetNode.x,
    state.targetNode.y,
    state.targetRadius,
    state.targetStillDrifting ? "rgba(255,201,111,0.44)" : "rgba(151,255,210,0.34)",
    1.2,
  );
}

function drawTrail(state) {
  if (state.trail.length < 2) return;
  for (let i = 1; i < state.trail.length; i += 1) {
    const a = state.trail[i - 1];
    const b = state.trail[i];
    const alpha = Math.max(0, 0.42 - b.age * 0.42);
    ctx.strokeStyle = `rgba(151,255,210,${alpha})`;
    ctx.lineWidth = Math.max(1, 6 * (1 - i / state.trail.length));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

function drawTether(state) {
  if (state.launchActive) return;
  ctx.strokeStyle = "rgba(115,247,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(state.currentNode.x, state.currentNode.y);
  ctx.lineTo(state.particle.x, state.particle.y);
  ctx.stroke();
}

function drawParticle(state) {
  glowCircle(state.particle.x, state.particle.y, 8.5 * state.width / Math.max(state.width, 900), "rgba(238,247,255,1)", 24);
  glowCircle(state.particle.x, state.particle.y, 4.5, "rgba(255,255,255,1)", 10);
}

function drawFeedback(state) {
  for (const item of state.feedback) {
    const progress = item.age / item.life;
    ctx.globalAlpha = 1 - progress;
    ctx.fillStyle = item.kind === "miss" ? "#ff9ab0" : "#b9ffe1";
    ctx.font = "700 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(item.kind === "miss" ? "MISS" : "CATCH", item.x, item.y - 26 - progress * 18);
    ctx.globalAlpha = 1;
  }
}

function drawDebugGeometry(state) {
  const idealPoint = {
    x: state.currentNode.x + Math.cos(state.debug.idealLaunchAngle) * state.orbitRadius,
    y: state.currentNode.y + Math.sin(state.debug.idealLaunchAngle) * state.orbitRadius,
  };
  ctx.strokeStyle = "rgba(255,201,111,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(idealPoint.x, idealPoint.y);
  ctx.lineTo(state.targetNode.x, state.targetNode.y);
  ctx.stroke();
  glowCircle(idealPoint.x, idealPoint.y, 4, "rgba(255,201,111,0.95)", 12);
}

function glowCircle(x, y, radius, color, blur) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function ring(x, y, radius, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function syncUi(hudState, renderState) {
  const inPlay = hudState.mode === "practice" || hudState.mode === "running";
  hud.hidden = !inPlay;
  startScreen.hidden = hudState.mode !== "start";
  practiceScreen.hidden = hudState.mode !== "practice";
  endScreen.hidden = hudState.mode !== "ended";

  document.querySelector("#hudTime").textContent =
    hudState.mode === "practice" ? "PRACTICE" : formatTime(hudState.sessionRemaining);
  document.querySelector("#hudScore").textContent = String(hudState.score);
  document.querySelector("#hudStreak").textContent = String(hudState.streak);
  document.querySelector("#practiceHits").textContent = String(hudState.practiceHits);

  if (hudState.mode === "ended" && !endScreenRendered) {
    endScreenRendered = true;
    const summary = hudState.summary;
    document.querySelector("#endScore").textContent = `Score: ${hudState.score}`;
    document.querySelector("#endBestStreak").textContent = String(hudState.bestStreak);
    document.querySelector("#endAccuracy").textContent = `${hudState.accuracy}%`;
    document.querySelector("#endStability").textContent =
      summary?.playerFacing?.timingStability ?? "--";
    document.querySelector("#endRecovery").textContent =
      summary?.playerFacing?.rhythmRecovery ?? "--";
  }

  debugPanel.hidden = !renderState.debug.enabled;
  if (renderState.debug.enabled) {
    debugPanel.textContent = [
      `mode: ${renderState.mode}`,
      `phase: ${renderState.phase?.id ?? "--"}`,
      `trial: ${renderState.debug.trialId ?? "--"} (${renderState.debug.trialPhase ?? "--"})`,
      `timing error: ${renderState.debug.timingDifferenceSeconds.toFixed(4)}s`,
      `drift scheduled: ${renderState.debug.driftScheduled}`,
      `target drifting: ${renderState.debug.targetStillDrifting}`,
      `score/streak: ${renderState.score}/${renderState.streak}`,
    ].join("\n");
  }
}

function formatTime(seconds) {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function downloadSessionData() {
  const data = game.getSessionData();
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${data.sessionId}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

window.addEventListener("resize", resize);
canvas.addEventListener("pointerdown", () => handleInput("pointer"));
window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    handleInput("spacebar");
  }
  if (event.key.toLowerCase() === "d") game.toggleDebug();
});

startButton.addEventListener("click", () => {
  endScreenRendered = false;
  ensureAudio();
  game.startPractice();
});
restartButton.addEventListener("click", () => {
  endScreenRendered = false;
  game.restart();
  game.startPractice();
});
downloadButton.addEventListener("click", downloadSessionData);

resize();
requestAnimationFrame(tick);
