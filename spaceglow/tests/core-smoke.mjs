import assert from "node:assert/strict";
import { SpaceGlowGame } from "../dist/game.js";

const game = new SpaceGlowGame({ width: 900, height: 620, seed: "smoke-test", debug: true });
game.startMeasured();

let guard = 0;
while (game.getHudState().mode !== "ended" && guard < 60 * 130) {
  const state = game.getRenderState();
  if (!state.launchActive && Math.abs(state.debug.timingDifferenceSeconds) < 0.018) {
    game.tap("smoke");
  }
  game.update(1 / 60);
  guard += 1;
}

const data = game.getSessionData();
assert.equal(game.getHudState().mode, "ended");
assert.equal(Math.round(data.trials.at(-1)?.trialStartTime <= 120), 1);
assert.equal(data.summary.phaseSummaries.stable.validTapCount > 0, true);
assert.equal(data.summary.phaseSummaries.drift.validTapCount > 0, true);
assert.equal(data.summary.phaseSummaries.recovery.validTapCount > 0, true);
assert.equal(typeof data.summary.volatilityPenalty, "number");

console.log("core smoke ok", {
  taps: data.tapEvents.length,
  trials: data.trials.length,
  volatilityPenalty: data.summary.volatilityPenalty,
});
