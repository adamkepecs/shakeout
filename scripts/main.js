import * as Messaging from "./project/messaging.js";

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const TAU = Math.PI * 2;
const STORAGE_KEYS = {
	firstUseAt: "shakeOutFirstUseAt",
	savedCalibration: "shakeOutSavedCalibration",
	tutorialComplete: "shakeOutTutorialComplete"
};
const CANDY_FAMILIES = [
	{
		name: "yellow",
		base: "#ffd74d",
		light: "#fff3a8",
		dark: "#c88918",
		stroke: "#815a13",
		difficulty: 0.28
	},
	{
		name: "green",
		base: "#38d39f",
		light: "#a9f5d8",
		dark: "#168a68",
		stroke: "#135846",
		difficulty: 0.4
	},
	{
		name: "blue",
		base: "#5ca8ff",
		light: "#c4e2ff",
		dark: "#2f73d0",
		stroke: "#214c86",
		difficulty: 0.55
	},
	{
		name: "orange",
		base: "#ff9a4f",
		light: "#ffd2ad",
		dark: "#c95a24",
		stroke: "#7d361a",
		difficulty: 0.65
	},
	{
		name: "pink",
		base: "#f472b6",
		light: "#ffd1ea",
		dark: "#be3f87",
		stroke: "#7b2856",
		difficulty: 0.78
	},
	{
		name: "purple",
		base: "#a78bfa",
		light: "#ddd4ff",
		dark: "#7255d8",
		stroke: "#49358f",
		difficulty: 0.9
	}
];

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

function coinLabel(count) {
	return `${count} ${count === 1 ? "coin" : "coins"}`;
}

