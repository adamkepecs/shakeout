# Shake-Out

Self-contained mobile web prototype for a calibrated progressive-ratio jar-shaking task.

## Run locally

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/`.

## Put it on a public URL

This is a static site. Upload the whole folder as-is, with `index.html` at the site root.

Fastest options:

- Netlify Drop: drag this `shake-out` folder into Netlify Drop. No build command is needed.
- GitHub Pages: push the files to a repository, then set Pages to deploy from the repository root.
- Azure Static Website/Static Web Apps: upload these files the same way the Bird export is hosted.

For the current GitHub repo, the runnable Pages URL should be:

```text
https://adamkepecs.github.io/shakeout/
```

Do not use the `https://github.com/adamkepecs/shakeout` repository page as the play URL; that page only shows source files. The Pages site must include every file and folder from this directory, especially:

```text
index.html
style.css
config.json
appmanifest.json
offline.json
sw.js
icons/icon.svg
scripts/main.js
scripts/project/messaging.js
scripts/modernjscheck.js
scripts/offlineclient.js
scripts/register-sw.js
scripts/supportcheck.js
```

If `https://adamkepecs.github.io/shakeout/scripts/main.js` returns a GitHub Pages 404, the `scripts/` folder did not get uploaded and the game shell will appear but will not run correctly.

Phone motion sensors generally require HTTPS, and iOS requires the motion permission request to happen from a user tap. Public hosts like Netlify, GitHub Pages, Azure Static Web Apps, and Cloudflare Pages provide HTTPS by default.

## Study knobs

Edit `config.json`:

- `schedule.startRatio`, `schedule.growthBase`, `schedule.maxCoins`, and `schedule.explicitRatios`
- `motion.calibrationSamplesRequired`, `motion.calibrationRankIndex`, and threshold multipliers
- `motion.baselineDurationMs` and baseline multipliers for still-phone noise rejection
- `session.idleWarningSeconds`, `session.idleTimeoutSeconds`, and `session.endOnMaxCoins`
- `backend.url` for the once-per-session JSON POST

The default measured schedule is `2, 4, 6, 9, 13, 18, 23` for 7 coins. The demo schedule is `2, 4` and is logged but excluded from primary outcomes.

## Runtime behavior

- iOS motion permission is requested from a user tap.
- Android/browser sensor absence is detected after warmup and reported in-app.
- Calibration first measures upright stillness, then accepts one guided flick at a time with a settle pause.
- Portrait orientation lock is attempted on mobile from a user tap. Browsers may require fullscreen; installed/PWA mode is most reliable.
- React Native WebView communication follows the Bird-style batched `postMessage` events.
- Session payloads are posted once after session end. If no backend is configured, they are stored in `localStorage` under `shakeOutLastPayload` and `shakeOutPendingPayloads`.

Primary breakpoint is `outcomes.finalBreakpoint`, with unfinished progress preserved as `outcomes.unfinishedFlicks` of `outcomes.unfinishedRatio`.
