# Construct 3 Integration Notes

This repo’s playable MVP runs in the browser with the same TypeScript-style core intended for Construct 3 script files. To wire it into a C3 project, keep Construct responsible for objects, input, HUD text, audio, and export, and keep the behavioral rules in `src/`.

Recommended C3 objects:

```text
CurrentNode
TargetNode
Particle
OrbitRing
TetherLine
ParticleTrail
BackgroundStars
HUD_Timer
HUD_Score
HUD_Streak
DebugText
StartScreen
EndScreen
DownloadButton
RestartButton
```

Minimal event sheet calls:

```text
On layout start:
  spaceGlowInit(runtime)

On start button:
  spaceGlowStartPractice()

Every tick:
  state = spaceGlowTick(runtime)
  apply state.currentNode, state.targetNode, state.particle, state.orbitRadius, HUD values

On tap/click/space:
  spaceGlowInput("tap")

On download button:
  Browser.InvokeDownload(spaceGlowSessionJson(), "space-glow-session.json")

On restart:
  spaceGlowRestart()
```

The bridge in `space-glow-bridge.ts` is intentionally thin. It returns a render state rather than touching C3 instances directly, so the event sheet stays simple and the telemetry behavior remains testable outside Construct.
