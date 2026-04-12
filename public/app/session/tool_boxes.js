import { toolCallToText, toolPreviewLines } from "../core/tool_format.js";

const TOOL_EMOJI = { bash: "▶", read: "📄", write: "✏️", edit: "✏️", grep: "🔍", find: "📂", ls: "📁" };
const STRUCTURED_PREVIEW_LINES = 40;

function normalizeLines(text) {
	return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function countDiffStats(lines) {
	let additions = 0;
	let removals = 0;
	for (const line of lines) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions += 1;
		if (line.startsWith("-")) removals += 1;
	}
	return { additions, removals };
}

function diffLineClass(line) {
	if (line.startsWith("@@")) return "tool-diff-hunk";
	if (line.startsWith("+++") || line.startsWith("---")) return "tool-diff-file";
	if (line.startsWith("+")) return "tool-diff-add";
	if (line.startsWith("-")) return "tool-diff-del";
	return "tool-diff-ctx";
}

export function createToolBoxManager({ msgsEl, scrollToBottom }) {
	let toolBoxes = new Map();

	function clear() {
		toolBoxes = new Map();
	}

	function appendToolBox(toolCallId, toolName, status) {
		// Outer wrapper — collapsible card
		const wrapper = document.createElement("div");
		wrapper.className = `tool-box ${status} collapsed`;
		wrapper.dataset.toolCallId = toolCallId;

		// Collapsible header (same pattern as thinking-toggle which works)
		const header = document.createElement("div");
		header.className = "tool-header";
		header.innerHTML =
			`<span class="tool-header-icon">${TOOL_EMOJI[toolName] || "⚙"}</span>` +
			`<span class="tool-header-label">${toolName}</span>` +
			`<span class="tool-header-meta"></span>` +
			`<span class="tool-header-chev">▾</span>`;
		wrapper.appendChild(header);

		// Body — original tool-box content
		const body = document.createElement("div");
		body.className = "tool-body";

		const call = document.createElement("div");
		call.className = "tool-call";
		call.textContent = "";

		const out = document.createElement("div");
		out.className = "tool-out";
		out.textContent = "";

		body.appendChild(call);
		body.appendChild(out);
		wrapper.appendChild(body);
		msgsEl.appendChild(wrapper);

		// Collapse toggle
		header.addEventListener("click", () => {
			wrapper.classList.toggle("collapsed");
		});

		const entry = {
			box: wrapper,
			header,
			body,
			call,
			out,
			labelEl: header.querySelector(".tool-header-label"),
			metaEl: header.querySelector(".tool-header-meta"),
			toolName,
			previewLines: toolPreviewLines(toolName),
			expanded: false,
			callText: "",
			callArgs: null,
			fullText: "",
			result: null,
			images: [],
			startTime: Date.now(),
			status,
		};
		toolBoxes.set(toolCallId, entry);
		scrollToBottom();
		return entry;
	}

	function ensure(toolCallId, toolName, status = "pending") {
		return toolBoxes.get(toolCallId) || appendToolBox(toolCallId, toolName, status);
	}

	function renderToolBoxImages(toolCallId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;

		// Remove old image container if any
		const oldContainer = entry.box.querySelector(".tool-images");
		if (oldContainer) oldContainer.remove();

		if (!entry.images || entry.images.length === 0) return;

		const container = document.createElement("div");
		container.className = "tool-images";

		for (const img of entry.images) {
			const imgEl = document.createElement("img");
			imgEl.className = "tool-image";
			imgEl.alt = "Tool result image";
			imgEl.loading = "lazy";
			imgEl.decoding = "async";
			imgEl.src = `data:${img.mimeType};base64,${img.data}`;
			imgEl.addEventListener("click", () => {
				// Open full-size in new tab
				window.open(imgEl.src, "_blank");
			});
			container.appendChild(imgEl);
		}

		// Insert after the body
		entry.body.after(container);
	}

	function appendExpandToggle(toolCallId, entry, prefixText, label, nextExpanded) {
		const trunc = document.createElement("div");
		trunc.className = "tool-trunc";
		trunc.appendChild(document.createTextNode(prefixText));
		const key = document.createElement("span");
		key.className = "exp-key";
		key.textContent = label;
		key.addEventListener("click", (e) => {
			e.stopPropagation();
			entry.expanded = nextExpanded;
			renderToolBoxText(toolCallId);
		});
		trunc.appendChild(key);
		trunc.appendChild(document.createTextNode(")"));
		entry.out.appendChild(trunc);
	}

	function appendStructuredLine(entry, text, className = "") {
		const line = document.createElement("div");
		line.className = `tool-render-line${className ? ` ${className}` : ""}`;
		line.textContent = text ? text : "\u00a0";
		entry.out.appendChild(line);
	}

	function renderStructuredLines(toolCallId, entry, lines, options = {}) {
		const previewLines = options.previewLines ?? STRUCTURED_PREVIEW_LINES;
		const classifyLine = typeof options.classifyLine === "function" ? options.classifyLine : () => "";
		const truncated = lines.length > previewLines;

		if (!truncated) {
			for (const line of lines) appendStructuredLine(entry, line, classifyLine(line));
			return;
		}

		if (!entry.expanded) {
			for (const line of lines.slice(0, previewLines)) appendStructuredLine(entry, line, classifyLine(line));
			appendExpandToggle(toolCallId, entry, `… (${lines.length - previewLines} more lines, `, "expand", true);
			return;
		}

		for (const line of lines) appendStructuredLine(entry, line, classifyLine(line));
		appendExpandToggle(toolCallId, entry, "… (", "collapse", false);
	}

	function renderEditToolBoxText(toolCallId, entry) {
		if (!entry.box.classList.contains("success")) return false;
		const diff = entry.result?.details?.diff;
		if (typeof diff !== "string" || !diff.trim()) return false;

		const diffLines = normalizeLines(diff);
		const { additions, removals } = countDiffStats(diffLines);
		const summary = document.createElement("div");
		summary.className = "tool-change-summary";
		summary.textContent = `Diff · +${additions} / -${removals}`;
		entry.out.appendChild(summary);
		renderStructuredLines(toolCallId, entry, diffLines, {
			previewLines: Math.max(entry.previewLines, STRUCTURED_PREVIEW_LINES),
			classifyLine: diffLineClass,
		});
		return true;
	}

	function renderWriteToolBoxText(toolCallId, entry) {
		if (!entry.box.classList.contains("success")) return false;
		const content = entry.callArgs && typeof entry.callArgs.content === "string" ? entry.callArgs.content : null;
		if (typeof content !== "string") return false;

		const summary = document.createElement("div");
		summary.className = "tool-change-summary";
		entry.out.appendChild(summary);
		if (content.length === 0) {
			summary.textContent = "Written content · empty file";
			return true;
		}

		const contentLines = normalizeLines(content);
		summary.textContent = `Written content · ${contentLines.length} line${contentLines.length === 1 ? "" : "s"}`;
		renderStructuredLines(toolCallId, entry, contentLines, {
			previewLines: Math.max(entry.previewLines, STRUCTURED_PREVIEW_LINES),
			classifyLine: () => "tool-write-line",
		});
		return true;
	}

	function renderToolBoxText(toolCallId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;

		entry.out.innerHTML = "";
		if (entry.toolName === "edit" && renderEditToolBoxText(toolCallId, entry)) return;
		if (entry.toolName === "write" && renderWriteToolBoxText(toolCallId, entry)) return;

		const text = String(entry.fullText ?? "");
		const lines = text.split("\n");
		const truncated = lines.length > entry.previewLines;

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

	function setCall(toolCallId, toolName, args) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.callArgs = args;
		entry.callText = toolCallToText(toolName, args);
		entry.call.textContent = entry.callText;
		// Update header label with command summary
		if (entry.labelEl) entry.labelEl.textContent = entry.callText || toolName;
	}

	function setText(toolCallId, toolName, text) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.fullText = String(text ?? "");
		renderToolBoxText(toolCallId);
	}

	function setResult(toolCallId, toolName, result) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
		entry.result = result;
		renderToolBoxText(toolCallId);
	}

	function setImages(toolCallId, images) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.images = images;
		renderToolBoxImages(toolCallId);
	}

	function setStatus(toolCallId, status) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.status = status;
		entry.box.classList.remove("pending", "success", "error");
		entry.box.classList.add(status);
		// Show duration in header
		if (entry.metaEl && status !== "pending") {
			const ms = Date.now() - entry.startTime;
			entry.metaEl.textContent = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
		}
	}

	function remove(toolCallId) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
		entry.box.remove();
		toolBoxes.delete(toolCallId);
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
		setResult,
		setImages,
		setStatus,
		remove,
		hasPendingTools,
		markPendingToolsAborted,
	};
}
