"use strict";
const OFFLINE_DATA_FILE = "offline.json";
const CACHE_NAME_PREFIX = "shakeout-offline";
const BROADCASTCHANNEL_NAME = "offline";
const broadcastChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCASTCHANNEL_NAME);

function postBroadcastMessage(type) {
	if (broadcastChannel) {
		setTimeout(() => broadcastChannel.postMessage({ type }), 1000);
	}
}

function cacheName(version) {
	return `${CACHE_NAME_PREFIX}-${self.registration.scope}-v${version}`;
}

async function updateCache() {
	const response = await fetch(OFFLINE_DATA_FILE, { cache: "no-store" });
	if (!response.ok) throw new Error("Unable to fetch offline.json");
	const data = await response.json();
	const name = cacheName(data.version);
	if (await caches.has(name)) {
		postBroadcastMessage("up-to-date");
		return;
	}

	const cache = await caches.open(name);
	const files = ["./", ...data.fileList];
	await cache.addAll(files);
	const keys = await caches.keys();
	await Promise.all(keys.filter(key => key.startsWith(CACHE_NAME_PREFIX) && key !== name).map(key => caches.delete(key)));
	postBroadcastMessage("offline-ready");
}

self.addEventListener("install", event => {
	event.waitUntil(updateCache().catch(err => console.warn("[SW] install cache failed", err)));
});

self.addEventListener("activate", event => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
	if (new URL(event.request.url).origin !== location.origin) return;
	event.respondWith(
		caches.keys()
			.then(keys => {
				const matching = keys.filter(key => key.startsWith(CACHE_NAME_PREFIX)).sort();
				return matching.length ? matching[matching.length - 1] : "";
			})
			.then(name => name ? caches.open(name) : null)
			.then(cache => cache ? cache.match(event.request).then(match => match || fetch(event.request)) : fetch(event.request))
	);
});
