import { safeRandomUUID } from "../core/uuid.js";
import { safeStringify } from "../core/stringify.js";
import { toolResultToText } from "../core/tool_format.js";
import { renderMarkdown, renderMarkdownThrottled } from "../render/markdown.js";
import { extractTextContent, parseAssistantContent } from "./content.js";
import { parseSubagentSlashMessage } from "./subagent_slash.js";
import { parseReviewSummaryMessage } from "./review_summary.js";
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

function fingerprintUserContent(content) {
	const blocks = normalizeUserContent(content);
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text.trim())
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
	const images = blocks
		.filter((block) => block.type === "image" && typeof block.mimeType === "string")
		.map((block) => String(block.mimeType));
	return `${text}::${images.join(",")}::${images.length}`;
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
			img.loading = "eager";
			img.decoding = "async";
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

export function createChatView({ msgsEl, isPhoneLikeFn, onReusePrompt }) {
	let currentAssistant = null; // { block, text, thinking, rawText, rawThinking }
	let appendedUserMessageKeys = new Set();
	let appendedAssistantMessageKeys = new Set();
	let appendedBashMessageKeys = new Set();
	let optimisticUserSummaries = [];
	let recentUserFingerprints = [];
	let subagentCards = new Map();
	let reviewCards = new Map();
	let suppressAutoScroll = false;
	let autoStickToBottom = true;
	let internalScroll = false;

	function isNearBottom(el, thresholdPx = 24) {
		const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
		return remaining <= thresholdPx;
	}

	function scrollToBottom(force = false) {
		if (suppressAutoScroll) return;
		if (!force && !autoStickToBottom) return;
		internalScroll = true;
		msgsEl.scrollTop = msgsEl.scrollHeight;
		requestAnimationFrame(() => {
			internalScroll = false;
			autoStickToBottom = true;
		});
	}

	function shouldAutoStick() {
		return autoStickToBottom || isNearBottom(msgsEl);
	}

	async function copyText(text) {
		const value = typeof text === "string" ? text : "";
		if (!value) return false;
		try {
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(value);
				return true;
			}
		} catch {
			// fall through to legacy copy path
		}
		try {
			const el = document.createElement("textarea");
			el.value = value;
			el.setAttribute("readonly", "true");
			el.style.position = "absolute";
			el.style.left = "-9999px";
			document.body.appendChild(el);
			el.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(el);
			return ok;
		} catch {
			return false;
		}
	}

	function flashActionButton(button, label) {
		if (!(button instanceof HTMLElement)) return;
		const original = button.dataset.originalLabel || button.textContent || "";
		button.dataset.originalLabel = original;
		button.textContent = label;
		button.disabled = true;
		setTimeout(() => {
			button.textContent = original;
			button.disabled = false;
		}, 1200);
	}

	function createMessageActions(actions) {
		if (!Array.isArray(actions) || actions.length === 0) return null;
		const row = document.createElement("div");
		row.className = "message-actions";
		for (const action of actions) {
			if (!action || typeof action.label !== "string" || typeof action.onClick !== "function") continue;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "message-action-btn";
			btn.textContent = action.label;
			btn.dataset.originalLabel = action.label;
			if (typeof action.title === "string" && action.title) btn.title = action.title;
			btn.addEventListener("click", async (event) => {
				event.preventDefault();
				event.stopPropagation();
				await action.onClick(btn);
			});
			row.appendChild(btn);
		}
		return row.childElementCount > 0 ? row : null;
	}

	function rememberRecentUserFingerprint(fingerprint, timestamp) {
		recentUserFingerprints.push({ fingerprint, timestamp: typeof timestamp === "number" ? timestamp : null, seenAt: Date.now() });
		if (recentUserFingerprints.length > 50) recentUserFingerprints = recentUserFingerprints.slice(-50);
	}

	function hasRecentUserDuplicate(fingerprint, timestamp) {
		const now = Date.now();
		return recentUserFingerprints.some((entry) => {
			if (entry.fingerprint !== fingerprint) return false;
			if (typeof timestamp === "number" && typeof entry.timestamp === "number") {
				return Math.abs(entry.timestamp - timestamp) <= 4000;
			}
			return now - entry.seenAt <= 4000;
		});
	}

	if (msgsEl && !msgsEl.dataset.chatViewScrollBound) {
		msgsEl.dataset.chatViewScrollBound = "1";
		msgsEl.addEventListener("scroll", () => {
			if (internalScroll) return;
			autoStickToBottom = isNearBottom(msgsEl);
		});
	}

	function clear(options = {}) {
		// Save pinned notices unless explicitly discarding them
		const savedNotices = options.discardNotices
			? []
			: Array.from(msgsEl.querySelectorAll(".notice-block")).map((n) => n.cloneNode(true));
		// Subtle fade transition on session switch
		msgsEl.classList.add("switching");
		msgsEl.classList.remove("switching-in");
		msgsEl.innerHTML = "";
		const spacer = document.createElement("div");
		spacer.className = "msgs-spacer";
		msgsEl.appendChild(spacer);
		requestAnimationFrame(() => {
			msgsEl.classList.add("switching-in");
			msgsEl.classList.remove("switching");
		});
		currentAssistant = null;
		tools.clear();
		appendedUserMessageKeys = new Set();
		appendedAssistantMessageKeys = new Set();
		appendedBashMessageKeys = new Set();
		optimisticUserSummaries = [];
		recentUserFingerprints = [];
		subagentCards = new Map();
		reviewCards = new Map();
		autoStickToBottom = true;
		// Re-append saved notices at top
		for (const n of savedNotices) msgsEl.appendChild(n);
	}

	function showLoading(text = "Loading…") {
		clear({ discardNotices: true });
		const block = document.createElement("div");
		block.className = "assistant-block loading-placeholder";
		block.innerHTML = `<div class="thinking-text" style="display:flex;align-items:center;gap:8px"><span class="work-spin" style="animation:spin 1s linear infinite">⠋</span> ${text}</div>`;
		msgsEl.appendChild(block);
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

		const actions = document.createElement("div");
		actions.className = "message-actions";
		actions.hidden = true;
		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "message-action-btn";
		copyBtn.textContent = "Copy";
		copyBtn.dataset.originalLabel = "Copy";
		copyBtn.hidden = true;
		actions.appendChild(copyBtn);

		block.appendChild(thinking);
		block.appendChild(text);
		block.appendChild(actions);
		msgsEl.appendChild(block);

		const state = { block, text, thinking, actions, copyBtn, rawText: "", rawThinking: "" };
		copyBtn.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			const ok = await copyText(state.rawText);
			flashActionButton(copyBtn, ok ? "Copied" : "Failed");
		});
		currentAssistant = state;
		return currentAssistant;
	}

	function ensureAssistantBlock() {
		return currentAssistant || appendAssistantBlock();
	}

	function appendUserMessage(content, opts = {}) {
		const el = document.createElement("div");
		el.className = "user-msg";
		renderUserMessageContent(el, content);
		const rawText = extractTextContent(content);
		if (rawText.trim()) {
			const actions = createMessageActions([
				{
					label: "Copy",
					title: "Copy prompt",
					onClick: async (button) => {
						const ok = await copyText(rawText);
						flashActionButton(button, ok ? "Copied" : "Failed");
					},
				},
				{
					label: "Reuse",
					title: "Put this prompt back in the composer",
					onClick: async () => {
						if (typeof onReusePrompt === "function") onReusePrompt(rawText);
					},
				},
			]);
			if (actions) el.appendChild(actions);
		}

		const insertBeforeEl = opts.insertBefore instanceof HTMLElement ? opts.insertBefore : null;
		if (insertBeforeEl && insertBeforeEl.parentNode === msgsEl) {
			msgsEl.insertBefore(el, insertBeforeEl);
		} else {
			msgsEl.appendChild(el);
		}
		if (opts.forceScroll || shouldAutoStick()) {
			autoStickToBottom = true;
			scrollToBottom(true);
		}
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
		const fingerprint = fingerprintUserContent(content);
		const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : null;
		const optimisticIdx = optimisticUserSummaries.findIndex((entry) => entry.fingerprint === fingerprint && Date.now() - entry.createdAt < 30000);
		appendedUserMessageKeys.add(key);
		if (appendedUserMessageKeys.size > 200) appendedUserMessageKeys.clear();
		if (optimisticIdx !== -1) {
			optimisticUserSummaries.splice(optimisticIdx, 1);
			rememberRecentUserFingerprint(fingerprint, timestamp);
			return;
		}
		if (hasRecentUserDuplicate(fingerprint, timestamp)) return;

		const assistant = currentAssistant;
		const assistantIsEmpty = Boolean(assistant && assistant.rawText === "" && assistant.rawThinking === "");
		const insertBeforeEl = assistantIsEmpty && assistant.block ? assistant.block : null;
		appendUserMessage(content, { insertBefore: insertBeforeEl });
		rememberRecentUserFingerprint(fingerprint, timestamp);
	}

	function appendNotice(text, kind = "info") {
		const stick = shouldAutoStick();
		const block = document.createElement("div");
		block.className = "assistant-block notice-block";
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
			const hasCopyText = Boolean(block.rawText.trim());
			block.copyBtn.hidden = !hasCopyText;
			block.actions.hidden = !hasCopyText;
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

	function bashMessageKey(message) {
		const ts = message && typeof message.timestamp === "number" ? message.timestamp : null;
		const summary = `${message?.command || ""}|${message?.exitCode ?? ""}|${message?.output?.length ?? 0}|${message?.cancelled ? "cancelled" : ""}`;
		return ts !== null ? `b:${ts}:${summary}` : `b:${summary}`;
	}

	function maybeAppendBashMessage(message) {
		if (!message || message.role !== "bashExecution") return;
		const key = bashMessageKey(message);
		if (appendedBashMessageKeys.has(key)) return;
		appendedBashMessageKeys.add(key);
		if (appendedBashMessageKeys.size > 200) appendedBashMessageKeys.clear();
		const block = document.createElement("div");
		block.className = `tool-box ${message.cancelled ? "error" : Number(message.exitCode) === 0 ? "success" : "error"}`;
		const title = document.createElement("div");
		title.className = "tool-title";
		title.textContent = message.excludeFromContext ? "Shell (not sent to AI)" : "Shell";
		const call = document.createElement("div");
		call.className = "tool-call";
		call.textContent = message.command || "";
		const out = document.createElement("div");
		out.className = "tool-out";
		out.textContent = message.output || (message.cancelled ? "Command aborted" : "(no output)");
		block.appendChild(title);
		block.appendChild(call);
		block.appendChild(out);
		msgsEl.appendChild(block);
		if (shouldAutoStick()) scrollToBottom(true);
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
		const stick = shouldAutoStick();
		renderMarkdown(entry.body, data.body || "(no output)");
		if (stick) scrollToBottom(true);
		return true;
	}

	function upsertReviewCard(message) {
		const data = parseReviewSummaryMessage(message);
		if (!data) return false;

		let entry = data.requestId ? reviewCards.get(data.requestId) : null;
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
			if (data.requestId) reviewCards.set(data.requestId, entry);
		}

		entry.box.className = "tool-box success review-result";
		entry.title.textContent = data.title;
		entry.meta.textContent = data.summary;
		entry.meta.style.display = data.summary ? "" : "none";
		const stick = shouldAutoStick();
		renderMarkdown(entry.body, data.body || "(no output)");
		if (stick) scrollToBottom(true);
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
			} else if (m.role === "bashExecution") {
				maybeAppendBashMessage(m);
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
				if (upsertReviewCard(m)) continue;
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
		autoStickToBottom = true;
		scrollToBottom(true);
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
				if (upsertReviewCard(event.message)) return;
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
				renderMarkdownThrottled(block.text, block.rawText);
			} else {
				return;
			}
			if (shouldAutoStick()) scrollToBottom(true);
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
			const stick = isPhoneLikeFn() && shouldAutoStick();
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.partialResult));
			if (stick) scrollToBottom(true);
			return;
		}

		if (event.type === "tool_execution_end") {
			const stick = isPhoneLikeFn() && shouldAutoStick();
			if (!tools.has(event.toolCallId)) {
				tools.ensure(event.toolCallId, event.toolName, event.isError ? "error" : "success");
			}
			tools.setStatus(event.toolCallId, event.isError ? "error" : "success");
			tools.setText(event.toolCallId, event.toolName, toolResultToText(event.result));
			if (stick) scrollToBottom(true);
			return;
		}
	}

	return {
		clear,
		showLoading,
		scrollToBottom,
		appendNotice,
		renderHistory,
		replaceFromMessages: (messages) => {
			const stick = shouldAutoStick();
			const prevScrollTop = msgsEl.scrollTop;
			clear();
			renderHistory(messages || []);
			if (stick) {
				autoStickToBottom = true;
				scrollToBottom(true);
			} else {
				internalScroll = true;
				msgsEl.scrollTop = prevScrollTop;
				requestAnimationFrame(() => {
					internalScroll = false;
					autoStickToBottom = false;
				});
			}
		},
		syncFromMessages: (messages) => {
			const stick = shouldAutoStick();
			const prevScrollTop = msgsEl.scrollTop;
			renderHistory(messages || []);
			if (stick) {
				autoStickToBottom = true;
				scrollToBottom(true);
			} else {
				internalScroll = true;
				msgsEl.scrollTop = prevScrollTop;
				requestAnimationFrame(() => {
					internalScroll = false;
					autoStickToBottom = false;
				});
			}
		},
		appendOptimisticUserMessage: (content) => {
			optimisticUserSummaries.push({ fingerprint: fingerprintUserContent(content), createdAt: Date.now() });
			if (optimisticUserSummaries.length > 50) optimisticUserSummaries = optimisticUserSummaries.slice(-50);
			autoStickToBottom = true;
			appendUserMessage(content, { forceScroll: true });
		},
		renderReleased,
		handleAgentEvent,
		hasPendingTools: tools.hasPendingTools,
		hasAssistant: () => Boolean(currentAssistant),
		markPendingToolsAborted: tools.markPendingToolsAborted,
	};
}
