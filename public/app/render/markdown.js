import { marked } from "../../lib/marked.esm.js";

// Configure marked for AI responses: GFM tables, breaks on single newlines
marked.setOptions({
	gfm: true,
	breaks: true,
});

// Simple HTML sanitizer — strip <script>, on* attributes, javascript: urls
function sanitize(html) {
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
		.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"');
}

export function renderMarkdown(target, text) {
	if (!text) {
		target.innerHTML = "";
		return;
	}
	const html = marked.parse(String(text));
	target.innerHTML = sanitize(html);
}

// Throttled rendering for streaming — renders at most once per animation frame
let pendingRenders = new Map();

export function renderMarkdownThrottled(target, text) {
	if (pendingRenders.has(target)) {
		// Update the pending text but don't schedule another frame
		pendingRenders.set(target, text);
		return;
	}
	pendingRenders.set(target, text);
	requestAnimationFrame(() => {
		const latestText = pendingRenders.get(target);
		pendingRenders.delete(target);
		if (latestText != null) {
			renderMarkdown(target, latestText);
		}
	});
}
