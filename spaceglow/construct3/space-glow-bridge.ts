import { SpaceGlowGame } from "../src/game.ts";

let game = null;

export function spaceGlowInit(runtime, options = {}) {
  const layout = runtime.layout;
  game = new SpaceGlowGame({
    width: layout.width,
    height: layout.height,
    seed: options.seed ?? String(Date.now()),
    debug: Boolean(options.debug),
  });
  return game.getRenderState();
}

export function spaceGlowStartPractice() {
  game?.startPractice();
}

export function spaceGlowTick(runtime) {
  if (!game) return null;
  game.resize(runtime.layout.width, runtime.layout.height);
  game.update(runtime.dt);
  return game.getRenderState();
}

export function spaceGlowInput(kind = "tap") {
  game?.tap(kind);
  return game?.getRenderState() ?? null;
}

export function spaceGlowRestart() {
  game?.restart();
  game?.startPractice();
}

export function spaceGlowToggleDebug() {
  game?.toggleDebug();
}

export function spaceGlowHudState() {
  return game?.getHudState() ?? null;
}

export function spaceGlowSessionJson() {
  const data = game?.getSessionData();
  return data ? JSON.stringify(data, null, 2) : "";
}

export function spaceGlowConsumeAudioEvents() {
  return game?.consumeAudioEvents() ?? [];
}
