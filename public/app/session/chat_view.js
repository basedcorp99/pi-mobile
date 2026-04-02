import { safeRandomUUID } from "../core/uuid.js";
import { safeStringify } from "../core/stringify.js";
import { toolResultToText } from "../core/tool_format.js";
import { renderMarkdown } from "../render/markdown.js";
import { extractTextContent, parseAssistantContent } from "./content.js";
import { parseSubagentSlashMessage } from "./subagent_slash.js";
import { createToolBoxManager } from "./tool_boxes.js";

function normalizeUserContent(content) {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block && typeof block === "object" && typeof block.type === "string");
}

function summarizeUserContent(content) {
	const blocks = normalizeUserContent(content);
	return blocks
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") {
				return `t:${block.text}`;
			}
			if (block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string") {
				return `i:${block.mimeType}:${block.data.length}`;
			}
			return `b:${block.type}`;
		})
		.join("|");
}

function renderUserMessageContent(el, content) {
	const blocks = normalizeUserContent(content);
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
	const images = blocks.filter((block) => block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string");

	if (text.trim()) {
		const textEl = document.createElement("div");
		textEl.className = "user-msg-text";
		textEl.textContent = text;
		el.appendChild(textEl);
	}

	if (images.length > 0) {
		const gallery = document.createElement("div");
		gallery.className = "user-msg-images";
		for (const image of images) {
			const img = document.createElement("img");
			img.className = "user-msg-image";
			img.alt = "attached image";
			img.loading = "lazy";
			img.src = `data:${image.mimeType};base64,${image.data}`;
			gallery.appendChild(img);
		}
		el.appendChild(gallery);
	}

	if (!text.trim() && images.length === 0) {
		const empty = document.createElement("div");
		empty.className = "user-msg-text";
		empty.textContent = "(empty message)";
		el.appendChild(empty);
	}
}

export function createChatView({ msgsEl, isPhoneLikeFn }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking }
	let appendedUserMessageKeys = new Set();
	let appendedAssistantMessageKeys = new Set();
	let optimisticUserSummaries = [];
	let subagentCards = new Map();
	let suppressAutoScroll = false;

	function scrollToBottom() {
		if (suppressAutoScroll) return;
		msgsEl.scrollTop = msgsEl.scrollHeight;
	}

	function isNearBottom(el, thresholdPx = 80) {
		const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
		return remaining <= thresholdPx;
	}

	function clear() {
		msgsEl.innerHTML = "";
		const spacer = document.createElement("div");
		spacer.className = "msgs-spacer";
		msgsEl.appendChild(spacer);
		currentAssistant = null;
		tools.clear();
		appendedUserMessageKeys = new Set();
		appendedAssistantMessageKeys = new Set();
		optimisticUserSummaries = [];
		subagentCards = new Map();
	}

	function appendAssistantBlock() {
		const block = document.createElement("div");
		block.className = "assistant-block";

		const thinking = document.createElement("div");
		thinking.className = "thinking-text";
		thinking.style.display = "none";

		const text = document.createElement("div");
		text.className = "md";
		text.textContent = "";

		block.appendChild(thinking);
		block.appendChild(text);
		msgsEl.appendChild(block);

		currentAssistant = { block, text, thinking, rawText: "", rawThinking: "" };
		return currentAssistant;
	}

	function ensureAssistantBlock() {
		return currentAssistant || appendAssistantBlock();
	}

	function appendUserMessage(content, opts = {}) {
		const el = document.createElement("div");
		el.className = "user-msg";
		renderUserMessageContent(el, content);

		const insertBeforeEl = opts.insertBefore instanceof HTMLElement ? opts.insertBefore : null;
		if (insertBeforeEl && insertBeforeEl.parentNode === msgsEl) {
			msgsEl.insertBefore(el, insertBeforeEl);
		} else {
			msgsEl.appendChild(el);
		}
		scrollToBottom();
	}

	function userMessageKey(msg, content) {
		const ts = msg && typeof msg.timestamp === "number" ? msg.timestamp : null;
		const summary = summarizeUserContent(content);
		if (ts !== null) return `u:${ts}:${summary}`;
		return `u:${summary}`;
	}

	function maybeAppendUserMessage(msg) {
		if (!msg || typeof msg !== "object") return;
		const content = msg.content;
		const key = userMessageKey(msg, content);
		if (appendedUserMessageKeys.has(key)) return;
		const summary = summarizeUserContent(content);
		const optimisticIdx = optimisticUserSummaries.findIndex((entry) => entry.summary === summary && Date.now() - entry.createdAt < 30000);
		appendedUserMessageKeys.add(key);
		if (appendedUserMessageKeys.size > 200) appendedUserMessageKeys.clear();
		if (optimisticIdx !== -1) {
			optimisticUserSummaries.splice(optimisticIdx, 1);
			return;
		}

		const assistant = currentAssistant;
		const assistantIsEmpty = Boolean(assistant && assistant.rawText === "" && assistant.rawThinking === "");
		const insertBeforeEl = assistantIsEmpty && assistant.block ? assistant.block : null;
		appendUserMessage(content, { insertBefore: insertBeforeEl });
	}

	function appendNotice(text, kind = "info") {
		const stick = isNearBottom(msgsEl);
		const block = document.createElement("div");
		block.className = "assistant-block";
		const el = document.createElement("div");
		el.className = `notice-text ${kind}`;
		el.textContent = text;
		block.appendChild(el);
		msgsEl.appendChild(block);
		if (stick) scrollToBottom();
	}

	function assistantMessageKey(msg) {
		const parsed = parseAssistantContent(msg?.content);
		const ts = msg && typeof msg.timestamp === "number" ? msg.timestamp : null;
		const summary = [parsed.thinking || "", parsed.text || "", parsed.toolCalls.length].join("|");
		return ts !== null ? `a:${ts}:${summary}` : `a:${summary}`;
	}

	function renderAssistantMessage(msg) {
		const parsed = parseAssistantContent(msg?.content);
		for (const call of parsed.toolCalls) {
			tools.setCall(call.id, call.name, call.arguments);
		}
		const hasRenderableAssistantContent = Boolean(parsed.text || parsed.thinking);
		const block = currentAssistant || (hasRenderableAssistantContent ? appendAssistantBlock() : null);
		if (block) {
			if (parsed.thinking) {
				if (!block.rawThinking || parsed.thinking.length >= block.rawThinking.length) {
					block.rawThinking = parsed.thinking;
				}
				block.thinking.style.display = "";
				block.thinking.classList.add("shown");
				block.thinking.textContent = block.rawThinking;
			}
			if (parsed.text && (!block.rawText || parsed.text.length >= block.rawText.length)) {
				block.rawText = parsed.text;
			}
			renderMarkdown(block.text, block.rawText);
		}
		return { block, parsed };
	}

	function maybeAppendAssistantMessage(msg) {
		if (!msg || typeof msg !== "object") return null;
		const key = assistantMessageKey(msg);
		if (appendedAssistantMessageKeys.has(key)) return null;
		appendedAssistantMessageKeys.add(key);
		if (appendedAssistantMessageKeys.size > 200) appendedAssistantMessageKeys.clear();
		return renderAssistantMessage(msg);
	}

	function upsertSubagentCard(message) {
		const data = parseSubagentSlashMessage(message);
		if (!data) return false;

		let entry = subagentCards.get(data.requestId);
		if (!entry) {
			const box = document.createElement("div");
			const title = document.createElement("div");
			title.className = "tool-title";
			const meta = document.createElement("div");
			meta.className = "subagent-meta";
			const body = document.createElement("div");
			body.className = "md subagent-body";
			box.appendChild(title);
			box.appendChild(meta);
			box.appendChild(body);
			msgsEl.appendChild(box);
			entry = { box, title, meta, body };
			subagentCards.set(data.requestId, entry);
		}

		entry.box.className = `tool-box subagent-result ${data.status}`;
		entry.title.textContent = data.title;
		if (data.summary) {
			entry.meta.textContent = data.summary;
			entry.meta.style.display = "";
		} else {
			entry.meta.textContent = "";
			entry.meta.style.display = "none";
		}
		const stick = isNearBottom(msgsEl);
		renderMarkdown(entry.body, data.body || "(no output)");
		if (stick) scrollToBottom();
		return true;
	}

	const tools = createToolBoxManager({ msgsEl, scrollToBottom });

	function renderHistory(messages) {
		const prev = suppressAutoScroll;
		suppressAutoScroll = true;
		try {
		for (const m of messages) {
			if (!m || typeof m !== "object") continue;
			if (m.role === "user") {
				maybeAppendUserMessage(m);
			} else if (m.role === "assistant") {
				maybeAppendAssistantMessage(m);
				currentAssistant = null;
			} else if (m.role === "toolResult") {
				const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : safeRandomUUID();
				const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
				const isError = Boolean(m.isError);
				const contentText = extractTextContent(m.content);
				if (!tools.has(toolCallId)) {
					tools.ensure(toolCallId, toolName, isError ? "error" : "success");
				}
				tools.setStatus(toolCallId, isError ? "error" : "success");
				tools.setText(toolCallId, toolName, contentText || safeStringify(m.content));
			} else if (m.customType || m.role === "custom") {
				if (upsertSubagentCard(m)) continue;
				// Custom extension messages (e.g. subagent results)
				const text = extractTextContent(m.content) || m.content || "";
				if (text && m.display !== false) {
					appendNotice(typeof text === "string" ? text : safeStringify(text));
				}
			}
		}
		} finally {
			suppressAutoScroll = prev;
		}
	}

	function renderReleased({ cliCommand }) {
		clear();

		const block = document.createElement("div");
		block.className = "assistant-block";
		const t = document.createElement("div");
		t.className = "thinking-text";
		t.textContent = "Released. Safe to resume in native CLI.";
		block.appendChild(t);

		if (cliCommand) {
			const cmdBox = document.createElement("div");
			cmdBox.className = "tool-box success";
			const title = document.createElement("div");
			title.className = "tool-title";
			title.textContent = "CLI resume:";
			const out = document.createElement("div");
			out.className = "tool-out";
			out.textContent = cliCommand;
			cmdBox.appendChild(title);
			cmdBox.appendChild(out);
			msgsEl.appendChild(cmdBox);
		}

		msgsEl.appendChild(block);
		scrollToBottom();
	}

	function handleAgentEvent(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "turn_start") {
			ensureAssistantBlock();
			return;
		}

		if (event.type === "agent_end") {
			if (Array.isArray(event.messages)) {
				for (const message of event.messages) {
					if (message?.role === "assistant") maybeAppendAssistantMessage(message);
					if (message && (message.customType || message.role === "custom")) upsertSubagentCard(message);
				}
			}
			currentAssistant = null;
			return;
		}

		if (event.type === "message_start") {
			if (event.message && event.message.role === "user") {
				maybeAppendUserMessage(event.message);
				return;
			}
			if (event.message && event.message.role === "assistant") {
				ensureAssistantBlock();
			}
			// Custom extension messages (subagent output etc.)
			if (event.message && (event.message.customType || event.message.role === "custom")) {
				if (upsertSubagentCard(event.message)) return;
				const text = extractTextContent(event.message.content) || event.message.content || "";
				if (text && event.message.display !== false) {
					appendNotice(typeof text === "string" ? text : safeStringify(text));
				}
			}
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (!update || typeof update.type !== "string") return;

			const block = ensureAssistantBlock();
			if ((update.type === "thinking_delta" || update.type === "reasoning_delta") && typeof update.delta === "string") {
				block.rawThinking += update.delta;
				block.thinking.style.display = "";
				block.thinking.classList.add("shown");
				block.thinking.textContent = block.rawThinking;
			} else if (update.type === "text_delta" && typeof update.delta === "string") {
				block.rawText += update.delta;
				block.text.textContent = block.rawText;
			} else {
				return;
			}
			if (isNearBottom(msgsEl)) scrollToBottom();
			return;
		}

		if (event.type === "message_end") {
			const msg = event.message;
			if (!msg) return;
			if (msg.role === "user") maybeAppendUserMessage(msg);
			if (msg.role === "assistant") {
				appendedAssistantMessageKeys.add(assistantMessageKey(msg));
				if (appendedAssistantMessageKeys.size > 200) appendedAssistantMessageKeys.clear();
				const rendered = renderAssistantMessage(msg);
				const block = rendered?.block;

				const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
				if (stopReason === "aborted" || stopReason === "error") {
					const content = Array.isArray(msg.content) ? msg.content : [];
					const hasToolCalls = content.some((c) => c && typeof c === "object" && c.type === "toolCall");

					const abortMessage = "Operation aborted";
					const errMessage =
						stopReason === "aborted"
							? abortMessage
							: typeof msg.errorMessage === "string" && msg.errorMessage.trim()
								? `Error: ${msg.errorMessage.trim()}`
								: "Error";

					if (hasToolCalls) {
						tools.markPendingToolsAborted(stopReason === "aborted" ? abortMessage : errMessage);
					} else if (block) {
						const err = document.createElement("div");
						err.className = "notice-text error";
						err.textContent = stopReason === "aborted" ? abortMessage : errMessage;
						block.block.appendChild(err);
					} else {
						appendNotice(stopReason === "aborted" ? abortMessage : errMessage, "error");
					}
				}
				currentAssistant = null;
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			if (tools.has(event.toolCallId)) {
				tools.setStatus(event.toolCallId, "pending");
			} else {
				tools.ensure(event.toolCallId, event.toolName, "pending");
			}
			tools.setCall(event.toolCallId, event.toolName, event.args);
			tools.setText(event.toolCallId, event.toolName, "");
			return;
		}

		if (event.type === "tool_execution_update") {
			if (!tools.has(event.toolCallId)) return;
			const stick = isPhoneLikeFn() && isNearBottom(msgsEl);
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.partialResult));
			if (stick) scrollToBottom();
			return;
		}

		if (event.type === "tool_execution_end") {
			const stick = isPhoneLikeFn() && isNearBottom(msgsEl);
			if (!tools.has(event.toolCallId)) {
				tools.ensure(event.toolCallId, event.toolName, event.isError ? "error" : "success");
			}
			tools.setStatus(event.toolCallId, event.isError ? "error" : "success");
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.result));
			if (stick) scrollToBottom();
			return;
		}
	}

	return {
		clear,
		scrollToBottom,
		appendNotice,
		renderHistory,
		syncFromMessages: (messages) => {
			const wasNearBottom = isNearBottom(msgsEl);
			renderHistory(messages || []);
			if (wasNearBottom) scrollToBottom();
		},
		appendOptimisticUserMessage: (content) => {
			optimisticUserSummaries.push({ summary: summarizeUserContent(content), createdAt: Date.now() });
			if (optimisticUserSummaries.length > 50) optimisticUserSummaries = optimisticUserSummaries.slice(-50);
			appendUserMessage(content);
		},
		renderReleased,
		handleAgentEvent,
		hasPendingTools: tools.hasPendingTools,
		hasAssistant: () => Boolean(currentAssistant),
		markPendingToolsAborted: tools.markPendingToolsAborted,
	};
}
