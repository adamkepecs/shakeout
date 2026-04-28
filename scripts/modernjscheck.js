"use strict";
try {
	new Function("class A{#x=1;async y(){return await Promise.resolve(this.#x)}};import('data:text/javascript,export default 1')");
	window.C3_ModernJSSupport_OK = true;
}
catch (err) {
	window.C3_ModernJSSupport_OK = false;
}
