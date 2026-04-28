const pendingEvents = [];
const pendingCalls = {};

const postMsg = message => {
	if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(message);
	else window.postMessage(message, "*");
};

function flushAllPendingEvents() {
	try {
		const chunk = pendingEvents.splice(0);
		if (chunk.length === 0) return;
		postMsg(JSON.stringify(chunk));
	}
	catch (err) {
		console.error(err);
	}
}

function handleEvent(event) {
	if (!event.data || typeof event.data !== "string") return;
	let data;
	try {
		data = JSON.parse(event.data);
	}
	catch (err) {
		return;
	}
	if (Array.isArray(data)) return;
	if (!data.category) return;

	switch (data.category) {
		case "fnresult": {
			const pending = pendingCalls[data.id];
			if (!pending) return;
			delete pendingCalls[data.id];
			if (data.type === "resolve") pending.rs(data.result);
			else if (data.type === "reject") pending.rj(new Error(data.result));
			break;
		}
	}
}

export function pushEvent(type, data) {
	pendingEvents.push({ category: "event", type, data, ts: Date.now() });
}

export function callFunction(name, args) {
	const id = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random();
	return new Promise((rs, rj) => {
		pendingCalls[id] = { rs, rj };
		pendingEvents.push({ category: "fn", name, args, id, ts: Date.now() });
	});
}

globalThis.addEventListener("message", handleEvent);
setInterval(flushAllPendingEvents, 1000);
