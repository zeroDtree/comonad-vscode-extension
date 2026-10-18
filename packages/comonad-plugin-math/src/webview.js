import katex from 'katex';
import { installCopyHandler } from './copy.js';

/**
 * The browser half of the math plugin. It is loaded before `chat.js`, defines the renderer hook the
 * core calls, and installs the selection-copy handler. It never calls `acquireVsCodeApi`: the chat
 * script owns that bridge, and this script only needs the DOM.
 */

const cache = new Map();

function render(tex, display) {
	const key = (display ? 'D:' : 'I:') + tex;
	if (cache.has(key)) {
		return cache.get(key);
	}
	let html = null;
	try {
		html = katex.renderToString(tex, {
			displayMode: display,
			throwOnError: true,
			strict: 'ignore',
			trust: false,
		});
	} catch {
		// Malformed or still-streaming TeX stays the literal source in the transcript.
		html = null;
	}
	if (cache.size >= 500) {
		cache.clear();
	}
	cache.set(key, html);
	return html;
}

window.__comonadMath = { render };
installCopyHandler();
