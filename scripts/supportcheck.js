"use strict";
!function () {
	const missing = [];
	if (!document.createElement("canvas").getContext("2d")) missing.push("Canvas");
	if (!("noModule" in HTMLScriptElement.prototype)) missing.push("JavaScript Modules");
	if (!window.Promise || !window.fetch) missing.push("Modern JavaScript support");
	if (!window.C3_ModernJSSupport_OK) missing.push("Modern JavaScript syntax");

	if (missing.length) {
		const wrap = document.createElement("div");
		wrap.id = "notSupportedWrap";
		document.body.appendChild(wrap);
		const title = document.createElement("h2");
		title.id = "notSupportedTitle";
		title.textContent = "Software update needed";
		wrap.appendChild(title);
		const msg = document.createElement("p");
		msg.className = "notSupportedMessage";
		msg.innerHTML = "This content is not supported because this browser is missing required features.<br><br><em>Missing features: " + missing.join(", ") + "</em>";
		wrap.appendChild(msg);
	}
	else {
		window.C3_Is_Supported = true;
	}
}();
