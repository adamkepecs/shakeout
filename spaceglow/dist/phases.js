import { SETTINGS } from "./settings.js";

export const PHASES = {
  practice: {
    id: "practice",
    label: "Practice",
    start: null,
    end: null,
  },
  stable: {
    id: "stable",
    label: "Stable rhythm",
    start: 0,
    end: SETTINGS.phaseSeconds.stable,
  },
  drift: {
    id: "drift",
    label: "Drift",
    start: SETTINGS.phaseSeconds.stable,
    end: SETTINGS.phaseSeconds.drift,
  },
  recovery: {
    id: "recovery",
    label: "Return",
    start: SETTINGS.phaseSeconds.drift,
    end: SETTINGS.phaseSeconds.recovery,
  },
};

export function phaseForSessionTime(seconds) {
  if (seconds < SETTINGS.phaseSeconds.stable) return PHASES.stable;
  if (seconds < SETTINGS.phaseSeconds.drift) return PHASES.drift;
  return PHASES.recovery;
}
