import * as Messaging from "./project/messaging.js";

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function uuid() {
	if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getQueryParam(names) {
	const params = new URLSearchParams(location.search);
	for (const name of names) {
		const value = params.get(name);
		if (value) return value;
	}
	return "";
}

function inferOS(userAgent) {
	if (/android/i.test(userAgent)) return "Android";
	if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
	if (/mac os x|macintosh/i.test(userAgent)) return "macOS";
	if (/windows/i.test(userAgent)) return "Windows";
	if (/linux/i.test(userAgent)) return "Linux";
	return "Unknown";
}

function formatRatio(n) {
	if (!Number.isFinite(n)) return "0";
	return String(Math.round(n));
}

function roundedRect(ctx, x, y, w, h, radius) {
	if (ctx.roundRect) {
		ctx.roundRect(x, y, w, h, radius);
		return;
	}
	const r = Math.min(radius, w / 2, h / 2);
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
}

function ellipsePath(ctx, x, y, rx, ry, rotation = 0, startAngle = 0, endAngle = Math.PI * 2) {
	if (ctx.ellipse) {
		ctx.ellipse(x, y, rx, ry, rotation, startAngle, endAngle);
		return;
	}
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate(rotation);
	ctx.scale(rx, ry);
	ctx.arc(0, 0, 1, startAngle, endAngle);
	ctx.restore();
}

function seededRandom(seed) {
	let x = seed >>> 0;
	return function () {
		x += 0x6D2B79F5;
		let t = x;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function buildSchedule(config) {
	const explicit = config.schedule.explicitRatios || [];
	if (explicit.length) return explicit.map(v => Math.max(1, Math.round(Number(v) || 1)));

	const maxCoins = Math.max(1, Math.round(config.schedule.maxCoins || 12));
	const ratios = [Math.max(1, Math.round(config.schedule.startRatio || 1))];
	const base = Math.max(1.01, Number(config.schedule.growthBase || 2));

	for (let i = 1; i < maxCoins; i++) {
		const previous = ratios[i - 1];
		let next = previous * base;
		switch (config.schedule.rounding) {
			case "floor":
				next = Math.floor(next);
				break;
			case "ceil":
				next = Math.ceil(next);
				break;
			default:
				next = Math.round(next);
				break;
		}
		ratios.push(Math.max(previous + 1, next));
	}

	return ratios;
}

class AudioFeedback {
	constructor(config) {
		this.config = config;
		this.context = null;
		this.enabled = !!config.feedback.soundEnabled;
	}

	unlock() {
		if (!this.enabled || this.context) return;
		const AudioContext = window.AudioContext || window.webkitAudioContext;
		if (!AudioContext) return;
		this.context = new AudioContext();
		if (this.context.state === "suspended") this.context.resume().catch(() => {});
	}

	tone(frequency, duration, type = "sine", gainValue = 0.04, when = 0) {
		if (!this.enabled || !this.context) return;
		const ctx = this.context;
		const start = ctx.currentTime + when;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(frequency, start);
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(start);
		osc.stop(start + duration + 0.02);
	}

	valid() {
		this.tone(160, 0.055, "square", 0.025);
		this.tone(470, 0.075, "triangle", 0.025, 0.025);
	}

	coin() {
		this.tone(420, 0.08, "triangle", 0.04);
		this.tone(690, 0.11, "triangle", 0.035, 0.07);
		this.tone(980, 0.13, "sine", 0.025, 0.15);
	}

	idle() {
		this.tone(180, 0.16, "sine", 0.025);
	}
}

class MotionClassifier {
	constructor(config, callbacks) {
		this.config = config.motion;
		this.callbacks = callbacks;
		this.mode = "idle";
		this.threshold = config.motion.minimumThresholdDps;
		this.candidate = null;
		this.cooldownUntil = 0;
		this.lastWeakLogMs = 0;
		this.lastMotionMs = 0;
		this.sensorSeen = false;
		this.lastAccel = null;
	}

	setMode(mode) {
		this.mode = mode;
		this.candidate = null;
		this.cooldownUntil = 0;
	}

	setThreshold(threshold) {
		this.threshold = clamp(threshold, this.config.minimumThresholdDps, this.config.maximumThresholdDps);
	}

	getNeutralThreshold(activeThreshold) {
		return Math.max(this.config.neutralReturnFloorDps, activeThreshold * this.config.neutralReturnRatio);
	}

	processDeviceMotion(event) {
		const now = performance.now();
		const rotation = event.rotationRate || {};
		const alpha = Number(rotation.alpha) || 0;
		const beta = Number(rotation.beta) || 0;
		const gamma = Number(rotation.gamma) || 0;
		const rotationVector = Math.hypot(alpha, beta, gamma);
		let vector = rotationVector;
		let usedFallback = false;
		let accelerationMagnitude = 0;
		let accelerationDelta = 0;
		let jerkVelocity = 0;

		const accel = event.accelerationIncludingGravity || event.acceleration;
		if (accel) {
			const ax = Number(accel.x) || 0;
			const ay = Number(accel.y) || 0;
			const az = Number(accel.z) || 0;
			accelerationMagnitude = Math.hypot(ax, ay, az);
			if (this.lastAccel) {
				accelerationDelta = Math.hypot(ax - this.lastAccel.x, ay - this.lastAccel.y, az - this.lastAccel.z);
				jerkVelocity = accelerationDelta * (this.config.accelerationJerkScaleDps || 44);
				if (jerkVelocity > vector) {
					vector = jerkVelocity;
					usedFallback = true;
				}
			}
			this.lastAccel = { x: ax, y: ay, z: az };
		}

		this.sensorSeen = true;
		this.lastMotionMs = now;
		this.processVector(vector, {
			source: "sensor",
			alpha,
			beta,
			gamma,
			rotationVector,
			combinedAngularVelocity: vector,
			accelerationMagnitude,
			accelerationDelta,
			jerkVelocity,
			usedFallback
		});
	}

	processVector(vector, features) {
		const now = performance.now();
		if (this.mode === "idle") return;
		if (now < this.cooldownUntil) return;

		const activeThreshold = this.mode === "calibration" ? this.config.calibrationLowFloorDps : this.threshold;
		const neutralThreshold = this.getNeutralThreshold(activeThreshold);

		if (!this.candidate) {
			if (vector >= activeThreshold) {
				this.candidate = {
					startMs: now,
					peak: vector,
					peakFeatures: { ...features, combinedAngularVelocity: vector }
				};
				return;
			}

			if (this.mode !== "calibration" && vector >= this.config.weakMovementFloorDps && now - this.lastWeakLogMs >= this.config.invalidLogCooldownMs) {
				this.lastWeakLogMs = now;
				this.callbacks.onInvalid({
					reason: "below_threshold",
					amplitude: vector,
					angularVelocity: vector,
					durationMs: 0,
					features
				});
			}
			return;
		}

		this.candidate.peak = Math.max(this.candidate.peak, vector);
		if (vector >= this.candidate.peak) {
			this.candidate.peakFeatures = { ...features, combinedAngularVelocity: vector };
		}

		const durationMs = now - this.candidate.startMs;
		const relaxedReturnThreshold = Math.max(neutralThreshold, this.candidate.peak * (this.config.relaxedReturnDropRatio || 0.84));
		const returnedToNeutral = durationMs >= this.config.minimumGestureMs && vector <= neutralThreshold;
		const relaxedReturn = durationMs >= (this.config.relaxedReturnAfterMs || 145) && vector <= relaxedReturnThreshold;
		if (returnedToNeutral || relaxedReturn) {
			const result = {
				reason: returnedToNeutral ? "valid_returned_to_neutral" : "valid_relaxed_return",
				amplitude: this.candidate.peak,
				angularVelocity: this.candidate.peak,
				durationMs,
				threshold: activeThreshold,
				neutralThreshold,
				features: this.candidate.peakFeatures
			};
			this.candidate = null;
			this.cooldownUntil = now + this.config.debounceMs;
			if (this.mode === "calibration") this.callbacks.onCalibrationSample(result);
			else this.callbacks.onValid(result);
			return;
		}

		if (durationMs > this.config.maximumGestureMs) {
			const result = {
				reason: "no_return_to_neutral",
				amplitude: this.candidate.peak,
				angularVelocity: this.candidate.peak,
				durationMs,
				threshold: activeThreshold,
				neutralThreshold,
				features: this.candidate.peakFeatures
			};
			this.candidate = null;
			this.cooldownUntil = now + this.config.debounceMs;
			this.callbacks.onInvalid(result);
		}
	}

	simulateFlick(multiplier = 1.2) {
		const threshold = this.mode === "calibration" ? this.config.calibrationLowFloorDps : this.threshold;
		const peak = Math.max(threshold * multiplier, threshold + 18);
		const result = {
			amplitude: peak,
			angularVelocity: peak,
			durationMs: 140,
			threshold,
			neutralThreshold: this.getNeutralThreshold(threshold),
			features: {
				source: "simulated",
				alpha: peak,
				beta: peak * 0.45,
				gamma: peak * 0.25,
				rotationVector: peak,
				combinedAngularVelocity: peak,
				accelerationMagnitude: 0,
				accelerationDelta: 0,
				jerkVelocity: 0,
				usedFallback: false
			}
		};

		if (this.mode === "calibration") this.callbacks.onCalibrationSample(result);
		else if (this.mode !== "idle") this.callbacks.onValid(result);
	}
}

class ShakeOutApp {
	constructor(config) {
		this.config = config;
		this.canvas = $("gameCanvas");
		this.ctx = this.canvas.getContext("2d");
		this.panel = $("panel");
		this.kicker = $("stateKicker");
		this.title = $("stateTitle");
		this.body = $("stateBody");
		this.meter = $("meter").querySelector("span");
		this.sampleDots = $("sampleDots");
		this.primaryButton = $("primaryButton");
		this.secondaryButton = $("secondaryButton");
		this.simulateButton = $("simulateButton");
		this.quitButton = $("quitButton");
		this.statusLine = $("statusLine");
		this.coinHud = $("coinHud");
		this.ratioHud = $("ratioHud");
		this.progressHud = $("progressHud");

		this.audio = new AudioFeedback(config);
		this.classifier = new MotionClassifier(config, {
			onCalibrationSample: result => this.onCalibrationSample(result),
			onValid: result => this.onValidFlick(result),
			onInvalid: result => this.onInvalidMovement(result)
		});

		this.participantId = getQueryParam(config.participantIdParamNames) || localStorage.getItem("shakeOutParticipantId") || `local-${uuid()}`;
		localStorage.setItem("shakeOutParticipantId", this.participantId);

		this.sessionId = uuid();
		this.appStartedAt = Date.now();
		this.screen = "calibration_intro";
		this.phase = "calibration";
		this.sensorMode = "unknown";
		this.orientationLockStatus = "not_requested";
		this.enteredFullscreenForOrientation = false;
		this.motionListener = event => this.classifier.processDeviceMotion(event);
		this.visibilityListener = () => this.onVisibilityChange();
		this.idleInterval = null;
		this.lastFrameMs = performance.now();

		this.calibrationSamples = [];
		this.calibration = null;
		this.events = [];
		this.schedule = buildSchedule(config);
		this.tutorialRatios = config.tutorial.ratios.slice();
		this.activeRatios = this.tutorialRatios;
		this.isMeasured = false;
		this.currentCoinIndex = 0;
		this.currentRatio = 1;
		this.validInRatio = 0;
		this.totalValidFlicks = 0;
		this.completedRatios = [];
		this.sessionStartMs = 0;
		this.sessionEndMs = 0;
		this.lastValidFlickMs = 0;
		this.previousValidFlickMs = 0;
		this.idleWarned = false;
		this.ended = false;
		this.postStatus = "not_sent";
		this.coinDropping = null;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.jarImpulse = 0;
		this.jarAngle = 0;
		this.particles = [];
		this.rocks = [];
		this.animationTick = 0;

		this.setupDots();
		this.bindEvents();
		this.resize();
		this.resetCoin(0, this.tutorialRatios[0]);
		this.updatePanelForCalibrationIntro();
		this.updateHud();
		this.logEvent("app_loaded", { participantId: this.participantId });
		requestAnimationFrame(ms => this.frame(ms));
	}

	setupDots() {
		this.sampleDots.innerHTML = "";
		for (let i = 0; i < this.config.motion.calibrationSamplesRequired; i++) {
			const dot = document.createElement("i");
			this.sampleDots.appendChild(dot);
		}
	}

	bindEvents() {
		window.addEventListener("resize", () => this.resize());
		document.addEventListener("visibilitychange", this.visibilityListener);
		this.primaryButton.addEventListener("click", () => this.onPrimary());
		this.secondaryButton.addEventListener("click", () => this.useDemoInput());
		this.simulateButton.addEventListener("click", () => this.classifier.simulateFlick());
		this.quitButton.addEventListener("click", () => this.endSession("active_quit"));
		this.canvas.addEventListener("pointerdown", () => {
			if (this.config.debug.allowKeyboardFlicks && this.sensorMode === "demo") this.classifier.simulateFlick();
		});
		window.addEventListener("keydown", event => {
			if (!this.config.debug.allowKeyboardFlicks) return;
			if (event.code === "Space") {
				event.preventDefault();
				this.classifier.simulateFlick();
			}
		});
	}

	resize() {
		const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
		const width = Math.max(1, this.canvas.clientWidth);
		const height = Math.max(1, this.canvas.clientHeight);
		this.width = width;
		this.height = height;
		this.canvas.width = Math.round(width * dpr);
		this.canvas.height = Math.round(height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	async tryLockPortraitOrientation(trigger) {
		const cfg = this.config.orientation || {};
		if (!cfg.lockPortrait || this.orientationLockStatus === "locked") return;
		const orientation = screen.orientation;
		if (!orientation || typeof orientation.lock !== "function") {
			this.orientationLockStatus = "unsupported";
			this.logEvent("orientation_lock", { trigger, status: "unsupported" });
			return;
		}

		let fullscreenStatus = "not_requested";
		try {
			if (cfg.requestFullscreenForLock && document.documentElement.requestFullscreen && !document.fullscreenElement) {
				await document.documentElement.requestFullscreen({ navigationUI: "hide" });
				this.enteredFullscreenForOrientation = true;
				fullscreenStatus = "entered";
			}
		}
		catch (err) {
			fullscreenStatus = "failed";
			this.logEvent("orientation_fullscreen", {
				trigger,
				status: fullscreenStatus,
				error: String(err && err.message ? err.message : err)
			});
		}

		try {
			await orientation.lock("portrait");
			this.orientationLockStatus = "locked";
			this.logEvent("orientation_lock", {
				trigger,
				status: "locked",
				fullscreenStatus,
				type: orientation.type || ""
			});
		}
		catch (err) {
			this.orientationLockStatus = "failed";
			this.logEvent("orientation_lock", {
				trigger,
				status: "failed",
				fullscreenStatus,
				error: String(err && err.message ? err.message : err)
			});
		}
	}

	unlockPortraitOrientation(reason) {
		if (screen.orientation && typeof screen.orientation.unlock === "function" && this.orientationLockStatus === "locked") {
			try {
				screen.orientation.unlock();
				this.logEvent("orientation_unlock", { reason, status: "unlocked" });
			}
			catch (err) {
				this.logEvent("orientation_unlock", {
					reason,
					status: "failed",
					error: String(err && err.message ? err.message : err)
				});
			}
		}
		this.orientationLockStatus = "not_requested";
		if (this.enteredFullscreenForOrientation && document.fullscreenElement && document.exitFullscreen) {
			document.exitFullscreen().catch(err => this.logEvent("orientation_fullscreen_exit", {
				reason,
				status: "failed",
				error: String(err && err.message ? err.message : err)
			}));
			this.enteredFullscreenForOrientation = false;
		}
	}

	onPrimary() {
		this.audio.unlock();
		switch (this.screen) {
			case "calibration_intro":
				this.requestMotionAndCalibrate();
				break;
			case "tutorial_ready":
				this.tryLockPortraitOrientation("tutorial_start");
				this.startTutorial();
				break;
			case "session_ready":
				this.tryLockPortraitOrientation("session_start");
				this.startMeasuredSession();
				break;
			case "ended":
				this.restartFromCalibration();
				break;
		}
	}

	async requestMotionAndCalibrate() {
		this.primaryButton.disabled = true;
		this.statusLine.textContent = "Checking motion sensor...";
		let permission = "granted";
		try {
			if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
				permission = await DeviceMotionEvent.requestPermission();
			}
		}
		catch (err) {
			permission = "denied";
		}

		if (permission !== "granted") {
			this.primaryButton.disabled = false;
			this.statusLine.textContent = "Motion permission was not granted.";
			this.secondaryButton.classList.remove("hidden");
			this.logEvent("motion_permission_denied", { permission });
			return;
		}

		await this.tryLockPortraitOrientation("calibration_start");
		this.sensorMode = "sensor";
		window.addEventListener("devicemotion", this.motionListener, { passive: true });
		this.logEvent("motion_permission_granted", { permission });
		this.startCalibrationCollection();

		setTimeout(() => {
			if (this.screen === "calibration_collect" && !this.classifier.sensorSeen) {
				this.statusLine.textContent = "No motion events detected yet. On Android, check browser sensor permissions.";
				this.secondaryButton.classList.remove("hidden");
				this.logEvent("sensor_not_detected", { waitMs: this.config.motion.sensorWarmupMs });
			}
		}, this.config.motion.sensorWarmupMs);
	}

	useDemoInput() {
		this.audio.unlock();
		this.tryLockPortraitOrientation("demo_input");
		this.sensorMode = "demo";
		this.secondaryButton.classList.add("hidden");
		this.simulateButton.classList.remove("hidden");
		if (this.screen === "calibration_intro") this.startCalibrationCollection();
		this.statusLine.textContent = "Demo input is active for local testing.";
		this.logEvent("demo_input_enabled", {});
	}

	startCalibrationCollection() {
		this.screen = "calibration_collect";
		this.phase = "calibration";
		this.classifier.setMode("calibration");
		this.primaryButton.classList.add("hidden");
		this.sampleDots.classList.remove("hidden");
		if (this.config.debug.showSimulateButton || this.sensorMode === "demo") this.simulateButton.classList.remove("hidden");
		this.kicker.textContent = "Calibration";
		this.title.textContent = "Set your flick";
		this.body.textContent = "Hold the phone upright. Use eight small, comfortable wrist snaps; each accepted sample gives a short buzz.";
		this.statusLine.textContent = "Collecting sample 1 of 8.";
		this.updateCalibrationDots();
	}

	onCalibrationSample(result) {
		if (this.screen !== "calibration_collect") return;
		this.calibrationSamples.push(result);
		this.feedbackValid();
		this.addParticles(8, "#e3a72f");
		this.logEvent("calibration_sample", {
			sampleIndex: this.calibrationSamples.length,
			amplitude: result.amplitude,
			angularVelocity: result.angularVelocity,
			gestureDurationMs: result.durationMs,
			source: result.features.source,
			rotationVector: result.features.rotationVector,
			accelerationDelta: result.features.accelerationDelta,
			jerkVelocity: result.features.jerkVelocity,
			usedFallback: result.features.usedFallback,
			classificationReason: result.reason || "calibration_sample"
		});

		this.updateCalibrationDots();
		const required = this.config.motion.calibrationSamplesRequired;
		if (this.calibrationSamples.length >= required) {
			this.finishCalibration();
		}
		else {
			this.statusLine.textContent = `Collecting sample ${this.calibrationSamples.length + 1} of ${required}.`;
		}
	}

	updateCalibrationDots() {
		const dots = Array.from(this.sampleDots.children);
		dots.forEach((dot, index) => dot.classList.toggle("on", index < this.calibrationSamples.length));
		this.meter.style.width = `${(this.calibrationSamples.length / this.config.motion.calibrationSamplesRequired) * 100}%`;
	}

	finishCalibration() {
		const cfg = this.config.motion;
		const peaks = this.calibrationSamples.map(s => s.angularVelocity).sort((a, b) => a - b);
		const rank = clamp(cfg.calibrationRankIndex, 0, peaks.length - 1);
		const rankedPeak = peaks[rank];
		const threshold = clamp(rankedPeak * cfg.calibrationThresholdMultiplier, cfg.minimumThresholdDps, cfg.maximumThresholdDps);
		this.calibration = {
			version: this.config.calibrationVersion,
			completedAt: new Date().toISOString(),
			sampleCount: this.calibrationSamples.length,
			samplePeaksDps: this.calibrationSamples.map(s => Math.round(s.angularVelocity * 100) / 100),
			rankIndex: rank,
			rankedPeakDps: Math.round(rankedPeak * 100) / 100,
			thresholdDps: Math.round(threshold * 100) / 100,
			neutralReturnDps: Math.round(this.classifier.getNeutralThreshold(threshold) * 100) / 100,
			sensorMode: this.sensorMode
		};
		this.classifier.setThreshold(threshold);
		this.classifier.setMode("idle");
		this.logEvent("calibration_complete", this.calibration);
		Messaging.pushEvent("calibration", this.calibration);

		this.screen = "tutorial_ready";
		this.phase = "tutorial";
		this.sampleDots.classList.add("hidden");
		this.primaryButton.disabled = false;
		this.primaryButton.textContent = "Start demo";
		this.primaryButton.classList.remove("hidden");
		this.simulateButton.classList.toggle("hidden", !(this.config.debug.showSimulateButton || this.sensorMode === "demo"));
		this.kicker.textContent = "Demo";
		this.title.textContent = "Try three coins";
		this.body.textContent = "The demo uses ratios 1, 2, and 4. Stronger flicks still count once.";
		this.statusLine.textContent = `Threshold set at ${this.calibration.thresholdDps} deg/s.`;
		this.meter.style.width = "0%";
	}

	startTutorial() {
		this.screen = "playing";
		this.phase = "tutorial";
		this.isMeasured = false;
		this.activeRatios = this.tutorialRatios;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.classifier.setMode("game");
		this.panel.classList.add("compact");
		this.sampleDots.classList.add("hidden");
		this.kicker.textContent = "Demo";
		this.title.textContent = "Practice jar";
		this.body.textContent = "Clear the rocks and drop the coin.";
		this.primaryButton.classList.add("hidden");
		this.secondaryButton.classList.add("hidden");
		this.resetCoin(0, this.activeRatios[0]);
		this.logEvent("tutorial_start", { ratios: this.tutorialRatios });
		this.updateHud();
	}

	startMeasuredSession() {
		this.screen = "playing";
		this.phase = "session";
		this.isMeasured = true;
		this.ended = false;
		this.activeRatios = this.schedule;
		this.currentCoinIndex = 0;
		this.totalValidFlicks = 0;
		this.completedRatios = [];
		this.collectedCoins = [];
		this.countAnimation = null;
		this.sessionStartMs = performance.now();
		this.sessionWallClockStart = Date.now();
		this.lastValidFlickMs = this.sessionStartMs;
		this.previousValidFlickMs = 0;
		this.idleWarned = false;
		this.postStatus = "not_sent";
		this.classifier.setMode("game");
		this.panel.classList.add("compact");
		this.sampleDots.classList.add("hidden");
		this.quitButton.classList.remove("hidden");
		this.kicker.textContent = "Measured session";
		this.title.textContent = "Keep shaking";
		this.body.textContent = "Each accepted flick counts once. Stronger shakes do not add extra counts.";
		this.primaryButton.classList.add("hidden");
		this.secondaryButton.classList.add("hidden");
		this.resetCoin(0, this.activeRatios[0]);
		this.logEvent("session_start", { schedule: this.schedule });
		Messaging.pushEvent("gameState", "start");
		this.startIdleTimer();
		this.updateHud();
	}

	restartFromCalibration() {
		this.sessionId = uuid();
		this.events = [];
		this.calibrationSamples = [];
		this.calibration = null;
		this.completedRatios = [];
		this.totalValidFlicks = 0;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.ended = false;
		this.quitButton.classList.add("hidden");
		this.simulateButton.classList.toggle("hidden", !(this.config.debug.showSimulateButton || this.sensorMode === "demo"));
		this.setupDots();
		this.resetCoin(0, this.tutorialRatios[0]);
		this.updatePanelForCalibrationIntro();
		this.logEvent("app_restarted", {});
	}

	updatePanelForCalibrationIntro() {
		this.screen = "calibration_intro";
		this.phase = "calibration";
		this.classifier.setMode("idle");
		this.panel.classList.remove("compact", "hidden");
		this.kicker.textContent = "Calibration";
		this.title.textContent = "Shake the jar";
		this.body.textContent = "Hold the phone upright and make small wrist flicks like the cue. We will set your flick threshold from eight comfortable samples.";
		this.primaryButton.textContent = "Allow motion";
		this.primaryButton.disabled = false;
		this.primaryButton.classList.remove("hidden");
		this.secondaryButton.textContent = "Use demo input";
		this.secondaryButton.classList.add("hidden");
		this.simulateButton.classList.toggle("hidden", !this.config.debug.showSimulateButton);
		this.sampleDots.classList.remove("hidden");
		this.statusLine.textContent = "Sensor permission is requested only after you tap.";
		this.meter.style.width = "0%";
		this.updateCalibrationDots();
		this.updateHud();
	}

	resetCoin(index, ratio) {
		this.currentCoinIndex = index;
		this.currentRatio = ratio;
		this.validInRatio = 0;
		this.coinDropping = null;
		this.rocks = this.makeRocks(index, ratio);
		this.addParticles(10, "#ccebe5");
		this.updateHud();
	}

	makeRocks(index, ratio) {
		const count = clamp(10 + Math.ceil(Math.log2(ratio + 1)) * 3 + Math.floor(index / 2), 12, 36);
		const rand = seededRandom((index + 1) * 1009 + ratio * 9176);
		const colors = ["#50a66f", "#f05d53", "#37a7d7", "#ffbc42", "#9b6fe8", "#ff7aa7", "#7ac943"];
		const rocks = [];
		for (let i = 0; i < count; i++) {
			const band = i / Math.max(1, count - 1);
			rocks.push({
				x: 0.24 + rand() * 0.52,
				y: 0.48 + band * 0.27 + (rand() - 0.5) * 0.13,
				r: 0.035 + rand() * 0.028,
				angle: rand() * Math.PI,
				color: colors[Math.floor(rand() * colors.length)],
				shape: Math.floor(rand() * 4),
				stripe: rand() > 0.42,
				wobble: rand() * 100
			});
		}
		return rocks;
	}

	onValidFlick(result) {
		if (this.screen !== "playing" || this.coinDropping || this.ended) return;
		const now = performance.now();
		const interFlickIntervalMs = this.previousValidFlickMs ? now - this.previousValidFlickMs : null;
		this.previousValidFlickMs = now;
		this.lastValidFlickMs = now;
		this.idleWarned = false;
		this.validInRatio += 1;
		if (this.isMeasured) this.totalValidFlicks += 1;

		const progress = clamp(this.validInRatio / this.currentRatio, 0, 1);
		this.feedbackValid();
		this.addParticles(12, "#e3a72f");
		this.logEvent("valid_flick", {
			currentCoin: this.currentCoinIndex + 1,
			currentRatio: this.currentRatio,
			validFlickCountWithinCurrentRatio: this.validInRatio,
			totalValidFlickCount: this.totalValidFlicks,
			progressTowardCurrentCoin: progress,
			interFlickIntervalMs,
			movementAmplitude: result.amplitude,
			angularVelocity: result.angularVelocity,
			gestureDurationMs: result.durationMs,
			classificationReason: result.reason || "valid_returned_to_neutral",
			source: result.features.source,
			rotationVector: result.features.rotationVector,
			accelerationDelta: result.features.accelerationDelta,
			jerkVelocity: result.features.jerkVelocity,
			usedFallback: result.features.usedFallback
		});

		if (this.validInRatio >= this.currentRatio) this.dropCoin(result);
		this.updateHud();
	}

	onInvalidMovement(result) {
		if (this.ended) return;
		if (!["calibration", "tutorial", "session"].includes(this.phase)) return;
		this.jarImpulse = Math.max(this.jarImpulse, 0.25);
		this.logEvent("invalid_movement", {
			currentCoin: this.currentCoinIndex + 1,
			currentRatio: this.currentRatio,
			validFlickCountWithinCurrentRatio: this.validInRatio,
			totalValidFlickCount: this.totalValidFlicks,
			progressTowardCurrentCoin: this.currentRatio ? this.validInRatio / this.currentRatio : 0,
			movementAmplitude: result.amplitude,
			angularVelocity: result.angularVelocity,
			gestureDurationMs: result.durationMs,
			classificationReason: result.reason || "invalid",
			source: result.features ? result.features.source : "sensor",
			rotationVector: result.features ? result.features.rotationVector : null,
			accelerationDelta: result.features ? result.features.accelerationDelta : null,
			jerkVelocity: result.features ? result.features.jerkVelocity : null,
			usedFallback: result.features ? result.features.usedFallback : null
		});
	}

	dropCoin(result) {
		const now = performance.now();
		if (this.isMeasured) this.completedRatios.push(this.currentRatio);
		const from = this.getMouthPoint(now);
		const to = this.getPileTarget(this.collectedCoins.length);
		this.coinDropping = {
			startMs: now,
			durationMs: 900,
			ratio: this.currentRatio,
			coinIndex: this.currentCoinIndex,
			from,
			to,
			spin: (Math.random() > 0.5 ? 1 : -1) * (2.5 + Math.random() * 1.8)
		};
		this.feedbackCoin();
		this.addParticles(34, "#e3a72f");
		this.logEvent("coin_drop", {
			currentCoin: this.currentCoinIndex + 1,
			completedRatio: this.currentRatio,
			totalValidFlickCount: this.totalValidFlicks,
			movementAmplitude: result.amplitude,
			angularVelocity: result.angularVelocity
		});
		this.updateHud();
	}

	advanceAfterCoinDrop() {
		if (this.coinDropping) {
			this.collectedCoins.push({
				...this.coinDropping.to,
				rotation: this.coinDropping.spin,
				coinIndex: this.coinDropping.coinIndex
			});
		}
		this.coinDropping = null;
		const nextIndex = this.currentCoinIndex + 1;
		if (!this.isMeasured && nextIndex >= this.activeRatios.length) {
			this.finishTutorial();
			return;
		}
		if (this.isMeasured && this.config.session.endOnMaxCoins && nextIndex >= this.activeRatios.length) {
			this.endSession("completed_max_coins");
			return;
		}
		this.resetCoin(nextIndex, this.activeRatios[nextIndex]);
		this.title.textContent = this.isMeasured ? "Keep shaking" : "Practice jar";
		this.body.textContent = "A new coin is wedged behind the pieces.";
		this.logEvent("coin_ready", {
			currentCoin: this.currentCoinIndex + 1,
			currentRatio: this.currentRatio
		});
	}

	finishTutorial() {
		this.screen = "session_ready";
		this.phase = "ready";
		this.classifier.setMode("idle");
		this.panel.classList.remove("compact", "hidden");
		this.kicker.textContent = "Measured session";
		this.title.textContent = "Ready";
		this.body.textContent = "The measured run starts easy. Each next coin takes more valid flicks.";
		this.primaryButton.textContent = "Start session";
		this.primaryButton.classList.remove("hidden");
		this.statusLine.textContent = `Schedule: ${this.schedule.join(", ")}.`;
		this.meter.style.width = "0%";
		this.logEvent("tutorial_complete", { ratios: this.tutorialRatios });
	}

	startIdleTimer() {
		clearInterval(this.idleInterval);
		this.idleInterval = setInterval(() => this.checkIdleAndSensor(), 1000);
	}

	checkIdleAndSensor() {
		if (!this.isMeasured || this.ended || this.screen !== "playing") return;
		const now = performance.now();
		const idleSeconds = (now - this.lastValidFlickMs) / 1000;
		if (!this.idleWarned && idleSeconds >= this.config.session.idleWarningSeconds) {
			this.idleWarned = true;
			this.feedbackIdle();
			this.statusLine.textContent = "The jar is settling.";
			this.logEvent("idle_warning", { idleSeconds });
		}
		if (idleSeconds >= this.config.session.idleTimeoutSeconds) {
			this.endSession("idle_timeout");
			return;
		}

		if (this.sensorMode === "sensor" && this.classifier.sensorSeen && now - this.classifier.lastMotionMs > this.config.motion.sensorLossMs) {
			this.endSession("sensor_failure");
		}
	}

	onVisibilityChange() {
		if (document.hidden && this.isMeasured && !this.ended) {
			this.endSession("app_backgrounded");
		}
	}

	endSession(reason) {
		if (!this.isMeasured || this.ended) return;
		const unfinished = this.getUnfinishedProgressForEnd();
		if (this.coinDropping) {
			this.collectedCoins.push({
				...this.coinDropping.to,
				rotation: this.coinDropping.spin,
				coinIndex: this.coinDropping.coinIndex
			});
			this.coinDropping = null;
		}
		this.ended = true;
		this.screen = "ended";
		this.phase = "ended";
		this.sessionEndMs = performance.now();
		this.countAnimation = {
			startMs: this.sessionEndMs,
			durationMs: 1250,
			coins: this.completedRatios.length,
			finalBreakpoint: this.completedRatios.length ? this.completedRatios[this.completedRatios.length - 1] : 0,
			unfinishedRatio: unfinished.ratio,
			unfinishedFlicks: unfinished.flicks
		};
		clearInterval(this.idleInterval);
		this.classifier.setMode("idle");
		this.unlockPortraitOrientation(reason);
		this.quitButton.classList.add("hidden");
		const payload = this.buildSessionPayload(reason, unfinished);
		this.logEvent("session_end", {
			endReason: reason,
			finalBreakpoint: payload.outcomes.finalBreakpoint,
			unfinishedRatio: payload.outcomes.unfinishedRatio,
			unfinishedProgress: payload.outcomes.unfinishedProgress
		});
		payload.events = this.events.slice();
		this.panel.classList.remove("compact", "hidden");
		this.kicker.textContent = "Complete";
		this.title.textContent = "Counting coins";
		this.body.textContent = "Your collected coins are being counted.";
		this.primaryButton.textContent = "New calibration";
		this.primaryButton.classList.remove("hidden");
		this.statusLine.textContent = `End reason: ${reason}. Payload status: preparing.`;
		this.meter.style.width = "0%";
		this.updateHud();
		Messaging.pushEvent("gameState", "end");
		Messaging.pushEvent("sessionPayload", payload);
		this.postSessionPayload(payload);
	}

	getUnfinishedProgressForEnd() {
		if (this.coinDropping && this.validInRatio >= this.currentRatio) {
			const nextIndex = this.currentCoinIndex + 1;
			return {
				ratio: this.activeRatios[nextIndex] || 0,
				flicks: 0
			};
		}
		return {
			ratio: this.currentRatio || 0,
			flicks: this.validInRatio || 0
		};
	}

	buildSessionPayload(reason, unfinishedOverride = null) {
		const completedCoins = this.completedRatios.length;
		const finalBreakpoint = completedCoins ? this.completedRatios[completedCoins - 1] : 0;
		const unfinishedRatio = unfinishedOverride ? unfinishedOverride.ratio : this.currentRatio || 0;
		const unfinishedFlicks = unfinishedOverride ? unfinishedOverride.flicks : this.validInRatio || 0;
		const durationMs = Math.max(0, this.sessionEndMs - this.sessionStartMs);
		return {
			format: "shake-out-session-v1",
			app: "Shake-Out",
			appVersion: this.config.appVersion,
			participantId: this.participantId,
			sessionId: this.sessionId,
			createdAt: new Date().toISOString(),
			device: {
				userAgent: navigator.userAgent,
				platform: navigator.platform || "",
				os: inferOS(navigator.userAgent),
				language: navigator.language || "",
				devicePixelRatio: window.devicePixelRatio || 1,
				screenWidth: window.screen ? window.screen.width : null,
				screenHeight: window.screen ? window.screen.height : null
			},
			calibration: this.calibration,
			ratioSchedule: {
				parameters: this.config.schedule,
				ratios: this.schedule
			},
			theme: this.config.theme,
			session: {
				startedAt: new Date(this.sessionWallClockStart).toISOString(),
				endedAt: new Date().toISOString(),
				durationMs,
				endReason: reason,
				sensorMode: this.sensorMode
			},
			outcomes: {
				finalBreakpoint,
				completedCoins,
				completedRatios: this.completedRatios.slice(),
				totalValidFlicks: this.totalValidFlicks,
				unfinishedRatio,
				unfinishedFlicks,
				unfinishedProgress: unfinishedRatio ? unfinishedFlicks / unfinishedRatio : 0
			},
			events: []
		};
	}

	async postSessionPayload(payload) {
		const backend = this.config.backend || {};
		if (backend.sendOnceAfterSession === false) {
			this.postStatus = "disabled";
			this.statusLine.textContent = "Payload posting is disabled in config.";
			return;
		}
		if (!backend.url) {
			this.postStatus = "not_configured";
			this.storePendingPayload(payload, "backend_not_configured");
			this.statusLine.textContent = "Payload stored locally. Configure backend.url to POST it.";
			return;
		}

		try {
			const response = await fetch(backend.url, {
				method: backend.method || "POST",
				headers: backend.headers || { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				keepalive: true
			});
			this.postStatus = response.ok ? "sent" : `http_${response.status}`;
			if (!response.ok) this.storePendingPayload(payload, this.postStatus);
			this.statusLine.textContent = `Payload status: ${this.postStatus}.`;
		}
		catch (err) {
			this.postStatus = "network_error";
			this.storePendingPayload(payload, "network_error");
			this.statusLine.textContent = "Payload stored locally after a network error.";
		}
	}

	storePendingPayload(payload, reason) {
		const key = "shakeOutPendingPayloads";
		const pending = JSON.parse(localStorage.getItem(key) || "[]");
		pending.push({ reason, storedAt: new Date().toISOString(), payload });
		localStorage.setItem(key, JSON.stringify(pending.slice(-20)));
		localStorage.setItem("shakeOutLastPayload", JSON.stringify(payload));
	}

	feedbackValid() {
		this.jarImpulse = Math.max(this.jarImpulse, 1);
		if (navigator.vibrate) navigator.vibrate(this.config.feedback.validVibrateMs);
		this.audio.valid();
	}

	feedbackCoin() {
		this.jarImpulse = Math.max(this.jarImpulse, 1.4);
		if (navigator.vibrate) navigator.vibrate(this.config.feedback.coinVibratePattern);
		this.audio.coin();
	}

	feedbackIdle() {
		if (navigator.vibrate) navigator.vibrate(this.config.feedback.idleWarningVibrateMs);
		this.audio.idle();
	}

	addParticles(count, color) {
		const jar = this.getJarRect();
		const mouth = this.getMouthPoint(performance.now());
		for (let i = 0; i < count; i++) {
			this.particles.push({
				x: mouth.x + (Math.random() - 0.5) * jar.w * 0.25,
				y: mouth.y + (Math.random() - 0.5) * jar.h * 0.08,
				vx: (Math.random() - 0.5) * 140,
				vy: -60 - Math.random() * 120,
				r: 2 + Math.random() * 5,
				life: 0.5 + Math.random() * 0.55,
				maxLife: 0.9,
				color
			});
		}
	}

	updateHud() {
		const coinNumber = this.isMeasured || this.screen === "ended" ? this.completedRatios.length : this.collectedCoins.length;
		this.coinHud.textContent = String(coinNumber);
		this.ratioHud.textContent = formatRatio(this.currentRatio);
		this.progressHud.textContent = `${this.validInRatio}/${this.currentRatio || 0}`;
		this.meter.style.width = "0%";
	}

	logEvent(type, detail) {
		const now = performance.now();
		const event = {
			type,
			timestamp: new Date().toISOString(),
			msSinceAppStart: Math.round(now),
			msSinceSessionStart: this.sessionStartMs ? Math.round(now - this.sessionStartMs) : null,
			phase: this.phase,
			sessionId: this.sessionId,
			detail
		};
		this.events.push(event);
		if (this.config.debug.logToConsole) console.log("[Shake-Out]", type, detail);
	}

	frame(ms) {
		const dt = Math.min(0.05, (ms - this.lastFrameMs) / 1000 || 0.016);
		this.lastFrameMs = ms;
		this.animationTick += dt;
		try {
			this.updateAnimation(dt, ms);
			this.draw(ms);
			window.__shakeOutLastDrawError = null;
		}
		catch (err) {
			window.__shakeOutLastDrawError = String(err && err.message ? err.message : err);
			console.error("[Shake-Out] draw failed", err);
			this.drawFallbackScene();
		}
		window.__shakeOutHealth = {
			screen: this.screen,
			phase: this.phase,
			width: this.width,
			height: this.height,
			coins: this.completedRatios.length,
			drawError: window.__shakeOutLastDrawError
		};
		requestAnimationFrame(next => this.frame(next));
	}

	updateAnimation(dt, ms) {
		this.jarImpulse = Math.max(0, this.jarImpulse - dt * 2.6);
		this.jarAngle = Math.sin(ms / 55) * this.jarImpulse * 0.09;
		for (const particle of this.particles) {
			particle.life -= dt;
			particle.x += particle.vx * dt;
			particle.y += particle.vy * dt;
			particle.vy += 240 * dt;
		}
		this.particles = this.particles.filter(p => p.life > 0);
		if (this.coinDropping && !this.ended && ms - this.coinDropping.startMs >= this.coinDropping.durationMs) {
			this.advanceAfterCoinDrop();
		}
		if (this.countAnimation) {
			const t = clamp((ms - this.countAnimation.startMs) / this.countAnimation.durationMs, 0, 1);
			this.title.textContent = `${Math.round(this.countAnimation.coins * easeOut(t))} coins`;
			if (t >= 1) this.body.textContent = this.formatEndBody(this.countAnimation);
		}
	}

	formatEndBody(outcome) {
		if (!outcome.unfinishedRatio) return `Breakpoint ${outcome.finalBreakpoint}. All scheduled coins completed.`;
		return `Breakpoint ${outcome.finalBreakpoint}. ${outcome.unfinishedFlicks} of ${outcome.unfinishedRatio} completed on the unfinished ratio.`;
	}

	getJarRect() {
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		const jarW = Math.min(w * 0.66, 360);
		const jarH = Math.min(h * 0.48, 510);
		return {
			x: (w - jarW) / 2,
			y: Math.max(82, h * 0.13),
			w: jarW,
			h: jarH
		};
	}

	getPileTarget(index) {
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		const spread = Math.min(w * 0.48, 280);
		const col = index % 7;
		const row = Math.floor(index / 7);
		return {
			x: w * 0.5 + (col - 3) * (spread / 7) + ((row % 2) - 0.5) * 16,
			y: h - 56 - row * 14,
			scale: 0.58 + (index % 3) * 0.04,
			rotation: -0.55 + (index % 5) * 0.26
		};
	}

	getJarTransform(ms) {
		const jar = this.getJarRect();
		const shakeX = Math.sin(ms / 42) * this.jarImpulse * 8;
		const shakeY = Math.cos(ms / 53) * this.jarImpulse * 4;
		return {
			jar,
			cx: jar.x + jar.w / 2 + shakeX,
			cy: jar.y + jar.h / 2 + shakeY,
			angle: this.jarAngle
		};
	}

	localToScreen(localX, localY, ms) {
		const { jar, cx, cy, angle } = this.getJarTransform(ms);
		const x = localX - jar.w / 2;
		const y = localY - jar.h / 2;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		return {
			x: cx + x * cos - y * sin,
			y: cy + x * sin + y * cos
		};
	}

	getMouthPoint(ms) {
		const jar = this.getJarRect();
		return this.localToScreen(jar.w * 0.5, jar.h * 0.91, ms);
	}

	draw(ms) {
		const ctx = this.ctx;
		const w = this.width;
		const h = this.height;
		ctx.clearRect(0, 0, w, h);
		this.drawBackground(ctx, w, h);
		this.drawJarScene(ctx, ms);
		this.drawCollectedCoins(ctx, ms);
		this.drawDroppingCoin(ctx, ms);
		this.drawParticles(ctx);
	}

	drawFallbackScene() {
		const ctx = this.ctx;
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = "#f8f3e9";
		ctx.fillRect(0, 0, w, h);
		ctx.strokeStyle = "#18212b";
		ctx.lineWidth = 6;
		ctx.beginPath();
		roundedRect(ctx, w * 0.27, h * 0.14, w * 0.46, h * 0.5, 28);
		ctx.stroke();
		ctx.fillStyle = "#ff8a2a";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h * 0.65, w * 0.17, 22, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#ffbf32";
		for (let i = 0; i < 4; i++) {
			ctx.beginPath();
			ellipsePath(ctx, w * 0.42 + i * 34, h * 0.81 - (i % 2) * 10, 26, 10, i * 0.22, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
	}

	drawBackground(ctx, w, h) {
		const sky = ctx.createLinearGradient(0, 0, 0, h);
		sky.addColorStop(0, "#f8f3e9");
		sky.addColorStop(0.62, "#e5f2eb");
		sky.addColorStop(1, "#d4eadf");
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "rgba(15, 155, 142, 0.1)";
		for (let i = 0; i < 12; i++) {
			const x = (i * 97 + this.animationTick * 12) % (w + 120) - 60;
			const y = 90 + (i % 5) * 54;
			ctx.beginPath();
			ellipsePath(ctx, x, y, 42, 13, 0, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = "#bedbcf";
		ctx.fillRect(0, h - 64, w, 64);
		ctx.fillStyle = "rgba(24, 33, 43, 0.12)";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h - 55, Math.min(w * 0.35, 240), 20, 0, 0, Math.PI * 2);
		ctx.fill();
	}

	drawJarScene(ctx, ms) {
		const { jar, cx, cy, angle } = this.getJarTransform(ms);
		const progress = this.currentRatio ? clamp(this.validInRatio / this.currentRatio, 0, 1) : 0;

		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(angle);
		ctx.translate(-jar.w / 2, -jar.h / 2);

		this.drawJar(ctx, jar.w, jar.h);
		if (!this.ended) {
			this.drawCoin(ctx, jar.w, jar.h, progress, ms);
			this.drawRocks(ctx, jar.w, jar.h, progress, ms);
		}
		this.drawJarGloss(ctx, jar.w, jar.h);
		if (this.phase === "calibration") this.drawCalibrationCue(ctx, jar.w, jar.h, ms);
		ctx.restore();
	}

	drawJar(ctx, w, h) {
		ctx.save();
		ctx.fillStyle = "rgba(255, 255, 255, 0.52)";
		ctx.strokeStyle = "#18212b";
		ctx.lineWidth = 8;
		ctx.beginPath();
		ctx.moveTo(w * 0.28, h * 0.1);
		ctx.bezierCurveTo(w * 0.18, h * 0.16, w * 0.14, h * 0.23, w * 0.13, h * 0.34);
		ctx.lineTo(w * 0.13, h * 0.66);
		ctx.bezierCurveTo(w * 0.13, h * 0.79, w * 0.23, h * 0.85, w * 0.34, h * 0.86);
		ctx.lineTo(w * 0.66, h * 0.86);
		ctx.bezierCurveTo(w * 0.77, h * 0.85, w * 0.87, h * 0.79, w * 0.87, h * 0.66);
		ctx.lineTo(w * 0.87, h * 0.34);
		ctx.bezierCurveTo(w * 0.86, h * 0.23, w * 0.82, h * 0.16, w * 0.72, h * 0.1);
		ctx.quadraticCurveTo(w * 0.5, h * 0.04, w * 0.28, h * 0.1);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = "#ff8a2a";
		ctx.strokeStyle = "#18212b";
		ctx.lineWidth = 6;
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h * 0.91, w * 0.29, h * 0.055, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#f6f1e6";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h * 0.91, w * 0.21, h * 0.032, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = "rgba(24, 33, 43, 0.55)";
		ctx.lineWidth = 3;
		for (let i = -5; i <= 5; i++) {
			const x = w * 0.5 + i * w * 0.046;
			ctx.beginPath();
			ctx.moveTo(x, h * 0.86);
			ctx.lineTo(x + w * 0.004, h * 0.91);
			ctx.stroke();
		}

		ctx.strokeStyle = "rgba(24, 33, 43, 0.55)";
		ctx.lineWidth = 4;
		ctx.beginPath();
		ctx.moveTo(w * 0.28, h * 0.18);
		ctx.bezierCurveTo(w * 0.2, h * 0.29, w * 0.21, h * 0.42, w * 0.21, h * 0.56);
		ctx.stroke();
		ctx.restore();
	}

	drawCoin(ctx, w, h, progress, ms) {
		let x = w * 0.5;
		let y = lerp(h * 0.36, h * 0.77, easeOut(progress));
		let alpha = 1;
		if (this.coinDropping) {
			alpha = 0;
		}
		this.drawCoinShape(ctx, x, y, Math.min(w, h) * 0.067, Math.sin(ms / 220) * 0.18, alpha);
	}

	drawDroppingCoin(ctx, ms) {
		if (!this.coinDropping) return;
		const t = clamp((ms - this.coinDropping.startMs) / this.coinDropping.durationMs, 0, 1);
		const e = easeInOut(t);
		const from = this.coinDropping.from;
		const to = this.coinDropping.to;
		const arc = Math.sin(t * Math.PI) * 88;
		const x = lerp(from.x, to.x, e) + Math.sin(t * Math.PI * 3) * 12;
		const y = lerp(from.y, to.y, e) - arc;
		const scale = lerp(0.54, to.scale, e);
		this.drawCoinShape(ctx, x, y, 33 * scale, this.coinDropping.spin * t, 1);
	}

	drawCollectedCoins(ctx, ms) {
		const countAnim = this.countAnimation;
		for (let i = 0; i < this.collectedCoins.length; i++) {
			const coin = this.collectedCoins[i];
			let alpha = 1;
			let x = coin.x;
			let y = coin.y;
			let scale = coin.scale;
			if (countAnim) {
				const localDelay = i * 55;
				const t = clamp((ms - countAnim.startMs - localDelay) / 700, 0, 1);
				const e = easeOut(t);
				x = lerp(coin.x, this.width * 0.5, e);
				y = lerp(coin.y, this.height * 0.28, e);
				scale = lerp(coin.scale, 0.25, e);
				alpha = 1 - e;
			}
			if (alpha <= 0.02) continue;
			this.drawCoinShape(ctx, x, y, 33 * scale, coin.rotation, alpha);
		}
	}

	drawCoinShape(ctx, x, y, r, rotation, alpha = 1) {
		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.translate(x, y);
		ctx.rotate(rotation);
		ctx.scale(1.18, 0.56);
		ctx.fillStyle = "#ffbf32";
		ctx.strokeStyle = "#8f6619";
		ctx.lineWidth = Math.max(2.5, r * 0.16);
		ctx.beginPath();
		ctx.arc(0, 0, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.strokeStyle = "rgba(143, 102, 25, 0.55)";
		ctx.lineWidth = Math.max(2, r * 0.11);
		ctx.beginPath();
		ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
		ctx.stroke();
		ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
		ctx.beginPath();
		ellipsePath(ctx, -r * 0.24, -r * 0.32, r * 0.34, r * 0.13, -0.25, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	drawRocks(ctx, w, h, progress, ms) {
		const clearFloat = progress * this.rocks.length;
		for (let i = this.rocks.length - 1; i >= 0; i--) {
			const rock = this.rocks[i];
			const damage = clamp(clearFloat - i, 0, 1);
			if (damage >= 1) continue;
			const loosen = easeOut(damage);
			const x = rock.x * w + Math.sin(ms / 110 + rock.wobble) * (this.jarImpulse * 5 + loosen * 10);
			const y = rock.y * h + Math.cos(ms / 130 + rock.wobble) * (this.jarImpulse * 4 + loosen * 8) + loosen * h * 0.05;
			const radius = rock.r * Math.min(w, h) * (1 - damage * 0.18);
			ctx.save();
			ctx.globalAlpha = 0.98 - damage * 0.62;
			ctx.translate(x, y);
			ctx.rotate(rock.angle + Math.sin(ms / 120 + i) * 0.12 + loosen * 0.5);
			ctx.fillStyle = rock.color;
			ctx.strokeStyle = "#18212b";
			ctx.lineWidth = 4;
			ctx.beginPath();
			if (rock.shape === 0) ellipsePath(ctx, 0, 0, radius * 1.42, radius * 0.82, 0, 0, Math.PI * 2);
			else if (rock.shape === 1) roundedRect(ctx, -radius, -radius, radius * 2, radius * 2, radius * 0.28);
			else if (rock.shape === 2) roundedRect(ctx, -radius * 1.35, -radius * 0.7, radius * 2.7, radius * 1.4, radius * 0.55);
			else {
				ctx.moveTo(0, -radius * 1.15);
				ctx.lineTo(radius * 1.15, 0);
				ctx.lineTo(0, radius * 1.15);
				ctx.lineTo(-radius * 1.15, 0);
				ctx.closePath();
			}
			ctx.fill();
			ctx.stroke();
			ctx.fillStyle = "rgba(255, 255, 255, 0.36)";
			ctx.beginPath();
			ellipsePath(ctx, -radius * 0.32, -radius * 0.28, radius * 0.34, radius * 0.16, -0.4, 0, Math.PI * 2);
			ctx.fill();
			if (rock.stripe) {
				ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
				ctx.lineWidth = 3;
				ctx.beginPath();
				ctx.moveTo(-radius * 0.85, radius * 0.08);
				ctx.lineTo(radius * 0.85, -radius * 0.08);
				ctx.stroke();
			}
			if (damage > 0.02) {
				ctx.strokeStyle = "rgba(24, 33, 43, 0.65)";
				ctx.lineWidth = 3;
				ctx.beginPath();
				ctx.moveTo(-radius * 0.55, -radius * 0.15);
				ctx.lineTo(-radius * 0.1, radius * 0.08);
				ctx.lineTo(radius * 0.38, -radius * 0.22);
				ctx.stroke();
			}
			ctx.restore();
		}
	}

	drawJarGloss(ctx, w, h) {
		ctx.save();
		ctx.globalAlpha = 0.42;
		ctx.strokeStyle = "white";
		ctx.lineWidth = 7;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(w * 0.72, h * 0.2);
		ctx.quadraticCurveTo(w * 0.78, h * 0.42, w * 0.73, h * 0.67);
		ctx.stroke();
		ctx.restore();
	}

	drawCalibrationCue(ctx, w, h, ms) {
		const t = (Math.sin(ms / 320) + 1) / 2;
		ctx.save();
		ctx.translate(w * 0.5, h * 0.18);
		ctx.rotate(lerp(-0.45, 0.45, t));
		ctx.strokeStyle = "#b84535";
		ctx.lineWidth = 8;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.arc(0, 0, w * 0.22, Math.PI * 0.15, Math.PI * 0.85);
		ctx.stroke();
		ctx.fillStyle = "#b84535";
		ctx.beginPath();
		ctx.moveTo(w * 0.14, h * 0.01);
		ctx.lineTo(w * 0.22, h * 0.03);
		ctx.lineTo(w * 0.17, h * 0.095);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	drawParticles(ctx) {
		for (const p of this.particles) {
			const alpha = clamp(p.life / p.maxLife, 0, 1);
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.fillStyle = p.color;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
	}
}

async function loadConfig() {
	const response = await fetch("config.json", { cache: "no-store" });
	if (!response.ok) throw new Error(`config.json failed: ${response.status}`);
	return response.json();
}

async function start() {
	if (!window.C3_Is_Supported) return;
	try {
		const config = await loadConfig();
		window.shakeOutApp = new ShakeOutApp(config);
	}
	catch (err) {
		console.error(err);
		const panel = $("panel");
		panel.classList.remove("hidden");
		$("stateKicker").textContent = "Error";
		$("stateTitle").textContent = "Could not load";
		$("stateBody").textContent = "The game configuration could not be loaded.";
		$("statusLine").textContent = String(err.message || err);
	}
}

start();
