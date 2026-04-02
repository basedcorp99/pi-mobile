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

	let pendingPrompt = false;
	let actionBusy = null;

	const chatView = createChatView({ msgsEl, isPhoneLikeFn });

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
			if (shouldSyncMessages) chatView.syncFromMessages(state?.messages || []);
			if (!state?.isStreaming) {
				pendingPrompt = false;
				if (actionBusy === "abort") actionBusy = null;
			}
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
		connectGraceUntil = Date.now() + 3000;

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
		closeEvents();
		const oldId = activeSessionId;
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
		reconnectAttempts = 0;
		suspendedForBackground = false;
		setTimeout(() => {
			if (!activeSessionId) return;
			void refreshState({ silent: true, syncMessages: false }).finally(() => {
				if (activeSessionId) connectEvents(activeSessionId);
				setTimeout(() => {
					if (activeSessionId && document.visibilityState === "visible") void refreshState({ silent: true, syncMessages: false });
				}, 1500);
			});
		}, 250);
	}

	function suspendForBackground() {
		if (!activeSessionId) return;
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
			onCloseMenu();
			activeState = event.state;
			pendingPrompt = false;
			actionBusy = null;
			connectGraceUntil = 0;
			controllerClientId = event.controllerClientId || null;
			role = event.role;
			lastCliCommand = computeCliCommand(activeState) || lastCliCommand;

			chatView.clear();
			chatView.renderHistory(activeState.messages || []);
			onStateChange();
			chatView.scrollToBottom();
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
			closeEvents();
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
			if (typeof onAskRequest === "function") {
				onAskRequest(event.askId, event.questions);
			}
			return;
		}

		if (event.type === "ui_select") {
			if (typeof onUiSelect === "function") {
				onUiSelect(event.uiId, event.title, event.options);
			}
			return;
		}

		if (event.type === "ui_input") {
			if (typeof onUiInput === "function") {
				onUiInput(event.uiId, event.title, event.placeholder);
			}
			return;
		}

		if (event.type === "ui_confirm") {
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
		if (session.isRunning) {
			try {
				await api.getJson(`/api/sessions/${encodeURIComponent(session.id)}/state`);
				activeSessionId = session.id;
				connectEvents(activeSessionId);
				// Auto-takeover so we can actually send commands
				try {
					await api.postJson(`/api/sessions/${encodeURIComponent(session.id)}/takeover`, { clientId });
				} catch {
					// might fail if streaming, will retry on first prompt
				}
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
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "ask_response",
			clientId,
			askId,
			cancelled,
			selections,
		});
	}

	async function sendUiResponse(uiId, cancelled, value) {
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "ui_response",
			clientId,
			uiId,
			cancelled,
			value,
		});
	}

	async function sendPrompt(text, images = []) {
		if (!activeSessionId) return;
		pendingPrompt = true;
		chatView.appendOptimisticUserMessage([
			...(text ? [{ type: "text", text }] : []),
			...images,
		]);
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
				type: "prompt",
				clientId,
				text,
				images,
			});
			// If the prompt returned without starting an agent run (e.g. extension
			// commands like /subagents that don't emit agent_start), clear the
			// pending state so the UI doesn't get stuck on "working".
			if (pendingPrompt && !activeState?.isStreaming) {
				pendingPrompt = false;
				onStateChange();
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// Auto-takeover on "Not controller" and retry once
			if (msg.includes("Not controller") || msg.includes("not_controller")) {
				try {
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
					await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
						type: "prompt", clientId, text, images,
					});
					if (pendingPrompt && !activeState?.isStreaming) {
						pendingPrompt = false;
						onStateChange();
					}
					return;
				} catch (retryError) {
					pendingPrompt = false;
					onStateChange();
					if (isSessionGoneError(retryError)) { handleSessionLost(); return; }
					chatView.appendNotice("Failed to take control of session", "error");
					return;
				}
			}
			pendingPrompt = false;
			onStateChange();
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			chatView.appendNotice(msg, "error");
		}
	}

	async function abortRun() {
		if (!activeSessionId || actionBusy) return;
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

	async function takeOver() {
		if (!activeSessionId || actionBusy) return;
		actionBusy = "takeover";
		onStateChange();
		try {
			await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/takeover`, { clientId });
			controllerClientId = clientId;
			role = "controller";
		} catch (error) {
			if (isSessionGoneError(error)) { handleSessionLost(); return; }
			throw error;
		} finally {
			if (actionBusy === "takeover") actionBusy = null;
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
		sendAskResponse,
		sendUiResponse,
		setSteeringMode,
		setFollowUpMode,
		abortRun,
		takeOver,
		release,
		openSessionId,
	};
}
