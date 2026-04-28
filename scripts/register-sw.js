"use strict";
window.C3_RegisterSW = async function () {
	if (!navigator.serviceWorker || location.protocol.substr(0, 4) === "file") return;
	if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname)) {
		const registrations = await navigator.serviceWorker.getRegistrations();
		await Promise.all(registrations.map(registration => registration.unregister()));
		if (window.caches) {
			const keys = await caches.keys();
			await Promise.all(keys.filter(key => key.startsWith("shakeout-offline")).map(key => caches.delete(key)));
		}
		console.info("Service worker disabled for local Shake-Out development.");
		return;
	}
	try {
		const registration = await navigator.serviceWorker.register("sw.js", { scope: "./" });
		console.info("Registered service worker on " + registration.scope);
	}
	catch (err) {
		console.warn("Failed to register service worker: ", err);
	}
};

window.C3_RegisterSW();