function percentile(values, q) {
	if (!values.length) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const index = clamp((sorted.length - 1) * q, 0, sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower];
	return lerp(sorted[lower], sorted[upper], index - lower);
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
		this.tone(240, 0.045, "triangle", 0.026);
		this.tone(520, 0.06, "sine", 0.022, 0.025);
	}

	crack() {
		this.tone(170, 0.045, "square", 0.025);
		this.tone(780, 0.075, "triangle", 0.034, 0.018);
		this.tone(1180, 0.05, "sine", 0.018, 0.085);
	}

	coin() {
		this.tone(430, 0.08, "triangle", 0.04);
		this.tone(720, 0.105, "sine", 0.035, 0.055);
		this.tone(1060, 0.14, "sine", 0.026, 0.13);
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
		this.calibrationThreshold = config.motion.calibrationLowFloorDps;
		this.candidate = null;
		this.cooldownUntil = 0;
		this.needsSettle = false;
		this.settleStartMs = 0;
		this.lastWeakLogMs = 0;
		this.lastMotionMs = 0;
		this.sensorSeen = false;
		this.lastAccel = null;
	}

	setMode(mode) {
		this.mode = mode;
		this.candidate = null;
		this.cooldownUntil = 0;
		this.needsSettle = false;
		this.settleStartMs = 0;
	}

	setCalibrationThreshold(threshold) {
		this.calibrationThreshold = clamp(threshold, this.config.calibrationLowFloorDps, this.config.maximumThresholdDps);
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

		const sample = {
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
		};
		this.sensorSeen = true;
		this.lastMotionMs = now;
		if (this.callbacks.onMotionSample) this.callbacks.onMotionSample({
			ms: now,
			score: vector,
			features: sample
		});
		this.processVector(vector, sample);
	}

	processVector(vector, features) {
		const now = performance.now();
		if (this.mode === "idle") return;
		if (this.mode === "baseline") return;
		if (now < this.cooldownUntil) return;

		const activeThreshold = this.mode === "calibration" ? this.calibrationThreshold : this.threshold;
		const neutralThreshold = this.getNeutralThreshold(activeThreshold);
		const settleThreshold = Math.max(this.config.neutralReturnFloorDps, activeThreshold * (this.config.postFlickSettleRatio || 0.45));
		if (this.needsSettle) {
			if (vector <= settleThreshold) {
				if (!this.settleStartMs) this.settleStartMs = now;
				if (now - this.settleStartMs >= (this.config.postFlickSettleMs || 180)) {
					this.needsSettle = false;
					this.settleStartMs = 0;
				}
			}
			else {
				this.settleStartMs = 0;
			}
			if (this.needsSettle) return;
		}

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
			this.needsSettle = true;
			this.settleStartMs = 0;
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
			this.needsSettle = true;
			this.settleStartMs = 0;
			this.cooldownUntil = now + this.config.debounceMs;
			this.callbacks.onInvalid(result);
		}
	}

	simulateFlick(multiplier = 1.2) {
		const now = performance.now();
		if (now < this.cooldownUntil) return;
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
		else if (this.mode !== "idle") {
			this.cooldownUntil = now + this.config.debounceMs;
			this.callbacks.onValid(result);
		}
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
			onMotionSample: sample => this.onMotionSample(sample),
			onCalibrationSample: result => this.onCalibrationSample(result),
			onValid: result => this.onValidFlick(result),
			onInvalid: result => this.onInvalidMovement(result)
		});

		this.participantId = getQueryParam(config.participantIdParamNames) || localStorage.getItem("shakeOutParticipantId") || `local-${uuid()}`;
		localStorage.setItem("shakeOutParticipantId", this.participantId);
		this.firstUseAt = localStorage.getItem(STORAGE_KEYS.firstUseAt);
		this.isFirstUse = !this.firstUseAt;
		if (!this.firstUseAt) {
			this.firstUseAt = new Date().toISOString();
			localStorage.setItem(STORAGE_KEYS.firstUseAt, this.firstUseAt);
		}

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
		this.baselineSamples = [];
		this.baseline = null;
		this.baselineTimer = null;
		this.calibrationCooldownTimer = null;
		this.calibration = null;
		this.savedCalibration = null;
		this.motionListening = false;
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
		this.coinFailing = null;
		this.pendingCoinDrop = null;
		this.coinBody = null;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.coinKickMs = 0;
		this.jarImpulse = 0;
		this.jarAngle = 0;
		this.particles = [];
		this.localEffects = [];
		this.tiles = [];
		this.blockers = [];
		this.coinStartCell = null;
		this.brokenBlockers = new Set();
		this.lastBlockerProgress = 0;
		this.coinStartMs = 0;
		this.coinDeadlineMs = 0;
		this.coinWarningMs = 0;
		this.coinWarningActive = false;
		this.animationTick = 0;

		this.setupDots();
		this.bindEvents();
		this.resize();
		this.loadSavedCalibration();
		this.resetCoin(0, this.tutorialRatios[0]);
		this.updatePanelForHome();
		this.updateHud();
		this.logEvent("app_loaded", {
			participantId: this.participantId,
			firstUseAt: this.firstUseAt,
			hasSavedCalibration: !!this.savedCalibration
		});
		requestAnimationFrame(ms => this.frame(ms));
	}

	setupDots() {
		this.sampleDots.innerHTML = "";
		for (let i = 0; i < this.config.motion.calibrationSamplesRequired; i++) {
			const dot = document.createElement("i");
			this.sampleDots.appendChild(dot);
		}
	}

	clearCalibrationTimers() {
		clearTimeout(this.baselineTimer);
		clearTimeout(this.calibrationCooldownTimer);
		this.baselineTimer = null;
		this.calibrationCooldownTimer = null;
	}

	loadSavedCalibration() {
		const raw = localStorage.getItem(STORAGE_KEYS.savedCalibration);
		if (!raw) return false;
		try {
			const saved = JSON.parse(raw);
			if (!saved || saved.calibrationVersion !== this.config.calibrationVersion || !saved.calibration) return false;
			this.savedCalibration = saved;
			this.calibration = saved.calibration;
			this.baseline = saved.calibration.baseline || null;
			this.sensorMode = saved.sensorMode || "sensor";
			this.classifier.setThreshold(saved.calibration.thresholdDps);
			return true;
		}
		catch (err) {
			localStorage.removeItem(STORAGE_KEYS.savedCalibration);
			return false;
		}
	}

	saveCalibration() {
		if (!this.calibration) return;
		const saved = {
			savedAt: new Date().toISOString(),
			participantId: this.participantId,
			appVersion: this.config.appVersion,
			calibrationVersion: this.config.calibrationVersion,
			sensorMode: this.sensorMode,
			calibration: this.calibration
		};
		this.savedCalibration = saved;
		localStorage.setItem(STORAGE_KEYS.savedCalibration, JSON.stringify(saved));
		this.logEvent("calibration_saved", {
			thresholdDps: this.calibration.thresholdDps,
			savedAt: saved.savedAt
		});
	}

	clearSavedCalibration() {
		localStorage.removeItem(STORAGE_KEYS.savedCalibration);
		this.savedCalibration = null;
		this.calibration = null;
		this.baseline = null;
	}

	bindEvents() {
		window.addEventListener("resize", () => this.resize());
		document.addEventListener("visibilitychange", this.visibilityListener);
		this.primaryButton.addEventListener("click", () => this.onPrimary());
		this.secondaryButton.addEventListener("click", () => this.onSecondary());
		this.simulateButton.addEventListener("click", () => this.onGhost());
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
			case "home":
				if (this.savedCalibration) this.playFromHome();
				else this.requestMotionAndCalibrate();
				break;
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
				if (this.savedCalibration) this.playFromHome();
				else this.updatePanelForHome("Calibrate before playing again.");
				break;
		}
	}

	onSecondary() {
		this.audio.unlock();
		switch (this.screen) {
			case "home":
				if (this.savedCalibration) this.startDemoFromHome();
				else this.useDemoInput();
				break;
			case "calibration_intro":
			case "calibration_baseline":
			case "calibration_collect":
				this.useDemoInput();
				break;
			case "ended":
				this.updatePanelForHome();
				break;
		}
	}

	onGhost() {
		this.audio.unlock();
		if (this.screen === "home" || this.screen === "ended") {
			this.restartFromCalibration();
			return;
		}
		if (this.config.debug.showSimulateButton || this.sensorMode === "demo") this.classifier.simulateFlick();
	}

	async playFromHome() {
		this.primaryButton.disabled = true;
		this.statusLine.textContent = "Starting sensors...";
		const ok = this.sensorMode === "demo" ? true : await this.ensureMotionReady("play");
		this.primaryButton.disabled = false;
		if (!ok) return;
		this.startMeasuredSession();
	}

	async startDemoFromHome() {
		this.secondaryButton.disabled = true;
		this.statusLine.textContent = "Starting demo...";
		const ok = this.sensorMode === "demo" ? true : await this.ensureMotionReady("demo");
		this.secondaryButton.disabled = false;
		if (!ok) return;
		this.startTutorial();
	}

	async requestMotionAndCalibrate() {
		this.primaryButton.disabled = true;
		this.statusLine.textContent = "Checking motion sensor...";
		const ok = await this.ensureMotionReady("calibration_start");
		this.primaryButton.disabled = false;
		if (!ok) return;
		this.startCalibrationBaseline();
	}

	async ensureMotionReady(reason) {
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
			this.statusLine.textContent = "Motion permission was not granted.";
			this.secondaryButton.classList.remove("hidden");
			this.logEvent("motion_permission_denied", { permission });
			return false;
		}

		await this.tryLockPortraitOrientation(reason);
		this.sensorMode = "sensor";
		if (!this.motionListening) {
			window.addEventListener("devicemotion", this.motionListener, { passive: true });
			this.motionListening = true;
		}
		this.logEvent("motion_permission_granted", { permission, reason });

		setTimeout(() => {
			if (["calibration_baseline", "calibration_collect", "playing"].includes(this.screen) && !this.classifier.sensorSeen) {
				this.statusLine.textContent = "No motion events detected yet. On Android, check browser sensor permissions.";
				this.secondaryButton.classList.remove("hidden");
				this.logEvent("sensor_not_detected", { waitMs: this.config.motion.sensorWarmupMs });
			}
		}, this.config.motion.sensorWarmupMs);
		return true;
	}

	useDemoInput() {
		this.audio.unlock();
		this.tryLockPortraitOrientation("demo_input");
		this.sensorMode = "demo";
		this.secondaryButton.classList.add("hidden");
		this.simulateButton.classList.remove("hidden");
		const shouldStartCalibration = this.screen === "calibration_intro" || (this.screen === "home" && !this.savedCalibration);
		if (shouldStartCalibration) this.startCalibrationBaseline();
		else this.statusLine.textContent = "Demo input is active for local testing.";
		this.logEvent("demo_input_enabled", {});
	}

	onMotionSample(sample) {
		if (this.screen !== "calibration_baseline") return;
		this.baselineSamples.push(sample.score);
	}

	startCalibrationBaseline() {
		this.clearCalibrationTimers();
		this.screen = "calibration_baseline";
		this.phase = "calibration";
		this.baselineSamples = [];
		this.baseline = null;
		this.classifier.setMode("baseline");
		this.primaryButton.classList.add("hidden");
		this.sampleDots.classList.add("hidden");
		this.simulateButton.classList.add("hidden");
		this.kicker.textContent = "Calibration";
		this.title.textContent = "Hold still";
		this.body.textContent = "Keep the phone upright and still for a moment. This measures hand and sensor noise before the flick samples.";
		this.statusLine.textContent = "Measuring baseline...";
		this.meter.style.width = "0%";
		this.logEvent("calibration_baseline_start", {
			durationMs: this.config.motion.baselineDurationMs
		});
		this.baselineTimer = setTimeout(() => this.finishCalibrationBaseline(), this.config.motion.baselineDurationMs);
	}

	finishCalibrationBaseline() {
		if (this.screen !== "calibration_baseline") return;
		const cfg = this.config.motion;
		const sampleCount = this.baselineSamples.length;
		const p50 = percentile(this.baselineSamples, 0.5);
		const p95 = percentile(this.baselineSamples, 0.95);
		const max = this.baselineSamples.length ? Math.max(...this.baselineSamples) : 0;
		const captureThreshold = clamp(
			Math.max(
				cfg.calibrationLowFloorDps,
				p95 * cfg.calibrationBaselineMultiplier,
				max * cfg.calibrationBaselineMaxMultiplier
			),
			cfg.calibrationLowFloorDps,
			cfg.maximumThresholdDps
		);
		const gameFloor = clamp(
			Math.max(
				cfg.minimumThresholdDps,
				p95 * cfg.gameBaselineMultiplier,
				captureThreshold * 1.05
			),
			cfg.minimumThresholdDps,
			cfg.maximumThresholdDps
		);
		this.baseline = {
			sampleCount,
			p50Dps: Math.round(p50 * 100) / 100,
			p95Dps: Math.round(p95 * 100) / 100,
			maxDps: Math.round(max * 100) / 100,
			captureThresholdDps: Math.round(captureThreshold * 100) / 100,
			gameFloorDps: Math.round(gameFloor * 100) / 100
		};
		this.classifier.setCalibrationThreshold(captureThreshold);
		this.logEvent("calibration_baseline_complete", this.baseline);
		this.startCalibrationCollection();
	}

	startCalibrationCollection() {
		this.clearCalibrationTimers();
		this.screen = "calibration_collect";
		this.phase = "calibration";
		this.classifier.setMode("calibration");
		this.primaryButton.classList.add("hidden");
		this.sampleDots.classList.remove("hidden");
		if (this.config.debug.showSimulateButton || this.sensorMode === "demo") this.simulateButton.classList.remove("hidden");
		this.kicker.textContent = "Calibration";
		this.title.textContent = "Set your flick";
		this.body.textContent = "Now make one small, comfortable wrist flick at a time. Pause briefly after each buzz.";
		this.statusLine.textContent = "Collecting sample 1 of 8.";
		this.updateCalibrationDots();
	}

	onCalibrationSample(result) {
		if (this.screen !== "calibration_collect") return;
		this.calibrationSamples.push(result);
		this.classifier.setMode("idle");
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
			this.statusLine.textContent = "Good. Settle, then flick again.";
			this.calibrationCooldownTimer = setTimeout(() => {
				if (this.screen !== "calibration_collect") return;
				this.classifier.setMode("calibration");
				this.statusLine.textContent = `Collecting sample ${this.calibrationSamples.length + 1} of ${required}.`;
			}, this.config.motion.calibrationSampleCooldownMs);
		}
	}

	updateCalibrationDots() {
		const dots = Array.from(this.sampleDots.children);
		dots.forEach((dot, index) => dot.classList.toggle("on", index < this.calibrationSamples.length));
		this.meter.style.width = `${(this.calibrationSamples.length / this.config.motion.calibrationSamplesRequired) * 100}%`;
	}

	finishCalibration() {
		this.clearCalibrationTimers();
		const cfg = this.config.motion;
		const peaks = this.calibrationSamples.map(s => s.angularVelocity).sort((a, b) => a - b);
		const rank = clamp(cfg.calibrationRankIndex, 0, peaks.length - 1);
		const rankedPeak = peaks[rank];
		const sampleThreshold = rankedPeak * cfg.calibrationThresholdMultiplier;
		const baselineFloor = this.baseline ? this.baseline.gameFloorDps : cfg.minimumThresholdDps;
		const threshold = clamp(Math.max(sampleThreshold, baselineFloor), cfg.minimumThresholdDps, cfg.maximumThresholdDps);
		this.calibration = {
			version: this.config.calibrationVersion,
			completedAt: new Date().toISOString(),
			sampleCount: this.calibrationSamples.length,
			baseline: this.baseline,
			samplePeaksDps: this.calibrationSamples.map(s => Math.round(s.angularVelocity * 100) / 100),
			rankIndex: rank,
			rankedPeakDps: Math.round(rankedPeak * 100) / 100,
			sampleThresholdDps: Math.round(sampleThreshold * 100) / 100,
			baselineFloorDps: Math.round(baselineFloor * 100) / 100,
			thresholdDps: Math.round(threshold * 100) / 100,
			neutralReturnDps: Math.round(this.classifier.getNeutralThreshold(threshold) * 100) / 100,
			sensorMode: this.sensorMode
		};
		this.classifier.setThreshold(threshold);
		this.classifier.setMode("idle");
		this.logEvent("calibration_complete", this.calibration);
		Messaging.pushEvent("calibration", this.calibration);
		this.saveCalibration();

		this.updatePanelForHome("Calibration saved. Shake out as many coins as you can.");
	}

	startTutorial() {
		if (!this.savedCalibration && this.calibration) this.saveCalibration();
		this.screen = "playing";
		this.phase = "tutorial";
		this.isMeasured = false;
		this.panel.classList.remove("warning");
		this.activeRatios = this.tutorialRatios;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.classifier.setMode("game");
		this.panel.classList.add("compact");
		this.sampleDots.classList.add("hidden");
		this.kicker.textContent = "Demo";
		this.title.textContent = "Practice jar";
		this.body.textContent = "Shake one coin through the candy blocks.";
		this.primaryButton.classList.add("hidden");
		this.secondaryButton.classList.add("hidden");
		this.statusLine.textContent = `Practice with ${this.tutorialRatios.join(", ")} flick coins.`;
		this.simulateButton.textContent = "Test flick";
		this.simulateButton.classList.toggle("hidden", !(this.config.debug.showSimulateButton || this.sensorMode === "demo"));
		this.resetCoin(0, this.activeRatios[0]);
		this.logEvent("tutorial_start", { ratios: this.tutorialRatios });
		this.updateHud();
	}

	startMeasuredSession() {
		if (!this.savedCalibration && this.calibration) this.saveCalibration();
		this.screen = "playing";
		this.phase = "session";
		this.isMeasured = true;
		this.ended = false;
		this.panel.classList.remove("warning");
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
		this.statusLine.textContent = "Shake to drop the coin.";
		this.simulateButton.textContent = "Test flick";
		this.simulateButton.classList.toggle("hidden", !(this.config.debug.showSimulateButton || this.sensorMode === "demo"));
		this.resetCoin(0, this.activeRatios[0]);
		this.logEvent("session_start", { schedule: this.schedule });
		Messaging.pushEvent("gameState", "start");
		this.startIdleTimer();
		this.updateHud();
	}

	restartFromCalibration() {
		this.clearCalibrationTimers();
		this.clearSavedCalibration();
		this.sessionId = uuid();
		this.events = [];
		this.calibrationSamples = [];
		this.baselineSamples = [];
		this.baseline = null;
		this.calibration = null;
		this.completedRatios = [];
		this.totalValidFlicks = 0;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.isMeasured = false;
		this.ended = false;
		this.quitButton.classList.add("hidden");
		this.simulateButton.classList.toggle("hidden", !(this.config.debug.showSimulateButton || this.sensorMode === "demo"));
		this.setupDots();
		this.resetCoin(0, this.tutorialRatios[0]);
		this.updatePanelForCalibrationIntro();
		this.logEvent("app_restarted", {});
	}

	updatePanelForHome(status = "") {
		this.clearCalibrationTimers();
		this.screen = "home";
		this.phase = "ready";
		this.isMeasured = false;
		this.ended = false;
		this.coinDropping = null;
		this.coinFailing = null;
		this.pendingCoinDrop = null;
		this.countAnimation = null;
		this.collectedCoins = [];
		this.completedRatios = [];
		this.activeRatios = this.schedule;
		this.classifier.setMode("idle");
		this.panel.classList.remove("compact", "hidden", "warning");
		this.quitButton.classList.add("hidden");
		this.sampleDots.classList.add("hidden");
		this.meter.style.width = "0%";
		this.kicker.textContent = "Shake-Out";
		this.title.textContent = "Shake the coins out";
		if (this.savedCalibration) {
			this.body.textContent = "Each coin takes more good flicks. Keep going: later coins are tougher.";
			this.primaryButton.textContent = "PLAY";
			this.secondaryButton.textContent = "Demo";
			this.secondaryButton.classList.remove("hidden");
			this.simulateButton.textContent = "Recalibrate";
			this.simulateButton.classList.remove("hidden");
			this.statusLine.textContent = status || "Calibration saved on this device.";
		}
		else {
			this.body.textContent = "First set your flick once. After that, this device will remember it.";
			this.primaryButton.textContent = "Calibrate";
			this.secondaryButton.textContent = "Use demo input";
			this.secondaryButton.classList.remove("hidden");
			this.simulateButton.classList.add("hidden");
			this.statusLine.textContent = status || (this.isFirstUse ? "First use saved on this device." : "No saved calibration yet.");
		}
		this.primaryButton.disabled = false;
		this.primaryButton.classList.remove("hidden");
		this.resetCoin(0, this.schedule[0] || 1);
		this.updateHud();
	}

	updatePanelForCalibrationIntro() {
		this.screen = "calibration_intro";
		this.phase = "calibration";
		this.classifier.setMode("idle");
		this.panel.classList.remove("compact", "hidden");
		this.kicker.textContent = "Calibration";
		this.title.textContent = "Shake the jar";
		this.body.textContent = "Hold the phone upright. We will first measure stillness, then collect eight comfortable flicks.";
		this.primaryButton.textContent = "Allow motion";
		this.primaryButton.disabled = false;
		this.primaryButton.classList.remove("hidden");
		this.secondaryButton.textContent = "Use demo input";
		this.secondaryButton.classList.add("hidden");
		this.simulateButton.textContent = "Test flick";
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
		this.coinFailing = null;
		this.pendingCoinDrop = null;
		this.coinKickMs = 0;
		this.localEffects = [];
		this.coinStartCell = null;
		this.tiles = this.makeCandyTiles(index, ratio);
		this.blockers = this.makeBlockers(index, ratio);
		this.clearTilesForBlockers();
		this.brokenBlockers = new Set();
		this.coinBody = this.createCoinBody(index, ratio);
		this.lastBlockerProgress = 0;
		this.coinStartMs = performance.now();
		const sessionCfg = this.config.session || {};
		const limitSeconds = (sessionCfg.coinTimeoutBaseSeconds || 14) + ratio * (sessionCfg.coinTimeoutPerFlickSeconds || 1.5);
		this.coinDeadlineMs = this.coinStartMs + limitSeconds * 1000;
		this.coinWarningMs = this.coinDeadlineMs - (sessionCfg.coinWarningSeconds || 6) * 1000;
		this.coinWarningActive = false;
		this.panel.classList.remove("warning");
		this.addLocalDust(this.coinBody.x, this.coinBody.y, 10, "#f1cf72");
		this.updateHud();
	}

	createCoinBody(index, ratio) {
		const start = this.coinStartCell || this.getCrushPathPoint(0, index);
		const rand = seededRandom((index + 11) * 4073 + ratio * 83);
		return {
			x: start.x,
			y: start.y,
			homeX: start.x,
			homeY: start.y,
			vx: 0,
			vy: 0,
			r: 0.032,
			rotation: (rand() - 0.5) * 0.4,
			spin: 0,
			wakeHue: rand()
		};
	}

	makeCandyTiles(index, ratio) {
		const rand = seededRandom((index + 3) * 1777 + ratio * 3181);
		const patches = [];
		const patchCount = 8;
		for (let i = 0; i < patchCount; i++) {
			patches.push({
				x: 0.21 + rand() * 0.58,
				y: 0.15 + rand() * 0.69,
				spread: 0.13 + rand() * 0.12,
				family: CANDY_FAMILIES[(index + i * 2 + Math.floor(rand() * 3)) % CANDY_FAMILIES.length]
			});
		}
		const tiles = [];
		const cellY = 0.046;
		const cellX = 0.064;
		for (let row = 0; row < 18; row++) {
			const y = 0.145 + row * cellY + (rand() - 0.5) * 0.006;
			const bounds = this.getBottleInnerBounds(y);
			const usable = bounds.right - bounds.left - 0.05;
			const cols = Math.max(3, Math.floor(usable / cellX));
			const start = (bounds.left + bounds.right) * 0.5 - ((cols - 1) * cellX) * 0.5;
			for (let col = 0; col < cols; col++) {
				if (rand() < 0.055) continue;
				const x = start + col * cellX + (rand() - 0.5) * 0.008;
				let patch = patches[0];
				let best = Infinity;
				for (const candidate of patches) {
					const dx = (x - candidate.x) / candidate.spread;
					const dy = (y - candidate.y) / (candidate.spread * 0.86);
					const score = dx * dx + dy * dy + rand() * 0.22;
					if (score < best) {
						best = score;
						patch = candidate;
					}
				}
				const family = rand() < 0.82 ? patch.family : CANDY_FAMILIES[Math.floor(rand() * CANDY_FAMILIES.length)];
				const size = 0.052 + rand() * 0.008;
				tiles.push({
					x,
					y,
					row,
					col,
					size,
					hw: size * 0.5,
					hh: size * 0.5,
					family,
					color: rand() < 0.74 ? family.base : family.light,
					dark: family.dark,
					stroke: family.stroke,
					phase: rand() * TAU,
					angle: 0
				});
			}
		}
		tiles.sort((a, b) => a.y - b.y);
		return tiles;
	}

	makeBlockers(index, ratio) {
		const rand = seededRandom((index + 5) * 2203 + ratio * 4441);
		const hitCosts = this.makeHitCosts(ratio);
		const pathCells = this.pickCrushPathCells(index, hitCosts.length, rand);
		const blockers = [];
		let cumulative = 0;
		for (let i = 0; i < hitCosts.length; i++) {
			const hitCost = hitCosts[i];
			const startFlick = cumulative;
			cumulative += hitCost;
			const progress = cumulative / Math.max(1, ratio);
			const point = pathCells[i + 1] || this.getCrushPathPoint(progress, index);
			const familyIndex = this.familyIndexForHitCost(hitCost, progress, rand);
			const family = CANDY_FAMILIES[familyIndex];
			const size = 0.056;
			blockers.push({
				id: `${index}-${i}`,
				x: point.x,
				y: point.y,
				row: point.row,
				col: point.col,
				size,
				hw: size * 0.5,
				hh: size * 0.5,
				w: size,
				h: size,
				angle: 0,
				startFlick,
				endFlick: cumulative,
				hitCost,
				hitCount: 0,
				breakAt: progress,
				family,
				color: family.base,
				light: family.light,
				dark: family.dark,
				stroke: family.stroke,
				crystal: family.light,
				difficulty: family.difficulty,
				cracks: rand()
			});
		}
		blockers.sort((a, b) => a.y - b.y);
		return blockers;
	}

	makeHitCosts(ratio) {
		const total = Math.max(1, Math.round(ratio));
		const pattern = total <= 4 ? [1, 1, 2] : total <= 9 ? [1, 1, 2, 2, 3] : [1, 1, 2, 2, 3, 4, 5, 5];
		const costs = [];
		let remaining = total;
		let i = 0;
		while (remaining > 0) {
			let cost = Math.min(pattern[i % pattern.length], remaining);
			if (remaining - cost === 1 && cost > 1) cost -= 1;
			costs.push(cost);
			remaining -= cost;
			i++;
		}
		return costs;
	}

	familyIndexForHitCost(hitCost, progress, rand) {
		const base = hitCost <= 1 ? (rand() < 0.55 ? 0 : 1) : hitCost === 2 ? (rand() < 0.55 ? 2 : 3) : hitCost === 3 ? 4 : 5;
		const lateBump = progress > 0.72 && hitCost > 1 && rand() < 0.3 ? 1 : 0;
		return clamp(base + lateBump, 0, CANDY_FAMILIES.length - 1);
	}

	pickCrushPathCells(index, blockerCount, rand) {
		const cells = [];
		const used = new Set();
		for (let i = 0; i <= blockerCount; i++) {
			const progress = blockerCount ? i / blockerCount : 0;
			const desired = this.getCrushPathPoint(progress, index);
			const cell = this.pickNearestCandyCell(desired, used, rand);
			cells.push(cell || desired);
			if (cell) used.add(`${cell.row}:${cell.col}`);
		}
		this.coinStartCell = cells[0] || this.getCrushPathPoint(0, index);
		return cells;
	}

	pickNearestCandyCell(point, used, rand) {
		let best = null;
		let bestScore = Infinity;
		for (const tile of this.tiles) {
			const key = `${tile.row}:${tile.col}`;
			if (used.has(key)) continue;
			const dx = tile.x - point.x;
			const dy = tile.y - point.y;
			const score = dx * dx * 1.15 + dy * dy + rand() * 0.00008;
			if (score < bestScore) {
				bestScore = score;
				best = tile;
			}
		}
		return best ? { x: best.x, y: best.y, row: best.row, col: best.col } : null;
	}

	clearTilesForBlockers() {
		if (!this.blockers.length) return;
		const occupiedCells = [{ ...(this.coinStartCell || {}) }, ...this.blockers];
		this.tiles = this.tiles.filter(tile => {
			return !occupiedCells.some(cell => {
				if (typeof cell.row === "number" && typeof cell.col === "number") {
					return tile.row === cell.row && tile.col === cell.col;
				}
				return Math.abs(tile.x - cell.x) < tile.hw * 1.08 && Math.abs(tile.y - cell.y) < tile.hh * 1.08;
			});
		});
	}

	getCrushPathPoint(progress, index = this.currentCoinIndex || 0) {
		const p = clamp(progress, 0, 1);
		const y = lerp(0.24, 0.83, easeInOut(p));
		const bounds = this.getBottleInnerBounds(y);
		const wiggle = Math.sin(p * Math.PI * 2.35 + index * 0.82) * (0.095 - p * 0.03);
		const x = clamp(0.5 + wiggle, bounds.left + 0.08, bounds.right - 0.08);
		return { x, y };
	}

	onValidFlick(result) {
		if (this.screen !== "playing" || this.coinDropping || this.coinFailing || this.pendingCoinDrop || this.ended) return;
		const now = performance.now();
		const interFlickIntervalMs = this.previousValidFlickMs ? now - this.previousValidFlickMs : null;
		this.previousValidFlickMs = now;
		this.lastValidFlickMs = now;
		this.idleWarned = false;
		const oldCount = this.validInRatio;
		this.validInRatio += 1;
		if (this.isMeasured) this.totalValidFlicks += 1;

		const progress = clamp(this.validInRatio / this.currentRatio, 0, 1);
		this.coinKickMs = now;
		const hit = this.applyBlockerHit(oldCount, this.validInRatio, progress);
		this.applyFlickImpulse(result, progress, hit);
		this.feedbackValid();
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

		if (this.validInRatio >= this.currentRatio && this.isExitPathOpen()) this.queueCoinDrop(result);
		this.updateHud();
	}

	onInvalidMovement(result) {
		if (this.ended) return;
		if (this.coinFailing) return;
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

	applyFlickImpulse(result, progress, hit = {}) {
		if (!this.coinBody) return;
		const coin = this.coinBody;
		const amplitudeScale = clamp((result.angularVelocity || result.amplitude || 80) / Math.max(1, result.threshold || 80), 0.95, 1.5);
		const alternatingSide = this.validInRatio % 2 === 0 ? -1 : 1;
		const hitBlock = hit.hitBlock || null;
		const crushedBlock = hit.crushedBlocks && hit.crushedBlocks.length ? hit.crushedBlocks[hit.crushedBlocks.length - 1] : null;
		let target = crushedBlock || hitBlock || this.getCrushPathPoint(progress);
		if (crushedBlock) {
			coin.homeX = crushedBlock.x;
			coin.homeY = crushedBlock.y;
		}
		else if (hitBlock) {
			const homeX = coin.homeX == null ? coin.x : coin.homeX;
			const homeY = coin.homeY == null ? coin.y : coin.homeY;
			const bump = 0.38;
			target = {
				x: lerp(homeX, hitBlock.x, bump),
				y: lerp(homeY, hitBlock.y, bump)
			};
			hitBlock.hitPulseMs = performance.now();
		}
		coin.target = {
			x: target.x,
			y: target.y,
			untilMs: performance.now() + (crushedBlock ? 470 : 170)
		};
		const pathNudge = target.x - coin.x;
		const hardBounce = hitBlock && !crushedBlock ? 0.22 * (hitBlock.difficulty || 0.5) : 0;
		const impulseX = (pathNudge * 14.8 + 0.28 * alternatingSide) * amplitudeScale;
		const impulseY = ((target.y - coin.y) * 13.6 + (crushedBlock ? 0.72 : 0.34 - hardBounce)) * amplitudeScale;
		coin.vx = coin.vx * 0.28 + impulseX;
		coin.vy = coin.vy * 0.28 + impulseY;
		coin.spin += impulseX * 4.1 + alternatingSide * 0.28;
		this.addCoinStream(coin.x, coin.y, 18, progress);
	}

	isExitPathOpen() {
		return this.blockers.every(block => this.brokenBlockers.has(block.id));
	}

	queueCoinDrop(result) {
		if (this.pendingCoinDrop || this.coinDropping || !this.isExitPathOpen()) return;
		const now = performance.now();
		if (this.coinBody) {
			this.coinBody.homeX = 0.5;
			this.coinBody.homeY = 0.855;
			this.coinBody.target = {
				x: 0.5,
				y: 0.855,
				untilMs: now + 360
			};
			this.coinBody.vx += (0.5 - this.coinBody.x) * 8.5;
			this.coinBody.vy += Math.max(0.65, (0.855 - this.coinBody.y) * 8.8);
			this.coinBody.spin += 1.8;
		}
		this.pendingCoinDrop = {
			dueMs: now + 270,
			result
		};
	}

	getBlockerDamage(block, progress) {
		const hitCost = Math.max(1, block.hitCost || 1);
		const countedHits = clamp(this.validInRatio - (block.startFlick || 0), 0, hitCost);
		const visibleHits = Math.max(block.hitCount || 0, countedHits);
		return clamp(visibleHits / hitCost, 0, 1);
	}

	isBlockerSolid(block, progress) {
		return !this.brokenBlockers.has(block.id);
	}

	applyBlockerHit(oldCount, newCount, progress) {
		const hitBlock = this.blockers.find(block => oldCount >= block.startFlick && oldCount < block.endFlick);
		const crushedBlocks = [];
		if (hitBlock) {
			const now = performance.now();
			hitBlock.hitCount = clamp(newCount - hitBlock.startFlick, 0, hitBlock.hitCost);
			hitBlock.lastHitMs = now;
			this.addLocalDust(hitBlock.x, hitBlock.y, 4 + hitBlock.hitCost, hitBlock.light || hitBlock.color);
			if (newCount >= hitBlock.endFlick && !this.brokenBlockers.has(hitBlock.id)) {
				this.brokenBlockers.add(hitBlock.id);
				hitBlock.crushedAtMs = now;
				crushedBlocks.push(hitBlock);
				this.feedbackBreak();
				this.addBreakBurst(hitBlock);
				this.logEvent("candy_crush", {
					currentCoin: this.currentCoinIndex + 1,
					currentRatio: this.currentRatio,
					breakAtProgress: hitBlock.breakAt,
					progressTowardCurrentCoin: progress,
					blockerId: hitBlock.id,
					candyColor: hitBlock.family ? hitBlock.family.name : "",
					candyDifficulty: hitBlock.difficulty || 0,
					hitCost: hitBlock.hitCost
				});
			}
		}
		this.lastBlockerProgress = progress;
		return { hitBlock, crushedBlocks };
	}

	dropCoin(result) {
		const now = performance.now();
		this.pendingCoinDrop = null;
		if (this.isMeasured) this.completedRatios.push(this.currentRatio);
		if (this.coinBody) {
			this.coinBody.x = 0.5;
			this.coinBody.y = 0.86;
			this.coinBody.homeX = 0.5;
			this.coinBody.homeY = 0.86;
			this.coinBody.vx = 0;
			this.coinBody.vy = 0;
		}
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
		this.body.textContent = "A new coin is trapped in the candy blocks.";
		this.statusLine.textContent = this.isMeasured ? "Shake to drop the coin." : "Keep practicing.";
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
		this.quitButton.classList.add("hidden");
		this.secondaryButton.classList.add("hidden");
		this.simulateButton.classList.add("hidden");
		this.sampleDots.classList.add("hidden");
		this.kicker.textContent = "Measured session";
		this.title.textContent = "Ready";
		this.body.textContent = "The measured run starts easy. Each next coin takes more valid flicks.";
		this.primaryButton.textContent = "Start session";
		this.primaryButton.disabled = false;
		this.primaryButton.classList.remove("hidden");
		this.statusLine.textContent = `Schedule: ${this.schedule.join(", ")}.`;
		this.meter.style.width = "0%";
		localStorage.setItem(STORAGE_KEYS.tutorialComplete, "true");
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
		this.pendingCoinDrop = null;
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
		this.panel.classList.remove("compact", "hidden", "warning");
		this.kicker.textContent = "Complete";
		this.title.textContent = "Counting coins";
		this.body.textContent = "Your collected coins are being counted.";
		this.primaryButton.textContent = "PLAY AGAIN";
		this.primaryButton.disabled = false;
		this.primaryButton.classList.remove("hidden");
		this.secondaryButton.textContent = "Menu";
		this.secondaryButton.disabled = false;
		this.secondaryButton.classList.remove("hidden");
		this.simulateButton.textContent = "Recalibrate";
		this.simulateButton.classList.remove("hidden");
		this.statusLine.textContent = `End reason: ${reason}. Payload status: preparing.`;
		this.meter.style.width = "0%";
		this.updateHud();
		Messaging.pushEvent("gameState", "end");
		Messaging.pushEvent("sessionPayload", payload);
		this.postSessionPayload(payload);
	}

	getUnfinishedProgressForEnd() {
		if ((this.coinDropping || this.pendingCoinDrop) && this.validInRatio >= this.currentRatio) {
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
			firstUseAt: this.firstUseAt,
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

	feedbackBreak() {
		if (navigator.vibrate) navigator.vibrate([18, 28, 22]);
		this.audio.crack();
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

	feedbackTimeoutWarning() {
		if (navigator.vibrate) navigator.vibrate([45, 40, 45]);
		this.audio.idle();
	}

	feedbackCoinFail() {
		if (navigator.vibrate) navigator.vibrate([90, 70, 120]);
		this.audio.tone(130, 0.18, "sine", 0.035);
		this.audio.tone(92, 0.28, "triangle", 0.026, 0.12);
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

	addCoinStream(x, y, count, progress) {
		const colors = progress > 0.68 ? ["#fef08a", "#a7f3d0", "#93c5fd", "#f0abfc"] : ["#fde68a", "#bfdbfe", "#fecdd3"];
		for (let i = 0; i < count; i++) {
			this.localEffects.push({
				type: "stream",
				x: x + (Math.random() - 0.5) * 0.05,
				y: y + (Math.random() - 0.5) * 0.035,
				vx: (Math.random() - 0.5) * 0.1,
				vy: -0.04 - Math.random() * 0.12,
				r: 0.008 + Math.random() * 0.012,
				life: 0.42 + Math.random() * 0.22,
				maxLife: 0.65,
				color: colors[Math.floor(Math.random() * colors.length)]
			});
		}
	}

	addLocalDust(x, y, count, color) {
		for (let i = 0; i < count; i++) {
			this.localEffects.push({
				type: "dust",
				x: x + (Math.random() - 0.5) * 0.08,
				y: y + (Math.random() - 0.5) * 0.05,
				vx: (Math.random() - 0.5) * 0.08,
				vy: (Math.random() - 0.5) * 0.08,
				r: 0.005 + Math.random() * 0.008,
				life: 0.32 + Math.random() * 0.24,
				maxLife: 0.6,
				color
			});
		}
	}

	addBreakBurst(block) {
		const colors = [block.crystal, "#fff7ed", "#fef08a", "#f9a8d4"];
		for (let i = 0; i < 26; i++) {
			this.localEffects.push({
				type: "shard",
				x: block.x + (Math.random() - 0.5) * block.w * 0.8,
				y: block.y + (Math.random() - 0.5) * block.h * 2,
				vx: (Math.random() - 0.5) * 0.42,
				vy: -0.24 - Math.random() * 0.42,
				r: 0.006 + Math.random() * 0.012,
				angle: Math.random() * TAU,
				spin: (Math.random() - 0.5) * 8,
				life: 0.62 + Math.random() * 0.36,
				maxLife: 1,
				color: colors[Math.floor(Math.random() * colors.length)]
			});
		}
	}

	addDissolveBurst(x, y) {
		const colors = ["#111820", "#2f2f35", "#52525b", "#fca5a5"];
		for (let i = 0; i < 48; i++) {
			this.localEffects.push({
				type: "dust",
				x: x + (Math.random() - 0.5) * 0.12,
				y: y + (Math.random() - 0.5) * 0.08,
				vx: (Math.random() - 0.5) * 0.22,
				vy: 0.04 + Math.random() * 0.24,
				r: 0.005 + Math.random() * 0.012,
				life: 0.7 + Math.random() * 0.35,
				maxLife: 1.05,
				color: colors[Math.floor(Math.random() * colors.length)]
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
		this.jarAngle = 0;
		this.checkCoinTimer(ms);
		this.updateCoinPhysics(dt, ms);
		this.updateLocalEffects(dt);
		if (this.pendingCoinDrop && !this.coinDropping && !this.coinFailing && ms >= this.pendingCoinDrop.dueMs) {
			const pending = this.pendingCoinDrop;
			this.pendingCoinDrop = null;
			this.dropCoin(pending.result);
		}
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
		if (this.coinFailing && !this.ended && ms - this.coinFailing.startMs >= this.coinFailing.durationMs) {
			this.coinFailing = null;
			this.endSession("coin_timeout");
		}
		if (this.countAnimation) {
			const t = clamp((ms - this.countAnimation.startMs) / this.countAnimation.durationMs, 0, 1);
			this.title.textContent = coinLabel(Math.round(this.countAnimation.coins * easeOut(t)));
			if (t >= 1) this.body.textContent = this.formatEndBody(this.countAnimation);
		}
	}

	checkCoinTimer(ms) {
		if (!this.isMeasured || this.ended || this.screen !== "playing" || this.coinDropping || this.coinFailing || this.pendingCoinDrop) return;
		if (!this.coinDeadlineMs) return;
		if (!this.coinWarningActive && ms >= this.coinWarningMs) {
			this.coinWarningActive = true;
			this.panel.classList.add("warning");
			this.feedbackTimeoutWarning();
			this.statusLine.textContent = "Hurry: a few seconds left.";
			this.logEvent("coin_timeout_warning", {
				currentCoin: this.currentCoinIndex + 1,
				currentRatio: this.currentRatio,
				validFlickCountWithinCurrentRatio: this.validInRatio,
				secondsRemaining: Math.max(0, Math.round((this.coinDeadlineMs - ms) / 1000))
			});
		}
		if (ms >= this.coinDeadlineMs) this.failCurrentCoin();
	}

	failCurrentCoin() {
		if (this.coinFailing || this.coinDropping || this.ended) return;
		const now = performance.now();
		this.coinFailing = {
			startMs: now,
			durationMs: 950
		};
		this.classifier.setMode("idle");
		this.panel.classList.add("warning");
		this.title.textContent = "Time";
		this.body.textContent = "The coin gets covered by candy blocks.";
		this.statusLine.textContent = "Trial ended.";
		this.feedbackCoinFail();
		if (this.coinBody) {
			this.addDissolveBurst(this.coinBody.x, this.coinBody.y);
			this.coinBody.vx = 0;
			this.coinBody.vy = 0;
		}
		this.logEvent("coin_timeout", {
			currentCoin: this.currentCoinIndex + 1,
			currentRatio: this.currentRatio,
			validFlickCountWithinCurrentRatio: this.validInRatio,
			totalValidFlickCount: this.totalValidFlicks
		});
	}

	updateCoinPhysics(dt, ms) {
		if (!this.coinBody || this.coinDropping || this.coinFailing || this.ended || this.screen !== "playing") return;
		const coin = this.coinBody;
		const progress = this.currentRatio ? clamp(this.validInRatio / this.currentRatio, 0, 1) : 0;
		const stepCount = 3;
		const step = dt / stepCount;
		for (let i = 0; i < stepCount; i++) {
			let targetX = coin.homeX == null ? coin.x : coin.homeX;
			let targetY = coin.homeY == null ? coin.y : coin.homeY;
			let spring = 8.6;
			if (coin.target && ms <= coin.target.untilMs) {
				targetX = coin.target.x;
				targetY = coin.target.y;
				spring = 15.2;
			}
			else {
				coin.target = null;
			}
			coin.vx += (targetX - coin.x) * spring * step;
			coin.vy += (targetY - coin.y) * spring * step;
			const drag = Math.pow(0.2, step);
			coin.vx *= drag;
			coin.vy *= drag;
			coin.spin *= Math.pow(0.34, step);
			coin.x += coin.vx * step;
			coin.y += coin.vy * step;
			coin.rotation += coin.spin * step;
			this.resolveCoinWalls(coin);
			this.resolveCoinBlockers(coin, progress, ms);
		}

	}

	resolveCoinWalls(coin) {
		const top = 0.13;
		const bottom = 0.86;
		if (coin.y - coin.r < top) {
			coin.y = top + coin.r;
			coin.vy = Math.abs(coin.vy) * 0.42;
		}
		if (coin.y + coin.r > bottom) {
			coin.y = bottom - coin.r;
			coin.vy = -Math.abs(coin.vy) * 0.38;
			coin.vx += (0.5 - coin.x) * 0.35;
		}

		const bounds = this.getBottleInnerBounds(coin.y);
		if (coin.x - coin.r < bounds.left) {
			coin.x = bounds.left + coin.r;
			coin.vx = Math.abs(coin.vx) * 0.46;
			coin.spin += 0.8;
		}
		if (coin.x + coin.r > bounds.right) {
			coin.x = bounds.right - coin.r;
			coin.vx = -Math.abs(coin.vx) * 0.46;
			coin.spin -= 0.8;
		}
	}

	resolveCoinBlockers(coin, progress, ms) {
		for (const block of this.blockers) {
			if (!this.isBlockerSolid(block, progress)) continue;
			const dx = coin.x - block.x;
			const dy = coin.y - block.y;
			const halfW = block.hw + coin.r * 0.82;
			const halfH = block.hh + coin.r * 0.82;
			if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;

			const overlapX = halfW - Math.abs(dx);
			const overlapY = halfH - Math.abs(dy);
			let nx = 0;
			let ny = 0;
			if (overlapX < overlapY) {
				nx = dx >= 0 ? 1 : -1;
				coin.x += nx * overlapX * 0.9;
				coin.vx = Math.abs(coin.vx) * nx * (0.62 + block.difficulty * 0.18);
				coin.vy *= 0.72;
			}
			else {
				ny = dy >= 0 ? 1 : -1;
				coin.y += ny * overlapY * 0.9;
				coin.vy = Math.abs(coin.vy) * ny * (0.58 + block.difficulty * 0.16);
				coin.vx *= 0.78;
			}
			coin.spin += (coin.vx - coin.vy) * (0.8 + block.difficulty * 0.5);
			if (ms - (block.lastDustMs || 0) > 90) {
				block.lastDustMs = ms;
				this.addLocalDust(
					block.x + nx * block.hw * 0.8,
					block.y + ny * block.hh * 0.8,
					5,
					block.light || block.color
				);
			}
		}
	}

	updateLocalEffects(dt) {
		for (const effect of this.localEffects) {
			effect.life -= dt;
			effect.x += effect.vx * dt;
			effect.y += effect.vy * dt;
			effect.vy += (effect.type === "shard" ? 0.44 : 0.18) * dt;
			effect.vx *= Math.pow(0.32, dt);
			effect.vy *= Math.pow(0.42, dt);
			if (typeof effect.angle === "number") effect.angle += (effect.spin || 0) * dt;
		}
		this.localEffects = this.localEffects.filter(effect => effect.life > 0);
	}

	formatEndBody(outcome) {
		if (!outcome.unfinishedRatio) return `You shook out ${coinLabel(outcome.coins)}. All scheduled coins are done.`;
		return `You shook out ${coinLabel(outcome.coins)}. Next coin: ${outcome.unfinishedFlicks} of ${outcome.unfinishedRatio} flicks.`;
	}

	getJarRect() {
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		const reservedTop = Math.max(48, h * 0.055);
		const reservedBottom = this.screen === "playing" ? Math.max(220, h * 0.24) : Math.max(260, h * 0.31);
		const jarH = Math.max(320, Math.min(h - reservedTop - reservedBottom, h * 0.67, 760));
		const jarW = Math.max(230, Math.min(w * 0.78, jarH * 0.56, 420));
		return {
			x: (w - jarW) / 2,
			y: reservedTop,
			w: jarW,
			h: jarH
		};
	}

	getBottleInnerBounds(localY) {
		if (localY < 0.72) return { left: 0.14, right: 0.86 };
		if (localY < 0.82) {
			const t = easeInOut((localY - 0.72) / 0.1);
			return {
				left: lerp(0.14, 0.34, t),
				right: lerp(0.86, 0.66, t)
			};
		}
		return { left: 0.37, right: 0.63 };
	}

	getPileTarget(index) {
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		const spread = Math.min(w * 0.48, 280);
		const col = index % 7;
		const row = Math.floor(index / 7);
		let baseY = h - 56;
		if (this.panel && !this.panel.classList.contains("hidden")) {
			const rect = this.panel.getBoundingClientRect();
			if (rect.height > 0) baseY = Math.min(baseY, rect.top - 30);
		}
		return {
			x: w * 0.5 + (col - 3) * (spread / 7) + ((row % 2) - 0.5) * 16,
			y: Math.max(80, baseY - row * 14),
			scale: 0.58 + (index % 3) * 0.04,
			rotation: -0.55 + (index % 5) * 0.26
		};
	}

	getJarTransform(ms) {
		const jar = this.getJarRect();
		return {
			jar,
			cx: jar.x + jar.w / 2,
			cy: jar.y + jar.h / 2,
			angle: 0
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
		return this.localToScreen(jar.w * 0.5, jar.h * 0.925, ms);
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
		ctx.fillStyle = "#fbf7ef";
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "rgba(24, 33, 43, 0.06)";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h - 46, Math.min(w * 0.31, 220), 14, 0, 0, Math.PI * 2);
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
			ctx.save();
			this.bottlePath(ctx, jar.w, jar.h);
			ctx.clip();
			this.drawCandyField(ctx, jar.w, jar.h, progress, ms);
			this.drawLocalEffects(ctx, jar.w, jar.h);
			ctx.restore();
		}
		this.drawJarRim(ctx, jar.w, jar.h);
		if (this.phase === "calibration") this.drawCalibrationCue(ctx, jar.w, jar.h, ms);
		ctx.restore();
	}

	bottlePath(ctx, w, h) {
		ctx.beginPath();
		ctx.moveTo(w * 0.27, h * 0.075);
		ctx.lineTo(w * 0.73, h * 0.075);
		ctx.bezierCurveTo(w * 0.86, h * 0.2, w * 0.88, h * 0.52, w * 0.75, h * 0.76);
		ctx.quadraticCurveTo(w * 0.65, h * 0.83, w * 0.62, h * 0.885);
		ctx.lineTo(w * 0.62, h * 0.925);
		ctx.quadraticCurveTo(w * 0.62, h * 0.955, w * 0.55, h * 0.958);
		ctx.lineTo(w * 0.45, h * 0.958);
		ctx.quadraticCurveTo(w * 0.38, h * 0.955, w * 0.38, h * 0.925);
		ctx.lineTo(w * 0.38, h * 0.885);
		ctx.quadraticCurveTo(w * 0.35, h * 0.83, w * 0.25, h * 0.76);
		ctx.bezierCurveTo(w * 0.12, h * 0.52, w * 0.14, h * 0.2, w * 0.27, h * 0.075);
		ctx.closePath();
	}

	drawJar(ctx, w, h) {
		ctx.save();
		ctx.fillStyle = this.coinWarningActive ? "rgba(255, 236, 232, 0.7)" : "rgba(255, 255, 255, 0.58)";
		ctx.strokeStyle = "#111820";
		ctx.lineWidth = Math.max(4.5, w * 0.017);
		ctx.lineJoin = "round";
		this.bottlePath(ctx, w, h);
		ctx.fill();
		ctx.restore();
	}

	drawJarRim(ctx, w, h) {
		ctx.save();
		ctx.strokeStyle = "#111820";
		ctx.lineWidth = Math.max(4.5, w * 0.017);
		ctx.lineJoin = "round";
		this.bottlePath(ctx, w, h);
		ctx.stroke();

		ctx.fillStyle = this.coinWarningActive ? "#f4b5ad" : "#ffffff";
		ctx.strokeStyle = "#111820";
		ctx.lineWidth = Math.max(4, w * 0.013);
		ctx.beginPath();
		roundedRect(ctx, w * 0.25, h * 0.045, w * 0.5, h * 0.055, h * 0.012);
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = "#fbf7ef";
		ctx.strokeStyle = "#111820";
		ctx.lineWidth = Math.max(4, w * 0.013);
		ctx.beginPath();
		roundedRect(ctx, w * 0.36, h * 0.868, w * 0.28, h * 0.08, h * 0.018);
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	drawCoin(ctx, w, h, progress, ms) {
		const coin = this.coinBody;
		const x = coin ? coin.x * w : w * 0.5;
		let y = coin ? coin.y * h : lerp(h * 0.2, h * 0.8, easeOut(progress));
		const rotation = coin ? coin.rotation : 0;
		const failT = this.coinFailing ? clamp((ms - this.coinFailing.startMs) / this.coinFailing.durationMs, 0, 1) : 0;
		let alpha = 1;
		if (this.coinDropping) {
			alpha = 0;
		}
		y += failT * h * 0.05;
		const radius = (coin ? coin.r * w : Math.min(w, h) * 0.052) * (1 - failT * 0.36);
		let variant = "gold";
		if (failT > 0) variant = "dark";
		else if (this.coinWarningActive) variant = "warning";
		this.drawCoinShape(ctx, x, y, radius, rotation, alpha * (1 - failT * 0.72), variant);
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
		this.drawCoinShape(ctx, x, y, 28 * scale, this.coinDropping.spin * t, 1);
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
			this.drawCoinShape(ctx, x, y, 28 * scale, coin.rotation, alpha);
		}
	}

	drawCoinShape(ctx, x, y, r, rotation, alpha = 1, variant = "gold") {
		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.translate(x, y);
		ctx.rotate(rotation);
		ctx.fillStyle = variant === "dark" ? "#202126" : variant === "warning" ? "#ff7a4d" : "#ffbf32";
		ctx.strokeStyle = variant === "dark" ? "#08090b" : variant === "warning" ? "#9f2f25" : "#8f6619";
		ctx.lineWidth = Math.max(2.5, r * 0.12);
		ctx.beginPath();
		ctx.arc(0, 0, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.strokeStyle = variant === "dark" ? "rgba(255, 255, 255, 0.18)" : variant === "warning" ? "rgba(159, 47, 37, 0.55)" : "rgba(143, 102, 25, 0.55)";
		ctx.lineWidth = Math.max(2, r * 0.08);
		ctx.beginPath();
		ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
		ctx.stroke();
		ctx.fillStyle = variant === "dark" ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.42)";
		ctx.beginPath();
		ctx.arc(-r * 0.28, -r * 0.26, r * 0.16, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = variant === "dark" ? "rgba(255, 255, 255, 0.14)" : "rgba(115, 85, 27, 0.34)";
		ctx.lineWidth = Math.max(1.2, r * 0.045);
		ctx.beginPath();
		ctx.moveTo(-r * 0.18, -r * 0.02);
		ctx.quadraticCurveTo(0, r * 0.11, r * 0.22, -r * 0.04);
		ctx.stroke();
		ctx.restore();
	}

	drawCandySquare(ctx, tile, x, y, size, options = {}) {
		const damage = options.damage || 0;
		const alpha = options.alpha == null ? 1 : options.alpha;
		const fill = options.fill || tile.color;
		const stroke = options.stroke || tile.stroke || "#111820";
		const radius = Math.max(3, size * 0.16);

		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.translate(x, y);
		ctx.rotate(tile.angle || 0);
		ctx.fillStyle = fill;
		ctx.strokeStyle = stroke;
		ctx.lineWidth = Math.max(1.6, size * 0.08);
		ctx.lineJoin = "round";
		ctx.beginPath();
		roundedRect(ctx, -size * 0.5, -size * 0.5, size, size, radius);
		ctx.fill();
		ctx.stroke();

		ctx.globalAlpha = alpha * 0.3;
		ctx.fillStyle = tile.light || "rgba(255, 255, 255, 0.8)";
		ctx.beginPath();
		roundedRect(ctx, -size * 0.31, -size * 0.31, size * 0.62, size * 0.2, radius * 0.62);
		ctx.fill();

		if (options.hardness > 1) {
			const layers = Math.min(3, Math.round(options.hardness - 1));
			ctx.globalAlpha = alpha * 0.26;
			ctx.strokeStyle = tile.dark || stroke;
			ctx.lineWidth = Math.max(1, size * 0.045);
			for (let i = 0; i < layers; i++) {
				const offset = (i - (layers - 1) / 2) * size * 0.16;
				ctx.beginPath();
				ctx.moveTo(-size * 0.28 + offset, size * 0.24);
				ctx.lineTo(size * 0.22 + offset, -size * 0.24);
				ctx.stroke();
			}
		}

		if (damage > 0.18) {
			ctx.globalAlpha = alpha * clamp(0.35 + damage * 0.55, 0, 0.9);
			ctx.strokeStyle = options.crackColor || "rgba(17, 24, 32, 0.62)";
			ctx.lineWidth = Math.max(1.1, size * 0.055);
			ctx.beginPath();
			ctx.moveTo(-size * 0.24, -size * 0.22);
			ctx.lineTo(-size * 0.03, size * 0.01);
			ctx.lineTo(-size * 0.18, size * 0.3);
			if (damage > 0.52) {
				ctx.moveTo(size * 0.11, -size * 0.3);
				ctx.lineTo(size * 0.28, size * 0.22);
			}
			ctx.stroke();
		}
		ctx.restore();
	}

	drawCandyField(ctx, w, h, progress, ms) {
		const pieces = this.tiles.map(tile => ({ type: "tile", y: tile.y, piece: tile }));
		if (this.coinBody && !this.coinDropping) {
			pieces.push({
				type: "coin",
				y: this.coinBody.y,
				piece: this.coinBody
			});
		}
		for (const block of this.blockers) {
			const crushedAge = block.crushedAtMs ? ms - block.crushedAtMs : Infinity;
			const crushT = clamp(crushedAge / 220, 0, 1);
			const damage = this.brokenBlockers.has(block.id) ? 1 : this.getBlockerDamage(block, progress);
			if (damage < 0.995 || crushT < 1) pieces.push({ type: "blocker", y: block.y, piece: block, damage, crushT });
		}
		pieces.sort((a, b) => a.y - b.y || (a.type === "coin" ? 1 : 0) - (b.type === "coin" ? 1 : 0));
		for (const item of pieces) {
			if (item.type === "tile") {
				const tile = item.piece;
				const x = tile.x * w;
				const y = tile.y * h;
				this.drawCandySquare(ctx, tile, x, y, tile.size * w, {
					alpha: 0.94,
					fill: tile.color,
					stroke: tile.stroke
				});
				continue;
			}
			if (item.type === "coin") {
				this.drawCoin(ctx, w, h, progress, ms);
				continue;
			}
			const block = item.piece;
			const damage = item.damage;
			const crushT = item.crushT || 0;
			const loosen = easeOut(damage);
			const pulseAge = block.hitPulseMs ? ms - block.hitPulseMs : Infinity;
			const pulse = pulseAge < 180 ? Math.sin((1 - pulseAge / 180) * Math.PI) : 0;
			const x = block.x * w;
			const y = block.y * h;
			const size = block.size * w * (1 - loosen * 0.08 - crushT * 0.36 + pulse * 0.08);
			const flash = damage > 0.68 ? 0.22 + Math.sin(ms / 42) * 0.1 : pulse * 0.22;
			const fill = damage > 0.72 ? block.light : damage > 0.42 ? block.crystal : block.color;
			this.drawCandySquare(ctx, {
				...block,
				angle: block.angle + loosen * 0.08 + crushT * 0.18 + pulse * 0.04
			}, x, y, size, {
				alpha: clamp(1 - damage * 0.28 - crushT * 0.82 + flash, 0, 1),
				fill,
				stroke: block.stroke,
				damage,
				hardness: block.hitCost,
				crackColor: "rgba(17, 24, 32, 0.72)"
			});
		}
	}

	drawLocalEffects(ctx, w, h) {
		for (const effect of this.localEffects) {
			const alpha = clamp(effect.life / effect.maxLife, 0, 1);
			if (alpha <= 0.01) continue;
			const x = effect.x * w;
			const y = effect.y * h;
			const r = effect.r * Math.min(w, h);
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.fillStyle = effect.color;
			ctx.strokeStyle = "rgba(17, 24, 32, 0.14)";
			ctx.lineWidth = Math.max(0.8, r * 0.12);
			ctx.translate(x, y);
			if (effect.type === "shard") {
				ctx.rotate(effect.angle || 0);
				ctx.beginPath();
				roundedRect(ctx, -r * 0.75, -r * 0.75, r * 1.5, r * 1.5, r * 0.28);
				ctx.fill();
				ctx.stroke();
			}
			else {
				ctx.beginPath();
				ctx.arc(0, 0, r, 0, TAU);
				ctx.fill();
			}
			ctx.restore();
		}
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
