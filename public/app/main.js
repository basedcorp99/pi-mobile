import { createApi } from "./core/api.js";
import { isPhoneLike } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { installPushNotifications } from "./core/push.js";
import { fileToImageContent } from "./core/image_upload.js";
import { createVoiceRecorder } from "./core/voice.js";
import {
	getFaceIdEnabled,
	getFontScalePreference,
	getOrCreateClientId,
	getSendOnEnterEnabled,
	getThemePreference,
	getToken,
	setFontScalePreference,
	setSendOnEnterEnabled,
	setThemePreference,
} from "./core/storage.js";
import { createSessionController } from "./session/controller.js";
import { createMenu } from "./ui/menu.js";
import { createAskDialog } from "./ui/ask_dialog.js";
import { createUiPromptDialog } from "./ui/ui_prompt_dialog.js";
import { createAgentLauncher } from "./ui/agent_launcher.js";
import { createSidebar } from "./ui/sidebar.js";

const sessionsList = document.getElementById("sessions-list");
const msgs = document.getElementById("msgs");
const input = document.getElementById("inp");
const btnScrollBottom = document.getElementById("btn-scroll-bottom");
const workingIndicator = document.getElementById("working");
const workingSpin = document.getElementById("work-spin");
const workingText = document.querySelector("#working .work-text");

const footerLine1 = document.getElementById("footer-line-1");
const footerLeft2 = document.getElementById("footer-left-2");
const footerRight2 = document.getElementById("footer-right-2");

const rolePill = document.getElementById("role-pill");
const btnModel = document.getElementById("btn-model");
const btnThinking = document.getElementById("btn-thinking");
const btnCommands = document.getElementById("btn-commands");
const attachBarEl = document.getElementById("attach-bar");
const btnMenuHeader = document.getElementById("btn-menu-header");
const btnNotify = document.getElementById("btn-notify");
const lblModel = document.getElementById("lbl-model");
const lblThinking = document.getElementById("lbl-thinking");
const lblNotify = document.getElementById("lbl-notify");

const sidebarLabel = document.getElementById("sidebar-label");
const btnSidebarLeft = document.getElementById("btn-sidebar-left");
const btnSidebarRight = document.getElementById("btn-sidebar-right");

const btnTakeover = document.getElementById("btn-takeover");
const btnAbort = document.getElementById("btn-abort");
const btnCompact = document.getElementById("btn-compact");
const btnRelease = document.getElementById("btn-release");
const btnTakeoverTxt = btnTakeover?.querySelector?.(".txt") || null;
const btnAbortTxt = btnAbort?.querySelector?.(".txt") || null;
const btnCompactTxt = btnCompact?.querySelector?.(".txt") || null;
const btnReleaseTxt = btnRelease?.querySelector?.(".txt") || null;
const btnAttach = document.getElementById("btn-attach");
const btnVoice = document.getElementById("btn-voice");
const btnAttachClear = document.getElementById("btn-attach-clear");
const attachList = document.getElementById("attach-list");
const btnTheme = document.getElementById("btn-theme");
const btnSettings = document.getElementById("btn-settings");
const imageInput = document.getElementById("image-input");

const menuOverlay = document.getElementById("menu-overlay");
const menuScrim = document.getElementById("menu-scrim");
const menuPanel = document.getElementById("menu-panel");

const sidebar = document.querySelector(".sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");

