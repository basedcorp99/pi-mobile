import { toolCallToText, toolPreviewLines } from "../core/tool_format.js";

const TOOL_ICONS = {
	bash:  "terminal",
	read:  "file-text",
	write: "file-plus",
	edit:  "file-edit",
	grep:  "search",
	find:  "folder-search",
	ls:    "folder",
};

function iconSvg(name) {
	const icons = {
		"terminal":      `<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>`,
		"file-text":     `<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>`,
		"file-plus":     `<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>`,
		"file-edit":     `<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 15l-2 2v-2h2z"/>`,
		"search":        `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
		"folder-search": `<path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/><circle cx="12" cy="13" r="3"/>`,
		"folder":        `<path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/>`,
		"tool":          `<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>`,
	};
	const d = icons[name] || icons["tool"];
	return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function statusDot(status) {
	if (status === "success") return `<span class="tool-status-dot success"></span>`;
	if (status === "error")   return `<span class="tool-status-dot error"></span>`;
	return `<span class="tool-status-dot pending"></span>`;
}

export function createToolBoxManager({ msgsEl, scrollToBottom }) {
	let toolBoxes = new Map();

	function clear() {
		toolBoxes = new Map();
	}

	function appendToolBox(toolCallId, toolName, status) {
		const box = document.createElement("div");
		box.className = `tool-card ${status}`;
		box.dataset.toolCallId = toolCallId;

		// Header row — always visible
		const header = document.createElement("div");
		header.className = "tool-card-header";
		const iconName = TOOL_ICONS[toolName] || "tool";
		header.innerHTML = `${iconSvg(iconName)}<span class="tool-card-summary"></span><span class="tool-card-meta"></span>${statusDot(status)}<svg class="tool-card-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;

		const summaryEl = header.querySelector(".tool-card-summary");
		const metaEl = header.querySelector(".tool-card-meta");
		const dotEl = header.querySelector(".tool-status-dot");

		// Body — collapsible
		const body = document.createElement("div");
		body.className = "tool-card-body";

		const call = document.createElement("div");
		call.className = "tool-call";

		const out = document.createElement("div");
		out.className = "tool-out";

		body.appendChild(call);
		body.appendChild(out);

		box.appendChild(header);
		box.appendChild(body);
		msgsEl.appendChild(box);

		const entry = {
			box,
			header,
			body,
			call,
			out,
			summaryEl,
			metaEl,
			dotEl,
			toolName,
			previewLines: toolPreviewLines(toolName),
			collapsed: false,
			expanded: false,  // for full text expand within body
			callText: "",
			fullText: "",
			startTime: Date.now(),
		};

		// Toggle collapse on header click
		header.addEventListener("click", () => {
			entry.collapsed = !entry.collapsed;
			body.hidden = entry.collapsed;
			box.classList.toggle("collapsed", entry.collapsed);
		});

		toolBoxes.set(toolCallId, entry);
		scrollToBottom();
		return entry;
	}

	function ensure(toolCallId, toolName, status = "pending") {
		return toolBoxes.get(toolCallId) || appendToolBox(toolCallId, toolName, status);
	}

	function renderToolBoxText(toolCallId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;

		const text = String(entry.fullText ?? "");
		const lines = text.split("\n");
		const truncated = lines.length > entry.previewLines;

		entry.out.innerHTML = "";
		if (!truncated) {
			entry.out.textContent = text;
			return;
		}

		const isBash = entry.toolName === "bash";
		const remaining = Math.max(0, lines.length - entry.previewLines);
		const preview = isBash ? lines.slice(-entry.previewLines).join("\n") : lines.slice(0, entry.previewLines).join("\n");

		const trunc = document.createElement("div");
		trunc.className = "tool-trunc";

		if (!entry.expanded) {
			const label = isBash ? `${remaining} earlier lines` : `${remaining} more lines`;
			trunc.appendChild(document.createTextNode(`… (${label}, `));
			const key = document.createElement("span");
			key.className = "exp-key";
			key.textContent = "expand";
			key.addEventListener("click", (e) => { e.stopPropagation(); entry.expanded = true; renderToolBoxText(toolCallId); });
			trunc.appendChild(key);
			trunc.appendChild(document.createTextNode(")"));
			if (isBash) entry.out.appendChild(trunc);
			const previewEl = document.createElement("div");
			previewEl.textContent = preview;
			entry.out.appendChild(previewEl);
			if (!isBash) entry.out.appendChild(trunc);
			return;
		}

		const full = document.createElement("div");
		full.textContent = text;
		entry.out.appendChild(full);
		const key = document.createElement("span");
		key.className = "exp-key";
		key.textContent = "collapse";
		key.addEventListener("click", (e) => { e.stopPropagation(); entry.expanded = false; renderToolBoxText(toolCallId); });
		trunc.appendChild(document.createTextNode("… ("));
		trunc.appendChild(key);
		trunc.appendChild(document.createTextNode(")"));
		entry.out.appendChild(trunc);
	}

	function updateSummary(entry) {
		if (entry.summaryEl) entry.summaryEl.textContent = entry.callText || entry.toolName;
	}

	function updateDuration(entry, status) {
		if (!entry.metaEl) return;
		if (status === "pending") {
			entry.metaEl.textContent = "";
		} else {
			const ms = Date.now() - entry.startTime;
			entry.metaEl.textContent = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
		}
	}

	function setCall(toolCallId, toolName, args) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.callText = toolCallToText(toolName, args);
		entry.call.textContent = entry.callText;
		updateSummary(entry);
	}

	function setText(toolCallId, toolName, text) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.fullText = String(text ?? "");
		renderToolBoxText(toolCallId);
	}

	function setStatus(toolCallId, status) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.box.classList.remove("pending", "success", "error");
		entry.box.classList.add(status);
		// Update status dot
		if (entry.dotEl) {
			entry.dotEl.className = `tool-status-dot ${status}`;
		}
		updateDuration(entry, status);
	}

	function hasPendingTools() {
		for (const entry of toolBoxes.values()) {
			if (entry.box.classList.contains("pending")) return true;
		}
		return false;
	}

	function markPendingToolsAborted(message) {
		for (const [toolCallId, entry] of toolBoxes.entries()) {
			if (!entry.box.classList.contains("pending")) continue;
			setStatus(toolCallId, "error");
			setText(toolCallId, entry.toolName, message);
		}
	}

	return {
		clear,
		ensure,
		has: (toolCallId) => toolBoxes.has(toolCallId),
		setCall,
		setText,
		setStatus,
		hasPendingTools,
		markPendingToolsAborted,
	};
}
