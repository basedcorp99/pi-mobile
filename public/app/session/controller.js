import { computeCliCommand } from "./cli.js";
import { createChatView } from "./chat_view.js";

export function createSessionController({
	msgsEl,
	api,
	clientId,
	token,
	isPhoneLikeFn,
	onStateChange,
	onCloseMenu,
	onSidebarClose,
	onSidebarRefresh,
	onAskRequest,
	onUiSelect,
	onUiInput,
	onUiConfirm,
	onReusePrompt,
	onSessionEnded,
}) {
	let activeSessionId = null;
	let activeState = null;
	let controllerClientId = null;
	let role = "viewer";
	let eventSource = null;
	let lastCliCommand = null;
	let lastEventTime = 0;
	let heartbeatTimer = null;
	let syncStateTimer = null;
	let reconnectAttempts = 0;
	const MAX_RECONNECT_ATTEMPTS = 5;
	let suspendedForBackground = false;
	let connectGraceUntil = 0;
	let lostSessionTimer = null;
	let resumeTimer = null;
	let resumeGeneration = 0;

	let pendingPrompt = false;
	let actionBusy = null;

	const chatView = createChatView({ msgsEl, isPhoneLikeFn, onReusePrompt });

	function clearResumeTimer() {
		if (resumeTimer) {
			clearTimeout(resumeTimer);
			resumeTimer = null;
		}
	}

	function closeEvents() {
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
		if (syncStateTimer) { clearInterval(syncStateTimer); syncStateTimer = null; }
		if (lostSessionTimer) { clearTimeout(lostSessionTimer); lostSessionTimer = null; }
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	function deferLostDuringGrace() {
		if (!activeSessionId) return false;
		const remaining = connectGraceUntil - Date.now();
		if (remaining <= 0) return false;
		if (lostSessionTimer) return true;
		lostSessionTimer = setTimeout(() => {
			lostSessionTimer = null;
			if (!activeSessionId) return;
			void refreshState({ silent: true }).then((ok) => {
				if (ok) {
					connectEvents(activeSessionId);
					return;
				}
				handleSessionLost();
			});
		}, remaining + 100);
		return true;
	}

	async function refreshState(options = {}) {
		if (!activeSessionId) return false;
		try {
			const state = await api.getJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/state`);
			activeState = state;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;
			const shouldSyncMessages = options.syncMessages === true || (options.syncMessages !== false && !state?.isStreaming);
			if (shouldSyncMessages) {
				if (!state?.isStreaming && !pendingPrompt) chatView.replaceFromMessages(state?.messages || []);
				else chatView.syncFromMessages(state?.messages || []);
			}
			if (!state?.isStreaming) {
				pendingPrompt = false;
				if (actionBusy === "abort") actionBusy = null;
			}
			if (actionBusy === "reconnect") actionBusy = null;
			onStateChange();
			return true;
		} catch (error) {
			if (!options.silent && isSessionGoneError(error)) {
				if (!deferLostDuringGrace()) handleSessionLost();
			}
			return false;
		}
	}

	function connectEvents(sessionId) {
		closeEvents();
		connectGraceUntil = Date.now() + 8000;

		const qs = new URLSearchParams({ clientId });
		if (token) qs.set("token", token);

		eventSource = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?${qs.toString()}`);
		lastEventTime = Date.now();
		eventSource.onopen = () => {
			lastEventTime = Date.now();
			reconnectAttempts = 0;
			suspendedForBackground = false;
			if (activeSessionId) void refreshState({ silent: true, syncMessages: false });
		};
		eventSource.onmessage = (msg) => {
			lastEventTime = Date.now();
			reconnectAttempts = 0;
			const payload = JSON.parse(msg.data);
			handleSse(payload);
		};
		eventSource.onerror = () => {
			if (!activeSessionId) return;
			if (document.visibilityState === "hidden" || suspendedForBackground) return;
			if (deferLostDuringGrace()) return;
			reconnectAttempts++;
			if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
				handleSessionLost();
				return;
			}
			if (Date.now() - lastEventTime > 15_000) {
				connectEvents(activeSessionId);
			}
		};

		// Heartbeat: if no event for 12s (server pings every 5s), re-sync state first, then reconnect.
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			if (!activeSessionId || !eventSource) return;
			if (document.visibilityState === "hidden" || suspendedForBackground) return;
			if (Date.now() - lastEventTime > 12_000) {
				if (deferLostDuringGrace()) return;
				reconnectAttempts++;
				if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
					handleSessionLost();
					return;
				}
				void refreshState({ silent: true, syncMessages: false }).finally(() => {
					if (activeSessionId) connectEvents(activeSessionId);
				});
			}
		}, 6_000);

		// Extra stale-state hardening: while the UI thinks work is happening, poll state.
		if (syncStateTimer) clearInterval(syncStateTimer);
		syncStateTimer = setInterval(() => {
			if (!activeSessionId) return;
			const shouldSync = pendingPrompt || Boolean(activeState?.isStreaming) || Boolean(actionBusy);
			if (!shouldSync) return;
			void refreshState({ silent: true, syncMessages: false });
		}, 4_000);
	}

	function handleSessionLost() {
		resumeGeneration += 1;
		clearResumeTimer();
		closeEvents();
		const oldId = activeSessionId;
		if (oldId && typeof onSessionEnded === "function") onSessionEnded(oldId);
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";
		pendingPrompt = false;
		actionBusy = null;
		reconnectAttempts = 0;
		connectGraceUntil = 0;
		chatView.appendNotice(`Session disconnected${oldId ? " (" + oldId.slice(0, 8) + ")" : ""}. Open the sidebar to resume or start a new session.`, "error");
		onStateChange();
		onSidebarRefresh();
	}

	function resumeAfterBackground() {
		if (!activeSessionId) return;
		const generation = ++resumeGeneration;
		clearResumeTimer();
		reconnectAttempts = 0;
		suspendedForBackground = false;
		resumeTimer = setTimeout(() => {
			resumeTimer = null;
			if (!activeSessionId || document.visibilityState !== "visible" || generation !== resumeGeneration) return;
			void refreshState({ silent: true, syncMessages: false }).finally(() => {
				if (!activeSessionId || document.visibilityState !== "visible" || generation !== resumeGeneration) return;
				connectEvents(activeSessionId);
				clearResumeTimer();
				resumeTimer = setTimeout(() => {
					resumeTimer = null;
					if (activeSessionId && document.visibilityState === "visible" && generation === resumeGeneration) {
						void refreshState({ silent: true, syncMessages: false });
					}
				}, 1500);
			});
		}, 250);
	}

	function suspendForBackground() {
		if (!activeSessionId) return;
		resumeGeneration += 1;
		clearResumeTimer();
		suspendedForBackground = true;
		closeEvents();
	}

	// Reconnect when app returns from background (iOS PWA)
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			suspendForBackground();
			return;
		}
		if (document.visibilityState === "visible") {
			resumeAfterBackground();
		}
	});
	window.addEventListener("pagehide", () => {
		suspendForBackground();
	});
	window.addEventListener("pageshow", () => {
		resumeAfterBackground();
	});

	function handleSse(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "init") {
			const previousState = activeState;
			const isReconnectInit = Boolean(
				previousState
				&& event.state
				&& typeof previousState.sessionId === "string"
				&& previousState.sessionId === event.state.sessionId,
			);
			activeState = event.state;
			pendingPrompt = false;
			actionBusy = null;
			connectGraceUntil = 0;
			controllerClientId = event.controllerClientId || null;
			role = event.role;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;

			if (isReconnectInit) {
				// Reconnect: preserve notices, just sync messages
				if (activeState?.isStreaming || pendingPrompt) chatView.syncFromMessages(activeState.messages || []);
				else chatView.replaceFromMessages(activeState.messages || []);
			} else {
				// Fresh session load: discard notices (new data is here)
				onCloseMenu();
				chatView.clear({ discardNotices: true });
				chatView.renderHistory(activeState.messages || []);
			}
			onStateChange();
			if (!isReconnectInit) chatView.scrollToBottom(true);
			return;
		}

		if (event.type === "state_patch") {
			if (!activeState) return;
			if (event.patch && typeof event.patch === "object") {
				Object.assign(activeState, event.patch);
				if (event.patch.isStreaming === false) {
					pendingPrompt = false;
					if (actionBusy === "abort") actionBusy = null;
					if (activeSessionId) void refreshState({ silent: true, syncMessages: true });
				}
				onStateChange();
			}
			return;
		}

		if (event.type === "controller_changed") {
			controllerClientId = event.controllerClientId || null;
			role = controllerClientId === clientId ? "controller" : "viewer";
			if (controllerClientId === clientId && actionBusy === "takeover") actionBusy = null;
			onStateChange();
			return;
		}

		if (event.type === "released") {
			onCloseMenu();
			const cmd = lastCliCommand;
			const endedSessionId = activeSessionId;
			resumeGeneration += 1;
			clearResumeTimer();
			closeEvents();
			if (endedSessionId && typeof onSessionEnded === "function") onSessionEnded(endedSessionId);
			activeSessionId = null;
			activeState = null;
			controllerClientId = null;
			role = "viewer";
			pendingPrompt = false;
			actionBusy = null;

			chatView.renderReleased({ cliCommand: cmd });
			onStateChange();
			onSidebarRefresh();
			return;
		}

		if (event.type === "ask_request") {
			if (controllerClientId !== clientId) return;
			if (typeof onAskRequest === "function" && activeSessionId) {
				onAskRequest(activeSessionId, event.askId, event.questions);
			}
			return;
		}

		if (event.type === "ui_select") {
			if (controllerClientId !== clientId) return;
			if (typeof onUiSelect === "function") {
				onUiSelect(event.uiId, event.title, event.options);
			}
			return;
		}

		if (event.type === "ui_input") {
			if (controllerClientId !== clientId) return;
			if (typeof onUiInput === "function") {
				onUiInput(event.uiId, event.title, event.placeholder);
			}
			return;
		}

		if (event.type === "ui_confirm") {
			if (controllerClientId !== clientId) return;
			if (typeof onUiConfirm === "function") {
				onUiConfirm(event.uiId, event.title, event.message);
			}
			return;
		}

		if (event.type === "ui_notify") {
			const prefix = event.level === "error" ? "❌ " : event.level === "warning" ? "⚠️ " : "ℹ️ ";
			chatView.appendNotice(prefix + event.message, event.level || "info");
			return;
		}

		if (event.type === "agent_event") {
			handleAgentEvent(event.event);
			return;
		}
	}

	function handleAgentEvent(event) {
		if (!event || typeof event.type !== "string") return;

		if (event.type === "turn_start") {
			pendingPrompt = false;
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "agent_start") {
			pendingPrompt = false;
			if (activeState) activeState.isStreaming = true;
			onStateChange();
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "agent_end") {
			if (activeState) activeState.isStreaming = false;
			pendingPrompt = false;
			if (actionBusy === "abort") actionBusy = null;
			onStateChange();
			chatView.handleAgentEvent(event);
			if (activeSessionId) void refreshState({ silent: true, syncMessages: true });
			return;
		}

		if (event.type === "message_start") {
			if (event.message && event.message.role === "assistant") {
				pendingPrompt = false;
				chatView.handleAgentEvent(event);
				return;
			}
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "message_update") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "message_end") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_start") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_update") {
			chatView.handleAgentEvent(event);
			return;
		}

		if (event.type === "tool_execution_end") {
			chatView.handleAgentEvent(event);
			return;
		}
	}

	async function runReplay(name) {
		const safeName = name.trim();
		if (!safeName) return;

		onCloseMenu();
		closeEvents();
		activeSessionId = null;
		activeState = null;
		controllerClientId = null;
		role = "viewer";

		chatView.clear();
		chatView.appendNotice(`Loading replay: ${safeName}`);

		try {
			const res = await fetch(`/fixtures/${encodeURIComponent(safeName)}.json`, { headers: api.headers() });
			if (!res.ok) {
				throw new Error(`${res.status} ${res.statusText}`);
			}
			const events = await res.json();
			if (!Array.isArray(events)) {
				throw new Error("Invalid replay fixture (expected JSON array)");
			}

			chatView.clear();
			const init = events.find((ev) => ev && typeof ev === "object" && ev.type === "init");
			if (init && init.state && typeof init.state.sessionId === "string") {
				activeSessionId = init.state.sessionId;
			} else {
				activeSessionId = "replay";
			}

			for (const ev of events) {
				if (ev && typeof ev === "object" && ev.type === "init") {
					handleSse({
						...ev,
						yourClientId: clientId,
						controllerClientId: clientId,
						role: "controller",
					});
					continue;
				}
				handleSse(ev);
			}
		} catch (error) {
			chatView.clear();
			chatView.appendNotice(`Replay failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			document.documentElement.dataset.replayDone = "1";
		}
	}

	async function selectSession(session) {
		if (!session) {
			closeEvents();
			activeSessionId = null;
			activeState = null;
			pendingPrompt = false;
			actionBusy = null;
			onStateChange();
			return;
		}
		// Show loading immediately before any async work
		chatView.showLoading("Loading session…");
		if (session.isRunning) {
			try {
				activeSessionId = session.id;
				// Connect events and fetch state in parallel with takeover
				connectEvents(activeSessionId);
				await Promise.all([
					api.getJson(`/api/sessions/${encodeURIComponent(session.id)}/state`),
					api.postJson(`/api/sessions/${encodeURIComponent(session.id)}/takeover`, { clientId }).catch(() => {}),
				]);
				onSidebarClose();
				onStateChange();
				return;
			} catch (error) {
				if (!session.path) throw error;
				// The session was marked running in the sidebar but the live runtime is gone.
				// Fall back to reopening from disk instead of surfacing a transient load failure.
			}
		}

		if (!session.path) {
			throw new Error("Missing session path");
		}

		const result = await api.postJson("/api/sessions", { clientId, resumeSessionPath: session.path });
		activeSessionId = result.sessionId;
		connectEvents(activeSessionId);
		onSidebarClose();
		onStateChange();
	}

	function isSessionGoneError(error) {
		const msg = error instanceof Error ? error.message : String(error);
		return msg.includes("session_not_running") || msg.includes("Session not running") || msg.includes("not_running");
	}

	async function sendAskResponse(askId, cancelled, selections) {
		if (!activeSessionId) return;
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "ask_response",
				clientId,
				askId,
				cancelled,
				selections,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				await refreshState({ silent: true, syncMessages: false });
				chatView.appendNotice("This question moved to another client.", "warning");
				return;
			}
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(msg, "error");
		}
	}

	async function sendUiResponse(uiId, cancelled, value) {
		if (!activeSessionId) return;
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "ui_response",
				clientId,
				uiId,
				cancelled,
				value,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				await refreshState({ silent: true, syncMessages: false });
				chatView.appendNotice("This prompt moved to another client.", "warning");
				return;
			}
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(msg, "error");
		}
	}

	async function runBash(commandText, options = {}) {
		if (!activeSessionId || actionBusy) return;
		const command = String(commandText || "").trim();
		if (!command) return;
		actionBusy = "bash";
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "bash",
				clientId,
				command,
				excludeFromContext: Boolean(options.excludeFromContext),
			});
			await refreshState({ silent: true, syncMessages: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				try {
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
					controllerClientId = clientId;
					role = "controller";
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
						type: "bash",
						clientId,
						command,
						excludeFromContext: Boolean(options.excludeFromContext),
					});
					await refreshState({ silent: true, syncMessages: true });
					return;
				} catch (retryError) {
					if (isSessionGoneError(retryError)) { handleSessionLost(); return; }
					chatView.appendNotice("Failed to take control of session", "error");
					return;
				}
			}
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(msg, "error");
		} finally {
			if (actionBusy === "bash") actionBusy = null;
			onStateChange();
		}
	}

	async function postPromptCommand(sessionId, text, images, options = {}) {
		await api.postJson(`/api/sessions/${encodeURIComponent(sessionId)}/command`, {
			type: "prompt",
			clientId,
			text,
			images,
			...(options.deliverAs && { deliverAs: options.deliverAs }),
		});
	}

	async function sendPromptToSession(sessionId, text, images = [], options = {}) {
		const targetSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
		if (!targetSessionId) return false;
		const trimmedText = typeof text === "string" ? text.trim() : "";
		const targetIsActive = targetSessionId === activeSessionId;
		if (targetIsActive && images.length === 0 && /^!!\s*\S/.test(trimmedText)) {
			await runBash(trimmedText.replace(/^!!\s*/, ""), { excludeFromContext: true });
			return true;
		}
		if (targetIsActive && images.length === 0 && /^!\s*\S/.test(trimmedText)) {
			await runBash(trimmedText.replace(/^!\s*/, ""), { excludeFromContext: false });
			return true;
		}

		const finishActivePrompt = async () => {
			if (!targetIsActive) return true;
			if (pendingPrompt && !activeState?.isStreaming) {
				pendingPrompt = false;
				onStateChange();
				if (options.syncAfterSend !== false) await refreshState({ silent: true, syncMessages: true });
			}
			return true;
		};

		if (targetIsActive) {
			pendingPrompt = true;
			if (options.optimistic !== false) {
				chatView.appendOptimisticUserMessage([
					...(text ? [{ type: "text", text }] : []),
					...images,
				]);
			}
			onStateChange();
		}

		try {
			await postPromptCommand(targetSessionId, text, images, options);
			await finishActivePrompt();
			return true;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				try {
					await api.postJson(`/api/sessions/${encodeURIComponent(targetSessionId)}/takeover`, { clientId });
					if (targetIsActive) {
						controllerClientId = clientId;
						role = "controller";
					}
					await postPromptCommand(targetSessionId, text, images, options);
					await finishActivePrompt();
					return true;
				} catch (retryError) {
					if (targetIsActive) {
						pendingPrompt = false;
						onStateChange();
					}
					if (isSessionGoneError(retryError)) {
						if (targetIsActive) handleSessionLost();
						else if (options.noticeOnError !== false) chatView.appendNotice(options.errorLabel || "Voice note target session is no longer running", "error");
						return false;
					}
					if (options.noticeOnError !== false) chatView.appendNotice(options.errorLabel || "Failed to take control of session", "error");
					return false;
				}
			}
			if (targetIsActive) {
				pendingPrompt = false;
				onStateChange();
			}
			if (isSessionGoneError(error)) {
				if (targetIsActive) handleSessionLost();
				else if (options.noticeOnError !== false) chatView.appendNotice(options.errorLabel || "Voice note target session is no longer running", "error");
				return false;
			}
			if (options.noticeOnError !== false) chatView.appendNotice(options.errorLabel || msg, "error");
			return false;
		}
	}

	async function sendPrompt(text, images = [], options = {}) {
		if (!activeSessionId) return false;
		return await sendPromptToSession(activeSessionId, text, images, { optimistic: true, ...options });
	}

	async function compact(customInstructions) {
		if (!activeSessionId || actionBusy) return;
		actionBusy = "compact";
		onStateChange();
		const payload = {
			type: "compact",
			clientId,
			...(typeof customInstructions === "string" && customInstructions.trim() ? { customInstructions: customInstructions.trim() } : {}),
		};
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, payload);
			if (activeSessionId) await refreshState({ silent: true, syncMessages: true });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				try {
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, payload);
					if (activeSessionId) await refreshState({ silent: true, syncMessages: true });
					return;
				} catch (retryError) {
					if (isSessionGoneError(retryError)) { handleSessionLost(); return; }
					chatView.appendNotice("Failed to take control of session", "error");
					return;
				}
			}
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(msg, "error");
		} finally {
			if (actionBusy === "compact") actionBusy = null;
			onStateChange();
		}
	}

	async function abortRun() {
		if (!activeSessionId) return;
		if (actionBusy === "bash") {
			try {
				await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, { type: "abort_bash", clientId });
			} catch (error) {
				if (isSessionGoneError(error)) { handleSessionLost(); return; }
				chatView.appendNotice(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (actionBusy === "bash") actionBusy = null;
				onStateChange();
			}
			return;
		}
		if (actionBusy) return;
		const hadPendingTools = chatView.hasPendingTools();
		const hadAssistant = chatView.hasAssistant();
		const hadStreaming = Boolean(activeState?.isStreaming);
		const shouldShowNotice = Boolean(hadStreaming || pendingPrompt || hadAssistant || hadPendingTools);
		actionBusy = "abort";
		pendingPrompt = false;
		if (activeState) activeState.isStreaming = false;
		onStateChange();
		chatView.markPendingToolsAborted("Operation aborted");
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, { type: "abort", clientId });
		} catch (error) {
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			if (actionBusy === "abort") actionBusy = null;
			onStateChange();
		}
		if (shouldShowNotice && !hadPendingTools && !hadAssistant && !hadStreaming) {
			chatView.appendNotice("Operation aborted", "error");
		}
	}

	async function reconnectTransport() {
		if (!activeSessionId) return;
		closeEvents();
		connectEvents(activeSessionId);
		await refreshState({ silent: true, syncMessages: false });
	}

	async function takeOver() {
		if (!activeSessionId || actionBusy) return;
		const alreadyController = controllerClientId === clientId;
		actionBusy = alreadyController ? "reconnect" : "takeover";
		onStateChange();
		try {
			if (!alreadyController) {
				await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
				controllerClientId = clientId;
				role = "controller";
			}
			await reconnectTransport();
		} catch (error) {
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			throw error;
		} finally {
			if (actionBusy === "takeover" || actionBusy === "reconnect") actionBusy = null;
			onStateChange();
		}
	}

	async function release() {
		if (!activeSessionId || actionBusy) return;
		actionBusy = "release";
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/release`, { clientId });
		} catch (error) {
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			throw error;
		} finally {
			if (actionBusy === "release") actionBusy = null;
			onStateChange();
		}
	}

	async function setSteeringMode(mode) {
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_steering_mode",
			clientId,
			mode,
		});
	}

	async function setFollowUpMode(mode) {
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_follow_up_mode",
			clientId,
			mode,
		});
	}

	async function setSessionName(name) {
		if (!activeSessionId) return;
		const trimmed = String(name || "").trim();
		if (!trimmed) throw new Error("Session name cannot be empty");
		const payload = { type: "set_session_name", clientId, name: trimmed };
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, payload);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
				controllerClientId = clientId;
				role = "controller";
				await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, payload);
				return;
			}
			throw error;
		}
	}

	function openSessionId(sessionId) {
		actionBusy = null;
		activeSessionId = sessionId;
		connectEvents(activeSessionId);
		onStateChange();
	}

	return {
		getActiveSessionId: () => activeSessionId,
		getActiveState: () => activeState,
		getControllerClientId: () => controllerClientId,
		getRole: () => role,
		getPendingPrompt: () => pendingPrompt,
		getActionBusy: () => actionBusy,
		refreshState,
		isController: () => Boolean(activeSessionId && controllerClientId === clientId),
		appendNotice: chatView.appendNotice,
		runReplay,
		selectSession,
		sendPrompt,
		sendPromptToSession,
		sendAskResponse,
		sendUiResponse,
		setSteeringMode,
		setFollowUpMode,
		setSessionName,
		abortRun,
		compact,
		runBash,
		takeOver,
		release,
		openSessionId,
	};
}