const kbMenu = document.getElementById("kb-menu");
const kbAbort = document.getElementById("kb-abort");
const kbCompact = document.getElementById("kb-compact");
const kbTakeover = document.getElementById("kb-takeover");
const kbRelease = document.getElementById("kb-release");
const kbEnter = document.getElementById("kb-enter");
const kbTakeoverTextNode = kbTakeover ? Array.from(kbTakeover.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
const kbAbortTextNode = kbAbort ? Array.from(kbAbort.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
const kbCompactTextNode = kbCompact ? Array.from(kbCompact.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;

const clientId = getOrCreateClientId();
const token = getToken();
const currentUrl = new URL(window.location.href);
const replayName = currentUrl.searchParams.get("replay")?.trim() || null;
const sessionParam = currentUrl.searchParams.get("session")?.trim() || null;
let lastSyncedSessionUrl = null;
const api = createApi(token);
const faceIdEnabled = getFaceIdEnabled();
const faceIdGuard = faceIdEnabled ? installFaceIdGuard({ api }) : { start: async () => {} };
let pushCtrl = null;

// Preferences
let sendOnEnter = getSendOnEnterEnabled();
let fontScale = getFontScalePreference();
const savedTheme = getThemePreference();
if (savedTheme === "light") document.body.classList.add("light");
document.documentElement.style.setProperty("--font-scale", String(fontScale));

let workingIntervalId = null;
let workingFrame = 0;

let sidebarCtrl = null;
let menuCtrl = null;
let askDialog = null;
let uiPromptDialog = null;
let agentLauncher = null;
let pendingAttachments = [];

function syncSessionUrl(sessionId) {
	if (replayName) return;
	const normalized = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
	if (normalized === lastSyncedSessionUrl) return;
	const url = new URL(window.location.href);
	if (normalized) url.searchParams.set("session", normalized);
	else url.searchParams.delete("session");
	history.replaceState(null, "", url.toString());
	lastSyncedSessionUrl = normalized;
}

function formatTokens(n) {
	const num = Number(n || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 10_000) return `${Math.round(num / 1_000)}k`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(Math.round(num));
}

function formatCost(cost) {
	const num = Number(cost || 0);
	if (!Number.isFinite(num) || num <= 0) return null;
	return `$${num.toFixed(3)}`;
}

function buildSessionMetrics(state) {
	if (!state || typeof state !== "object") return "";

	const parts = [];
	const stats = state.stats && typeof state.stats === "object" ? state.stats : null;
	const tokens = stats && stats.tokens && typeof stats.tokens === "object" ? stats.tokens : null;

	const inputTokens = tokens && typeof tokens.input === "number" ? tokens.input : 0;
	const outputTokens = tokens && typeof tokens.output === "number" ? tokens.output : 0;
	const cacheRead = tokens && typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
	const cacheWrite = tokens && typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0;
	const cost = stats && typeof stats.cost === "number" ? stats.cost : 0;

	if (inputTokens) parts.push(`↑${formatTokens(inputTokens)}`);
	if (outputTokens) parts.push(`↓${formatTokens(outputTokens)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);

	const costStr = formatCost(cost);
	if (costStr) parts.push(costStr);

	const usage = state.contextUsage && typeof state.contextUsage === "object" ? state.contextUsage : null;
	const cw = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : 0;
	if (cw > 0) {
		const percent = typeof usage.percent === "number" ? usage.percent : null;
		if (percent === null) {
			parts.push(`?/${formatTokens(cw)}`);
		} else {
			parts.push(`${Math.round(percent)}%/${formatTokens(cw)}`);
		}
	}

	return parts.join(" ");
}

function updateFooter() {
	const activeState = sessionCtrl.getActiveState();
	if (!activeState) {
		footerLine1.textContent = "";
		footerLeft2.textContent = "—";
		footerRight2.textContent = "—";
		return;
	}

	footerLine1.textContent = "";

	const model = activeState.model ? `${activeState.model.provider}/${activeState.model.id}` : "(no model)";
	const metrics = buildSessionMetrics(activeState);
	const leftParts = [];
	if (activeState.cwd) leftParts.push(activeState.cwd);
	if (metrics) leftParts.push(metrics);
	leftParts.push(activeState.sessionId.slice(0, 8));
	footerLeft2.textContent = leftParts.join(" • ");
	footerRight2.textContent = `${model} • ${activeState.thinkingLevel}`;
}

function updateRolePill() {
	const role = sessionCtrl.getRole();
	if (!rolePill) return;
	rolePill.textContent = role;
	rolePill.classList.remove("controller", "viewer");
	rolePill.classList.add(role);
}

function updateTopSelectors() {
	const activeState = sessionCtrl.getActiveState();
	const model = activeState?.model ? `${activeState.model.provider}/${activeState.model.id}` : "—";
	if (lblModel) {
		lblModel.textContent = model;
		lblModel.title = model;
	}
	const thinking = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "—";
	if (lblThinking) {
		lblThinking.textContent = thinking;
		lblThinking.title = thinking;
	}
}

function renderAttachmentBar() {
	if (attachList) {
		attachList.innerHTML = "";
		for (const [index, attachment] of pendingAttachments.entries()) {
			const chip = document.createElement("div");
			chip.className = "attach-chip";
			chip.title = attachment.label;

			const label = document.createElement("span");
			label.textContent = attachment.label;
			chip.appendChild(label);

			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "Remove image";
			remove.addEventListener("click", () => {
				pendingAttachments.splice(index, 1);
				renderAttachmentBar();
				updateControls();
			});
			chip.appendChild(remove);

			attachList.appendChild(chip);
		}
	}
	if (btnAttachClear) btnAttachClear.hidden = pendingAttachments.length === 0;
	if (attachBarEl) attachBarEl.style.display = pendingAttachments.length > 0 ? "flex" : "none";
}

function clearAttachments() {
	pendingAttachments = [];
	renderAttachmentBar();
	updateControls();
}

function updateAttachmentControls() {
	const hasSession = Boolean(sessionCtrl.getActiveSessionId());
	const isController = hasSession && sessionCtrl.isController();
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";
	if (btnCommands) btnCommands.disabled = disabled;
	if (btnAttach) btnAttach.disabled = disabled;
	if (btnVoice) btnVoice.disabled = disabled || !voiceUiReady || voiceRecorder?.isTranscribing?.();
	if (btnAttachClear) btnAttachClear.disabled = disabled || pendingAttachments.length === 0;
	if (imageInput) imageInput.disabled = disabled;
	if (!disabled && pendingAttachments.length === 0) {
		renderAttachmentBar();
	}
}

async function addImageFiles(files) {
	const list = Array.from(files || []).filter((file) => file && String(file.type || "").startsWith("image/"));
	if (list.length === 0) return;
	const remaining = Math.max(0, 4 - pendingAttachments.length);
	for (const file of list.slice(0, remaining)) {
		const image = await fileToImageContent(file);
		pendingAttachments.push(image);
	}
	renderAttachmentBar();
	updateControls();
}

function updateWorkingIndicator() {
	if (!workingIndicator) return;
	const activeState = sessionCtrl.getActiveState();
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const show = sessionCtrl.getPendingPrompt() || Boolean(activeState && activeState.isStreaming) || Boolean(actionBusy);
	workingIndicator.classList.toggle("open", show);
	if (workingText) {
		workingText.textContent = actionBusy === "takeover"
			? "Taking over…"
			: actionBusy === "reconnect"
				? "Reconnecting…"
				: actionBusy === "release"
					? "Releasing…"
					: actionBusy === "compact"
						? "Compacting…"
						: actionBusy === "bash"
							? "Running shell…"
							: actionBusy === "abort"
								? "Aborting…"
								: "Working...";
	}

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const updateFrame = () => {
		if (workingSpin) workingSpin.textContent = frames[workingFrame % frames.length];
		workingFrame = (workingFrame + 1) % frames.length;
	};

	if (show) {
		if (!workingIntervalId) {
			workingFrame = 0;
			updateFrame();
			workingIntervalId = setInterval(updateFrame, 80);
		}
	} else if (workingIntervalId) {
		clearInterval(workingIntervalId);
		workingIntervalId = null;
	}
}

function updateControls() {
	updateRolePill();

	const hasSession = Boolean(sessionCtrl.getActiveSessionId());
	const isController = hasSession && sessionCtrl.isController();
	const streaming = Boolean(sessionCtrl.getActiveState() && sessionCtrl.getActiveState().isStreaming);
	const phone = isPhoneLike();
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const canChangeSettings = hasSession && isController && !streaming && !actionBusy;

	btnAbort.disabled = !hasSession || Boolean(actionBusy && actionBusy !== "abort" && actionBusy !== "bash");
	btnTakeover.disabled = !hasSession || Boolean(actionBusy);
	if (btnCompact) btnCompact.disabled = !hasSession || !isController || streaming || Boolean(actionBusy);
	btnRelease.disabled = !hasSession || !isController || Boolean(actionBusy);
	input.disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";
	if (btnModel) btnModel.disabled = !canChangeSettings;
	if (btnThinking) btnThinking.disabled = !canChangeSettings;
	if (btnTakeoverTxt) btnTakeoverTxt.textContent = actionBusy === "takeover" ? "Taking…" : actionBusy === "reconnect" ? "Reconnecting…" : isController ? "Reconnect" : "Take over";
	if (kbTakeoverTextNode) kbTakeoverTextNode.textContent = actionBusy === "takeover" ? " Taking…" : actionBusy === "reconnect" ? " Reconnecting…" : isController ? " Reconnect" : " Take over";
	if (btnAbortTxt) btnAbortTxt.textContent = actionBusy === "abort" ? "Aborting…" : actionBusy === "bash" ? "Stop" : "Abort";
	if (kbAbortTextNode) kbAbortTextNode.textContent = actionBusy === "abort" ? " Aborting…" : actionBusy === "bash" ? " Stop" : " Abort";
	if (btnCompactTxt) btnCompactTxt.textContent = actionBusy === "compact" ? "Compacting…" : "Compact";
	if (kbCompactTextNode) kbCompactTextNode.textContent = actionBusy === "compact" ? " Compacting…" : " Compact";
	if (btnReleaseTxt) btnReleaseTxt.textContent = actionBusy === "release" ? "Releasing…" : "Release";
	updateAttachmentControls();

	if (kbAbort) kbAbort.disabled = !hasSession || Boolean(actionBusy && actionBusy !== "abort" && actionBusy !== "bash");
	if (kbTakeover) kbTakeover.disabled = !hasSession || Boolean(actionBusy);
	if (kbRelease) kbRelease.disabled = !hasSession || !isController || Boolean(actionBusy);
	if (kbCompact) kbCompact.disabled = !hasSession || !isController || streaming || Boolean(actionBusy);
	if (kbEnter) kbEnter.disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";

	if (!hasSession) {
		input.placeholder = "";
	} else if (isController) {
		input.placeholder = phone
			? sendOnEnter
				? "Type a prompt (Enter key to send, Return key for newline)"
				: "Type a prompt (Enter for newline, Ctrl+Enter to send)"
			: streaming
				? "Streaming… (Esc to abort, Enter to queue follow-up)"
				: sendOnEnter
					? "Type a prompt (Enter to send, Shift+Enter for newline)"
					: "Type a prompt (Enter for newline, Ctrl+Enter to send)";
	} else {
		input.placeholder = streaming ? "Viewer mode — Esc to abort" : "Viewer mode — Take over to type";
	}

	updateTopSelectors();
	updateWorkingIndicator();
}

function autoResize(el) {
	el.style.height = "auto";
	el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function fillBorders() {
	const chat = document.querySelector(".chat");
	const w = chat.getBoundingClientRect().width;
	const charW = 8.1;
	const count = Math.floor(w / charW);
	const dashes = "─".repeat(Math.max(10, count));
	document.querySelectorAll(".editor-border").forEach((el) => {
		el.textContent = dashes;
	});
}

async function sendPromptFromInput() {
	if (input.disabled) return false;
	const text = input.value;
	const images = pendingAttachments.map((attachment) => attachment.content);
	if (!text.trim() && images.length === 0) return false;
	const snapshot = pendingAttachments.slice();
	input.value = "";
	autoResize(input);
	clearAttachments();
	try {
		await sessionCtrl.sendPrompt(text, images);
		return true;
	} catch (error) {
		pendingAttachments = snapshot;
		renderAttachmentBar();
		updateControls();
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
		return false;
	} finally {
		input.focus();
	}
}

function closeOpenOverlays() {
	let closed = false;
	if (menuOverlay?.classList?.contains("open")) {
		menuCtrl?.close?.();
		askDialog?.close?.();
		uiPromptDialog?.close?.();
		agentLauncher?.close?.();
		closed = true;
	}
	if (sidebar?.classList?.contains("open")) {
		sidebarCtrl?.setOpen?.(false);
		closed = true;
	}
	return closed;
}

function handleEscapeAction() {
	if (closeOpenOverlays()) return;
	void sessionCtrl.abortRun();
}

const sessionCtrl = createSessionController({
	msgsEl: msgs,
	api,
	clientId,
	token,
	isPhoneLikeFn: isPhoneLike,
	onStateChange: () => {
		syncSessionUrl(sessionCtrl.getActiveSessionId());
		updateFooter();
		updateControls();
	},
	onCloseMenu: () => {
		if (menuOverlay?.dataset?.locked === "1") return;
		menuCtrl?.close();
	},
	onSidebarClose: () => sidebarCtrl?.setOpen(false),
	onSidebarRefresh: () => sidebarCtrl?.refresh(),
	onAskRequest: (askId, questions) => {
		if (askDialog) {
			askDialog.show(askId, questions, (id, cancelled, selections) => {
				void sessionCtrl.sendAskResponse(id, cancelled, selections);
			});
		}
	},
	onUiSelect: (uiId, title, options) => {
		if (uiPromptDialog) {
			uiPromptDialog.showSelect(uiId, title, options, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
	onUiInput: (uiId, title, placeholder) => {
		if (uiPromptDialog) {
			uiPromptDialog.showInput(uiId, title, placeholder, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
	onUiConfirm: (uiId, title, message) => {
		if (uiPromptDialog) {
			uiPromptDialog.showConfirm(uiId, title, message, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
});

sidebarCtrl = createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	api,
	clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onSelectSession: async (s) => {
		await sessionCtrl.selectSession(s);
		clearAttachments();
	},
	onSessionIdSelected: (sessionId) => {
		sessionCtrl.openSessionId(sessionId);
		clearAttachments();
		updateControls();
	},
	onRenameSession: async (session, name) => {
		if (!session) return;
		if (sessionCtrl.getActiveSessionId() !== session.id) {
			await sessionCtrl.selectSession(session);
		}
		await sessionCtrl.setSessionName(name);
	},
});

menuCtrl = createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	btnCommands,
	btnSettings,
	api,
	clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	getActiveState: () => sessionCtrl.getActiveState(),
	getPrefs: () => ({
		theme: document.body.classList.contains("light") ? "light" : "dark",
		sendOnEnter,
		fontScale,
		faceIdEnabled,
		pushSupported: pushCtrl?.isSupported?.() ?? false,
		pushSubscribed: pushCtrl?.isSubscribed?.() ?? false,
		steeringMode: sessionCtrl.getActiveState()?.steeringMode || null,
		followUpMode: sessionCtrl.getActiveState()?.followUpMode || null,
		hasSessionControl: Boolean(sessionCtrl.getActiveSessionId() && sessionCtrl.isController()),
	}),
	onToggleTheme: () => {
		const isLight = document.body.classList.toggle("light");
		setThemePreference(isLight ? "light" : "dark");
		if (btnTheme) btnTheme.textContent = isLight ? "☾" : "☀";
	},
	onToggleSendOnEnter: () => {
		sendOnEnter = !sendOnEnter;
		setSendOnEnterEnabled(sendOnEnter);
		updateControls();
	},
	onAdjustFontScale: (delta) => {
		fontScale = Math.max(0.85, Math.min(1.35, Math.round((fontScale + delta) * 100) / 100));
		setFontScalePreference(fontScale);
		document.documentElement.style.setProperty("--font-scale", String(fontScale));
	},
	onTogglePush: async () => {
		if (!pushCtrl) return;
		await pushCtrl.toggle();
	},
	onTestPush: async () => {
		if (!pushCtrl) return;
		await pushCtrl.test();
	},
	onSetSteeringMode: async (mode) => {
		await sessionCtrl.setSteeringMode(mode);
	},
	onSetFollowUpMode: async (mode) => {
		await sessionCtrl.setFollowUpMode(mode);
	},
	onInsertCommand: (value) => {
		if (input.disabled) return;
		input.value = value;
		autoResize(input);
		input.focus();
	},
	onRunAgent: () => {
		if (agentLauncher) agentLauncher.show();
	},
});

askDialog = createAskDialog({ menuOverlay, menuScrim, menuPanel });
uiPromptDialog = createUiPromptDialog({ menuOverlay, menuScrim, menuPanel });
agentLauncher = createAgentLauncher({
	menuOverlay, menuPanel, api,
	onSubmit: (cmd) => void sessionCtrl.sendPrompt(cmd),
});

pushCtrl = installPushNotifications({
	api,
	btnNotify,
	lblNotify,
	onNotice: sessionCtrl.appendNotice,
});
void pushCtrl.start();

let voiceRecordingMode = null;
let voiceUiReady = false;
const voiceRecorder = createVoiceRecorder({
	api,
	onTranscription: (text) => {
		if (!input.disabled) {
			const before = input.value;
			input.value = before ? `${before} ${text}` : text;
			autoResize(input);
			input.focus();
		}
	},
	onNotice: sessionCtrl.appendNotice,
	onStateChange: () => {
		if (btnVoice) {
			const rec = voiceRecorder.isRecording();
			const trans = voiceRecorder.isTranscribing();
			if (!rec) voiceRecordingMode = null;
			btnVoice.classList.toggle("recording", rec);
			btnVoice.classList.toggle("transcribing", voiceUiReady && trans);
			btnVoice.classList.toggle("pending", !voiceUiReady && !rec);
			btnVoice.disabled = trans || !voiceUiReady;
			btnVoice.textContent = !voiceUiReady ? "\uD83C\uDF99" : trans ? "⏳" : "\uD83C\uDF99";
			btnVoice.title = !voiceUiReady
				? "Voice loading…"
				: trans
					? "Transcribing…"
					: rec
						? (voiceRecordingMode === "hold" ? "Release to stop" : "Tap to stop")
						: "Tap or hold to record";
		}
	},
});
void voiceRecorder.resumePending({ silent: true }).finally(() => {
	voiceUiReady = true;
	if (btnVoice) {
		btnVoice.classList.toggle("pending", false);
		btnVoice.textContent = voiceRecorder.isTranscribing() ? "⏳" : "\uD83C\uDF99";
	}
	updateControls();
});
let voiceWasHidden = false;
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		voiceWasHidden = true;
		return;
	}
	if (document.visibilityState === "visible" && voiceWasHidden) {
		voiceWasHidden = false;
		void voiceRecorder.resumePending({ silent: true });
	}
});

btnAbort.addEventListener("click", () => void sessionCtrl.abortRun());
if (btnCompact) btnCompact.addEventListener("click", () => {
	void sessionCtrl.compact();
});
btnTakeover.addEventListener("click", () => {
	void sessionCtrl.takeOver().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
btnRelease.addEventListener("click", () => {
	void sessionCtrl.release().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (btnAttach) btnAttach.addEventListener("click", () => imageInput?.click());
if (btnVoice) {
	let pressActive = false;
	let holdStarting = false;
	let holdTimer = null;
	let activePointerId = null;
	const HOLD_DELAY_MS = 220;
	const pulseHaptic = () => {
		try { navigator.vibrate?.(12); } catch {}
	};
	const clearHoldTimer = () => {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	};

	const startVoiceRecording = async (mode, e) => {
		if (btnVoice.disabled || holdStarting || voiceRecorder.isRecording() || voiceRecorder.isTranscribing()) return;
		e?.preventDefault?.();
		holdStarting = true;
		voiceRecordingMode = mode;
		if (mode === "hold") {
			btnVoice.classList.add("holding");
			pulseHaptic();
			if (typeof activePointerId === "number" && btnVoice.setPointerCapture) {
				try { btnVoice.setPointerCapture(activePointerId); } catch {}
			}
		}
		try {
			const result = await voiceRecorder.start();
			if (result?.primed) {
				voiceRecordingMode = null;
				btnVoice.classList.remove("holding");
				return;
			}
		} finally {
			holdStarting = false;
			if (mode === "hold" && !pressActive && voiceRecorder.isRecording()) {
				pulseHaptic();
				voiceRecorder.stop();
			}
			if (!pressActive) btnVoice.classList.remove("holding");
		}
	};

	const stopVoiceHold = (e) => {
		if (voiceRecordingMode !== "hold" && !holdStarting && !pressActive) return;
		e?.preventDefault?.();
		clearHoldTimer();
		pressActive = false;
		activePointerId = null;
		btnVoice.classList.remove("holding");
		if (voiceRecordingMode === "hold" && voiceRecorder.isRecording()) {
			pulseHaptic();
			voiceRecorder.stop();
		}
	};

	const toggleTapRecording = async (e) => {
		if (btnVoice.disabled || holdStarting || voiceRecorder.isTranscribing()) return;
		e?.preventDefault?.();
		clearHoldTimer();
		if (voiceRecorder.isRecording()) {
			if (voiceRecordingMode === "tap") {
				pulseHaptic();
				voiceRecorder.stop();
			}
			return;
		}
		pulseHaptic();
		await startVoiceRecording("tap", e);
	};

	btnVoice.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || btnVoice.disabled || voiceRecorder.isTranscribing()) return;
		pressActive = true;
		activePointerId = e.pointerId;
		clearHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			if (pressActive && !voiceRecorder.isRecording() && !voiceRecorder.isTranscribing()) {
				void startVoiceRecording("hold", e);
			}
		}, HOLD_DELAY_MS);
	});
	btnVoice.addEventListener("pointerup", async (e) => {
		const wasPendingTap = Boolean(pressActive && holdTimer);
		if (wasPendingTap) {
			pressActive = false;
			activePointerId = null;
			clearHoldTimer();
			await toggleTapRecording(e);
			return;
		}
		stopVoiceHold(e);
	});
	btnVoice.addEventListener("pointercancel", stopVoiceHold);
	window.addEventListener("pointerup", (e) => {
		if (voiceRecordingMode === "hold" || holdStarting) stopVoiceHold(e);
	});
	window.addEventListener("pointercancel", stopVoiceHold);
	window.addEventListener("pagehide", stopVoiceHold);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") stopVoiceHold();
	});
	btnVoice.addEventListener("keydown", async (e) => {
		if ((e.key === " " || e.key === "Enter") && !e.repeat) {
			e.preventDefault();
			if (voiceRecorder.isRecording() && voiceRecordingMode === "tap") {
				pulseHaptic();
				voiceRecorder.stop();
				return;
			}
			await toggleTapRecording(e);
		}
	});
}
if (btnAttachClear) btnAttachClear.addEventListener("click", () => clearAttachments());
if (btnTheme) btnTheme.addEventListener("click", () => {
	const isLight = document.body.classList.toggle("light");
	setThemePreference(isLight ? "light" : "dark");
	btnTheme.textContent = isLight ? "☾" : "☀";
});
if (btnTheme && document.body.classList.contains("light")) btnTheme.textContent = "☾";
if (btnSettings) btnSettings.addEventListener("click", () => menuCtrl.openSettingsMenu());
if (imageInput) {
	imageInput.addEventListener("change", async () => {
		try {
			await addImageFiles(imageInput.files || []);
		} catch (error) {
			sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			imageInput.value = "";
		}
	});
}
if (btnModel) btnModel.addEventListener("click", () => void menuCtrl.openModelMenu());
if (btnThinking) btnThinking.addEventListener("click", () => menuCtrl.openThinkingMenu());
if (btnCommands) {
	btnCommands.addEventListener("mousedown", (e) => e.preventDefault());
	btnCommands.addEventListener("click", () => {
		if (document.activeElement === input) input.blur();
		setTimeout(() => agentLauncher?.show?.(), 50);
	});
}

if (kbMenu) kbMenu.addEventListener("click", () => sidebarCtrl.toggleOpen());
if (btnMenuHeader) btnMenuHeader.addEventListener("click", () => sidebarCtrl.toggleOpen());
if (kbAbort) kbAbort.addEventListener("click", () => void sessionCtrl.abortRun());
if (kbCompact) kbCompact.addEventListener("click", () => {
	void sessionCtrl.compact();
});
if (kbTakeover) kbTakeover.addEventListener("click", () => {
	void sessionCtrl.takeOver().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (kbRelease) kbRelease.addEventListener("click", () => {
	void sessionCtrl.release().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (kbEnter) kbEnter.addEventListener("click", () => sendPromptFromInput());

if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => sidebarCtrl.setOpen(false));

// Scroll-to-bottom floating button
if (btnScrollBottom && msgs) {
	let scrollBtnRaf = 0;
	const updateScrollBtn = () => {
		scrollBtnRaf = 0;
		const remaining = Math.max(0, msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight);
		const scrollable = msgs.scrollHeight > msgs.clientHeight + 24;
		const nearBottom = remaining <= 48;
		btnScrollBottom.hidden = !scrollable || nearBottom;
	};
	const scheduleScrollBtnUpdate = () => {
		if (scrollBtnRaf) return;
		scrollBtnRaf = requestAnimationFrame(updateScrollBtn);
	};
	msgs.addEventListener("scroll", scheduleScrollBtnUpdate, { passive: true });
	new ResizeObserver(scheduleScrollBtnUpdate).observe(msgs);
	new MutationObserver(scheduleScrollBtnUpdate).observe(msgs, { childList: true, subtree: true, characterData: true });
	window.addEventListener("resize", scheduleScrollBtnUpdate);
	btnScrollBottom.addEventListener("click", () => {
		msgs.scrollTop = msgs.scrollHeight;
		scheduleScrollBtnUpdate();
	});
	scheduleScrollBtnUpdate();
}

input.addEventListener("input", () => autoResize(input));
input.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" || e.isComposing) return;
	if (sendOnEnter) {
		if (!e.shiftKey) {
			e.preventDefault();
			sendPromptFromInput();
		}
		return;
	}
	if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
		e.preventDefault();
		sendPromptFromInput();
	}
});

window.addEventListener("paste", async (e) => {
	const files = Array.from(e.clipboardData?.files || []).filter((file) => file && String(file.type || "").startsWith("image/"));
	if (files.length === 0) return;
	e.preventDefault();
	try {
		await addImageFiles(files);
	} catch (error) {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	}
});

window.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		e.preventDefault();
		handleEscapeAction();
	}
});

fillBorders();
window.addEventListener("resize", fillBorders);
window.addEventListener("resize", () => sidebarCtrl.setOpen(false));
window.addEventListener("pagehide", () => sidebarCtrl?.setOpen?.(false));
window.addEventListener("beforeunload", () => sidebarCtrl?.setOpen?.(false));

updateFooter();
updateControls();

async function openSessionFromParam() {
	if (!sessionParam) return;
	try {
		const data = await api.getJson("/api/active-sessions");
		const sessions = Array.isArray(data.sessions) ? data.sessions : [];
		const match = sessions.find((s) => s && s.id === sessionParam);
		if (match) {
			sessionCtrl.openSessionId(match.id);
			clearAttachments();
			updateControls();
		}
	} catch {
		// ignore
	}
}

function installSidebarSwipeGestures() {
	let tracking = null;
	const edgeThreshold = 72;
	const commitThreshold = 32;

	const shouldCommit = () => {
		if (!tracking) return;
		const dx = tracking.lastX - tracking.x;
		const dy = tracking.lastY - tracking.y;
		if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy)) return;
		if (tracking.mode === "open" && dx > commitThreshold) {
			sidebarCtrl.setOpen(true);
			tracking = null;
			return;
		}
		if (tracking.mode === "close" && dx < -commitThreshold) {
			sidebarCtrl.setOpen(false);
			tracking = null;
		}
	};

	document.addEventListener("touchstart", (e) => {
		if (!sidebarCtrl || !e.touches || e.touches.length !== 1) return;
		const touch = e.touches[0];
		const sidebarOpen = sidebarCtrl.isOpen?.() || sidebar?.classList?.contains("open");
		const inSidebar = sidebar?.contains?.(e.target);
		const inOverlay = sidebarOverlay?.contains?.(e.target);
		if (!sidebarOpen && touch.clientX <= edgeThreshold) {
			tracking = { mode: "open", x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
			return;
		}
		if (sidebarOpen && (inSidebar || inOverlay)) {
			tracking = { mode: "close", x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
		}
	}, { passive: true });

	document.addEventListener("touchmove", (e) => {
		if (!tracking || !e.touches || e.touches.length !== 1) return;
		const touch = e.touches[0];
		tracking.lastX = touch.clientX;
		tracking.lastY = touch.clientY;
		shouldCommit();
	}, { passive: true });

	const reset = () => { tracking = null; };
	document.addEventListener("touchend", () => {
		shouldCommit();
		reset();
	}, { passive: true });
	document.addEventListener("touchcancel", reset, { passive: true });

	document.addEventListener("touchmove", (e) => {
		if (!sidebarCtrl?.isOpen?.() || !e.touches || e.touches.length !== 1) return;
		const target = e.target;
		if (!sidebar?.contains?.(target)) {
			e.preventDefault();
			return;
		}
		const scroller = target?.closest?.(".sessions") || sessionsList;
		if (!scroller) {
			e.preventDefault();
			return;
		}
		const touch = e.touches[0];
		const prevY = tracking?.lastY ?? touch.clientY;
		const dy = touch.clientY - prevY;
		const atTop = scroller.scrollTop <= 0;
		const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
		if ((atTop && dy > 0) || (atBottom && dy < 0)) {
			e.preventDefault();
		}
	}, { passive: false });
}
installSidebarSwipeGestures();

if (replayName) {
	clearAttachments();
	void sessionCtrl.runReplay(replayName);
} else {
	void sidebarCtrl.refresh().then(() => openSessionFromParam());
	setInterval(() => void sidebarCtrl.refresh(), 5_000);
}

if (faceIdEnabled) void faceIdGuard.start();

// Prevent pinch zoom and double-tap zoom
document.addEventListener("touchstart", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
