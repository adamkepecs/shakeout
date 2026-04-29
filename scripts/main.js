import * as Messaging from "./project/messaging.js";

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const STORAGE_KEYS = {
	firstUseAt: "shakeOutFirstUseAt",
	savedCalibration: "shakeOutSavedCalibration",
	tutorialComplete: "shakeOutTutorialComplete"
};

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
		this.collectedCoins = [];
		this.countAnimation = null;
		this.coinKickMs = 0;
		this.jarImpulse = 0;
		this.jarAngle = 0;
		this.particles = [];
		this.sand = [];
		this.blockers = [];
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
		this.activeRatios = this.tutorialRatios;
		this.collectedCoins = [];
		this.countAnimation = null;
		this.classifier.setMode("game");
		this.panel.classList.add("compact");
		this.sampleDots.classList.add("hidden");
		this.kicker.textContent = "Demo";
		this.title.textContent = "Practice jar";
		this.body.textContent = "Shake one coin through the stuck sand.";
		this.primaryButton.classList.add("hidden");
		this.secondaryButton.classList.add("hidden");
		this.statusLine.textContent = "Practice with the 1, 2, 4 coin sequence.";
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
		this.countAnimation = null;
		this.collectedCoins = [];
		this.completedRatios = [];
		this.activeRatios = this.schedule;
		this.classifier.setMode("idle");
		this.panel.classList.remove("compact", "hidden");
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
		this.coinKickMs = 0;
		this.sand = this.makeSand(index, ratio);
		this.blockers = this.makeBlockers(index, ratio);
		this.addParticles(10, "#e8c9a7");
		this.updateHud();
	}

	makeSand(index, ratio) {
		const count = clamp(105 + Math.ceil(Math.log2(ratio + 1)) * 12 + index * 3, 110, 220);
		const rand = seededRandom((index + 3) * 1777 + ratio * 3181);
		const colors = ["#ffd6a5", "#caffbf", "#bde0fe", "#ffc8dd", "#d7c6ff", "#fff1a8", "#b8f2e6"];
		const sand = [];
		for (let i = 0; i < count; i++) {
			const band = Math.pow(rand(), 0.82);
			const nearPath = rand() < 0.42;
			sand.push({
				x: (nearPath ? 0.41 + rand() * 0.18 : 0.19 + rand() * 0.62),
				y: 0.24 + band * 0.53,
				r: 0.007 + rand() * 0.0085,
				color: colors[Math.floor(rand() * colors.length)],
				wobble: rand() * 100,
				float: rand() * 0.7 + 0.35
			});
		}
		return sand;
	}

	makeBlockers(index, ratio) {
		const count = clamp(5 + Math.ceil(Math.log2(ratio + 1)) * 2 + Math.floor(index / 2), 5, 26);
		const rand = seededRandom((index + 5) * 2203 + ratio * 4441);
		const blockers = [];
		for (let i = 0; i < count; i++) {
			const t = count === 1 ? 0.5 : i / (count - 1);
			const side = i % 2 === 0 ? -1 : 1;
			blockers.push({
				x: 0.5 + side * (0.035 + rand() * 0.11) + (rand() - 0.5) * 0.06,
				y: 0.31 + t * 0.43 + (rand() - 0.5) * 0.055,
				r: 0.034 + rand() * 0.026,
				angle: rand() * Math.PI,
				wobble: rand() * 100,
				color: ["#6f4932", "#7f5234", "#8f603d", "#5e3d2c"][Math.floor(rand() * 4)],
				shape: Math.floor(rand() * 3)
			});
		}
		return blockers;
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
		this.coinKickMs = now;
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
		this.body.textContent = "A new coin is ready at the top.";
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
		if (!outcome.unfinishedRatio) return `You shook out ${outcome.coins} coins. All scheduled coins are done.`;
		return `You shook out ${outcome.coins} coins. Next coin: ${outcome.unfinishedFlicks} of ${outcome.unfinishedRatio} flicks.`;
	}

	getJarRect() {
		const w = this.width || window.innerWidth;
		const h = this.height || window.innerHeight;
		const reservedTop = Math.max(48, h * 0.055);
		const reservedBottom = this.screen === "playing" ? Math.max(178, h * 0.21) : Math.max(214, h * 0.25);
		const jarH = Math.max(330, Math.min(h - reservedTop - reservedBottom, h * 0.67, 760));
		const jarW = Math.max(230, Math.min(w * 0.84, jarH * 0.64, 460));
		return {
			x: (w - jarW) / 2,
			y: reservedTop,
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
		return this.localToScreen(jar.w * 0.5, jar.h * 0.92, ms);
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
		sky.addColorStop(0, "#f9f1e6");
		sky.addColorStop(0.48, "#eaf6f2");
		sky.addColorStop(1, "#f7d8bd");
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, w, h);
		ctx.fillStyle = "rgba(255, 184, 112, 0.12)";
		ctx.fillRect(0, h * 0.68, w, h * 0.32);
		ctx.fillStyle = "#c4dfd3";
		ctx.fillRect(0, h - 76, w, 76);
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
			this.drawCoinQueue(ctx, jar.w, jar.h, ms);
			this.drawSand(ctx, jar.w, jar.h, progress, ms);
			this.drawCoin(ctx, jar.w, jar.h, progress, ms);
			this.drawBlockers(ctx, jar.w, jar.h, progress, ms);
		}
		this.drawJarGloss(ctx, jar.w, jar.h);
		if (this.phase === "calibration") this.drawCalibrationCue(ctx, jar.w, jar.h, ms);
		ctx.restore();
	}

	drawJar(ctx, w, h) {
		ctx.save();
		ctx.fillStyle = "rgba(255, 255, 255, 0.48)";
		ctx.strokeStyle = "#18212b";
		ctx.lineWidth = Math.max(6, w * 0.018);
		ctx.beginPath();
		ctx.moveTo(w * 0.27, h * 0.075);
		ctx.lineTo(w * 0.73, h * 0.075);
		ctx.bezierCurveTo(w * 0.83, h * 0.12, w * 0.88, h * 0.21, w * 0.88, h * 0.34);
		ctx.lineTo(w * 0.88, h * 0.68);
		ctx.bezierCurveTo(w * 0.88, h * 0.78, w * 0.77, h * 0.83, w * 0.64, h * 0.84);
		ctx.lineTo(w * 0.64, h * 0.88);
		ctx.quadraticCurveTo(w * 0.64, h * 0.94, w * 0.56, h * 0.95);
		ctx.lineTo(w * 0.44, h * 0.95);
		ctx.quadraticCurveTo(w * 0.36, h * 0.94, w * 0.36, h * 0.88);
		ctx.lineTo(w * 0.36, h * 0.84);
		ctx.bezierCurveTo(w * 0.23, h * 0.83, w * 0.12, h * 0.78, w * 0.12, h * 0.68);
		ctx.lineTo(w * 0.12, h * 0.34);
		ctx.bezierCurveTo(w * 0.12, h * 0.21, w * 0.17, h * 0.12, w * 0.27, h * 0.075);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = "#ff9438";
		ctx.strokeStyle = "#18212b";
		ctx.lineWidth = Math.max(5, w * 0.015);
		ctx.beginPath();
		roundedRect(ctx, w * 0.26, h * 0.038, w * 0.48, h * 0.065, h * 0.018);
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = "#ff9438";
		ctx.strokeStyle = "#18212b";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h * 0.925, w * 0.18, h * 0.035, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = "#f9f1e6";
		ctx.beginPath();
		ellipsePath(ctx, w * 0.5, h * 0.925, w * 0.125, h * 0.018, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();

		ctx.strokeStyle = "rgba(24, 33, 43, 0.48)";
		ctx.lineWidth = Math.max(2, w * 0.008);
		for (let i = -4; i <= 4; i++) {
			const x = w * 0.5 + i * w * 0.037;
			ctx.beginPath();
			ctx.moveTo(x, h * 0.055);
			ctx.lineTo(x, h * 0.108);
			ctx.stroke();
		}

		ctx.strokeStyle = "rgba(24, 33, 43, 0.55)";
		ctx.lineWidth = Math.max(3, w * 0.01);
		ctx.beginPath();
		ctx.moveTo(w * 0.22, h * 0.19);
		ctx.bezierCurveTo(w * 0.18, h * 0.32, w * 0.19, h * 0.52, w * 0.19, h * 0.67);
		ctx.stroke();
		ctx.restore();
	}

	drawCoin(ctx, w, h, progress, ms) {
		const kickT = clamp((ms - this.coinKickMs) / 420, 0, 1);
		const hop = kickT < 1 ? Math.sin(kickT * Math.PI) * h * 0.04 : 0;
		const lane = Math.sin(ms / 230 + this.currentCoinIndex) * w * 0.025 + Math.sin(progress * Math.PI * 2) * w * 0.028;
		const x = w * 0.5 + lane + Math.sin(ms / 54) * this.jarImpulse * w * 0.011;
		const y = lerp(h * 0.205, h * 0.835, easeOut(progress)) - hop + Math.cos(ms / 170) * this.jarImpulse * h * 0.006;
		let alpha = 1;
		if (this.coinDropping) {
			alpha = 0;
		}
		this.drawCoinShape(ctx, x, y, Math.min(w, h) * 0.075, Math.sin(ms / 190) * 0.22 + progress * 1.9, alpha);
	}

	drawCoinQueue(ctx, w, h, ms) {
		const remaining = Math.max(0, this.activeRatios.length - this.currentCoinIndex - 1);
		ctx.save();
		ctx.globalAlpha = 0.92;
		ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
		ctx.strokeStyle = "rgba(24, 33, 43, 0.46)";
		ctx.lineWidth = Math.max(2, w * 0.007);
		ctx.beginPath();
		roundedRect(ctx, w * 0.25, h * 0.12, w * 0.5, h * 0.105, h * 0.03);
		ctx.fill();
		ctx.stroke();

		const shown = Math.min(5, remaining + 1);
		for (let i = 0; i < shown; i++) {
			const offset = (i - (shown - 1) / 2) * w * 0.075;
			const r = Math.min(w, h) * (i === 0 ? 0.035 : 0.028);
			const y = h * 0.17 + Math.sin(ms / 240 + i) * h * 0.004;
			this.drawCoinShape(ctx, w * 0.5 + offset, y, r, -0.1 + i * 0.08, 0.92 - i * 0.08);
		}

		ctx.strokeStyle = "rgba(24, 33, 43, 0.42)";
		ctx.lineWidth = Math.max(3, w * 0.009);
		ctx.beginPath();
		ctx.moveTo(w * 0.36, h * 0.235);
		ctx.quadraticCurveTo(w * 0.5, h * 0.285, w * 0.64, h * 0.235);
		ctx.stroke();
		ctx.restore();
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

	drawSand(ctx, w, h, progress, ms) {
		const clearLine = lerp(0.24, 0.8, easeOut(progress));
		for (let i = 0; i < this.sand.length; i++) {
			const grain = this.sand[i];
			const nearCoinPath = Math.abs(grain.x - 0.5) < 0.18 && grain.y < clearLine + 0.08;
			const push = nearCoinPath ? easeOut(progress) * grain.float : 0;
			const x = grain.x * w
				+ Math.sin(ms / 130 + grain.wobble) * (this.jarImpulse * 5 + push * 9)
				+ (grain.x < 0.5 ? -1 : 1) * push * w * 0.035;
			const y = grain.y * h
				+ Math.cos(ms / 145 + grain.wobble) * (this.jarImpulse * 4 + push * 6)
				+ push * h * 0.025;
			const r = grain.r * Math.min(w, h) * (nearCoinPath ? 0.9 : 1);

			ctx.save();
			ctx.globalAlpha = nearCoinPath ? 0.72 : 0.9;
			ctx.fillStyle = grain.color;
			ctx.strokeStyle = "rgba(24, 33, 43, 0.18)";
			ctx.lineWidth = Math.max(1, r * 0.18);
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			ctx.restore();
		}
	}

	drawBlockers(ctx, w, h, progress, ms) {
		const clearFloat = progress * (this.blockers.length + 0.8);
		for (let i = this.blockers.length - 1; i >= 0; i--) {
			const block = this.blockers[i];
			const damage = clamp(clearFloat - i, 0, 1);
			if (damage >= 0.985) continue;
			const loosen = easeOut(damage);
			const flicker = damage > 0.62 ? Math.sin(ms / 34 + i) * 0.1 : 0;
			const x = block.x * w + Math.sin(ms / 92 + block.wobble) * (this.jarImpulse * 5 + loosen * 11);
			const y = block.y * h + Math.cos(ms / 114 + block.wobble) * (this.jarImpulse * 4 + loosen * 6) + loosen * h * 0.014;
			const r = block.r * Math.min(w, h) * (1 - loosen * 0.17);

			ctx.save();
			ctx.globalAlpha = clamp(0.96 - damage * 0.48 + flicker, 0.2, 1);
			ctx.translate(x, y);
			ctx.rotate(block.angle + Math.sin(ms / 160 + i) * 0.12 + loosen * 0.55);
			ctx.fillStyle = damage > 0.68 ? "#d5aa76" : damage > 0.34 ? "#a47752" : block.color;
			ctx.strokeStyle = "#2b2119";
			ctx.lineWidth = Math.max(3, r * 0.16);
			ctx.beginPath();
			if (block.shape === 0) ellipsePath(ctx, 0, 0, r * 1.7, r * 0.88, 0, 0, Math.PI * 2);
			else if (block.shape === 1) roundedRect(ctx, -r * 1.22, -r * 0.86, r * 2.44, r * 1.72, r * 0.35);
			else {
				ctx.moveTo(-r * 1.28, -r * 0.22);
				ctx.quadraticCurveTo(-r * 0.68, -r * 1.12, r * 0.16, -r * 0.82);
				ctx.quadraticCurveTo(r * 1.34, -r * 0.42, r * 1.02, r * 0.56);
				ctx.quadraticCurveTo(r * 0.1, r * 1.18, -r * 1.08, r * 0.56);
				ctx.closePath();
			}
			ctx.fill();
			ctx.stroke();

			ctx.strokeStyle = damage > 0.16 ? "rgba(255, 244, 218, 0.78)" : "rgba(255, 244, 218, 0.28)";
			ctx.lineWidth = Math.max(2, r * 0.09);
			ctx.beginPath();
			ctx.moveTo(-r * 0.82, -r * 0.05);
			ctx.lineTo(-r * 0.28, r * 0.1);
			ctx.lineTo(r * 0.18, -r * 0.18);
			ctx.lineTo(r * 0.72, r * 0.04);
			ctx.stroke();

			if (damage > 0.54) {
				ctx.strokeStyle = "rgba(43, 33, 25, 0.72)";
				ctx.lineWidth = Math.max(2, r * 0.08);
				ctx.beginPath();
				ctx.moveTo(-r * 0.5, -r * 0.42);
				ctx.lineTo(-r * 0.08, -r * 0.06);
				ctx.lineTo(-r * 0.32, r * 0.34);
				ctx.moveTo(r * 0.16, -r * 0.32);
				ctx.lineTo(r * 0.44, r * 0.18);
				ctx.stroke();
			}
			ctx.restore();
		}
	}

	drawJarGloss(ctx, w, h) {
		ctx.save();
		ctx.globalAlpha = 0.42;
		ctx.strokeStyle = "white";
		ctx.lineWidth = Math.max(5, w * 0.016);
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(w * 0.73, h * 0.18);
		ctx.quadraticCurveTo(w * 0.8, h * 0.39, w * 0.74, h * 0.69);
		ctx.stroke();
		ctx.globalAlpha = 0.34;
		ctx.beginPath();
		ctx.moveTo(w * 0.28, h * 0.13);
		ctx.quadraticCurveTo(w * 0.22, h * 0.3, w * 0.23, h * 0.52);
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
