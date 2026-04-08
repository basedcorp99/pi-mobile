import { toolCallToText, toolPreviewLines } from "../core/tool_format.js";

const TOOL_EMOJI = { bash: "▶", read: "📄", write: "✏️", edit: "✏️", grep: "🔍", find: "📂", ls: "📁" };

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
			fullText: "",
			startTime: Date.now(),
		};
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

	function setCall(toolCallId, toolName, args) {
		const entry = ensure(toolCallId, toolName, "pending");
		entry.toolName = toolName;
		entry.previewLines = toolPreviewLines(toolName);
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

	function setStatus(toolCallId, status) {
		const entry = toolBoxes.get(toolCallId);
		if (!entry) return;
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
		setStatus,
		remove,
		hasPendingTools,
		markPendingToolsAborted,
	};
}
