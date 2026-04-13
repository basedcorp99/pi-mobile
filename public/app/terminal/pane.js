import { Terminal } from "/vendor/xterm/xterm.mjs"
import { FitAddon } from "/vendor/xterm/addon-fit.mjs"
import { SearchAddon } from "/vendor/xterm/addon-search.mjs"
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.mjs"

function wsUrlForSession(sessionId, clientId, token) {
	const base = window.location.protocol === "https:" ? "wss" : "ws"
	const url = new URL(`${base}://${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal`)
	url.searchParams.set("clientId", clientId)
	if (token) url.searchParams.set("token", token)
	return url.toString()
}

function estimateTerminalSize(stageEl) {
	const rect = stageEl?.getBoundingClientRect?.() || { width: 0, height: 0 }
	const cols = Math.max(80, Math.floor(Math.max(0, rect.width - 24) / 9))
	const rows = Math.max(22, Math.floor(Math.max(0, rect.height - 16) / 18))
	return { cols, rows }
}

function buildTerminalTheme() {
	const css = getComputedStyle(document.body)
	const bg = (css.getPropertyValue("--bg") || "#0c0c0e").trim() || "#0c0c0e"
	const fg = (css.getPropertyValue("--text-body") || "#d4d4da").trim() || "#d4d4da"
	const accent = (css.getPropertyValue("--accent") || "#7EC8C0").trim() || "#7EC8C0"
	const muted = (css.getPropertyValue("--text-muted") || "#636370").trim() || "#636370"
	return {
		background: document.body.classList.contains("light") ? "#f4f7fb" : "#090c11",
		foreground: fg,
		cursor: accent,
		cursorAccent: bg,
		selectionBackground: document.body.classList.contains("light") ? "rgba(45, 138, 126, 0.18)" : "rgba(126, 200, 192, 0.22)",
		black: "#0f1720",
		red: "#f87171",
		green: "#6ee7a0",
		yellow: "#fbbf40",
		blue: "#60a5fa",
		magenta: "#c084fc",
		cyan: accent,
		white: fg,
		brightBlack: muted,
		brightRed: "#fca5a5",
		brightGreen: "#86efac",
		brightYellow: "#fde68a",
		brightBlue: "#93c5fd",
		brightMagenta: "#d8b4fe",
		brightCyan: "#99f6e4",
		brightWhite: "#ffffff",
	}
}

function buildSearchOptions() {
	return {
		decorations: {
			matchBackground: "rgba(126, 200, 192, 0.12)",
			matchBorder: "rgba(126, 200, 192, 0.2)",
			matchOverviewRuler: "rgba(126, 200, 192, 0.28)",
			activeMatchBackground: "rgba(126, 200, 192, 0.28)",
			activeMatchBorder: "rgba(126, 200, 192, 0.55)",
			activeMatchColorOverviewRuler: "rgba(126, 200, 192, 0.55)",
		},
	}
}

function decodeTerminalSequence(raw) {
	return String(raw || "")
		.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\t/g, "\t")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
}

function ctrlSequenceForKeyEvent(event) {
	const key = String(event?.key || "")
	if (!key) return null
	if (key.length === 1) {
		const upper = key.toUpperCase()
		if (upper >= "A" && upper <= "Z") return String.fromCharCode(upper.charCodeAt(0) - 64)
		if (upper === "@" || key === "2" || key === " ") return "\x00"
		if (key === "[") return "\x1b"
		if (key === "\\") return "\x1c"
		if (key === "]") return "\x1d"
		if (key === "6" || key === "^") return "\x1e"
		if (key === "-" || key === "_") return "\x1f"
	}
	if (key === "Enter") return "\n"
	return null
}

function formatTabStatus(snapshot) {
	if (!snapshot) return ""
	if (snapshot.status === "exited") {
		const code = snapshot.exitCode
		const signal = snapshot.signal
		if (code !== null && code !== undefined) return `Exited · code ${code}`
		if (signal !== null && signal !== undefined && signal !== "") return `Exited · signal ${signal}`
		return "Exited"
	}
	return "Running"
}

export function createTerminalPane({
	rootEl,
	clientId,
	token,
	isPhoneLikeFn,
	onNotice,
	onOpenChange,
}) {
	const isOverlayLayout = () => !window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1025px)").matches
	const tabsEl = rootEl.querySelector("#terminal-tabs")
	const stageEl = rootEl.querySelector("#terminal-stage")
	const emptyEl = rootEl.querySelector("#terminal-empty")
	const statusEl = rootEl.querySelector("#terminal-status")
	const searchEl = rootEl.querySelector("#terminal-search")
	const searchInput = rootEl.querySelector("#terminal-search-input")
	const btnClose = rootEl.querySelector("#btn-terminal-close")
	const btnFind = rootEl.querySelector("#btn-terminal-find")
	const btnCopy = rootEl.querySelector("#btn-terminal-copy")
	const btnPaste = rootEl.querySelector("#btn-terminal-paste")
	const btnNew = rootEl.querySelector("#btn-terminal-new")
	const btnSearchPrev = rootEl.querySelector("#btn-terminal-search-prev")
	const btnSearchNext = rootEl.querySelector("#btn-terminal-search-next")
	const btnSearchClose = rootEl.querySelector("#btn-terminal-search-close")
	const btnCtrl = rootEl.querySelector("#terminal-key-ctrl")
	const mobileKeyButtons = Array.from(rootEl.querySelectorAll(".terminal-key[data-seq]"))

	const state = {
		open: false,
		sessionId: null,
		cwd: "",
		canWrite: false,
		ws: null,
		connecting: false,
		connected: false,
		reconnectTimer: null,
		reconnectAttempts: 0,
		tabs: new Map(),
		activeTabId: null,
		stickyCtrl: false,
		searchOpen: false,
		expectNewTabFocus: false,
		lastStatus: "",
		lastStatusKind: "",
	}

	function notice(message, kind = "info") {
		if (typeof onNotice === "function") onNotice(message, kind)
	}

	function clearReconnectTimer() {
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
		}
	}

	function clearLocalTabs() {
		for (const local of state.tabs.values()) {
			try { local.term.dispose() } catch {}
			try { local.buttonEl.remove() } catch {}
			try { local.viewEl.remove() } catch {}
		}
		state.tabs.clear()
		state.activeTabId = null
	}

	function setStatus(text, kind = "") {
		state.lastStatus = text || ""
		state.lastStatusKind = kind || ""
		statusEl.textContent = state.lastStatus || ""
		if (state.lastStatusKind) statusEl.dataset.kind = state.lastStatusKind
		else delete statusEl.dataset.kind
	}

	function renderEmptyState() {
		const hasTabs = state.tabs.size > 0
		emptyEl.hidden = hasTabs
		if (hasTabs) return
		if (!state.sessionId) {
			emptyEl.textContent = "Open a session to start a terminal."
			setStatus("Open a session to start a terminal.")
			return
		}
		if (state.connecting) {
			emptyEl.textContent = "Connecting terminal…"
			setStatus("Connecting terminal…", "warning")
			return
		}
		if (!state.connected) {
			emptyEl.textContent = "Terminal disconnected. Reconnecting…"
			setStatus("Terminal disconnected. Reconnecting…", "warning")
			return
		}
		if (state.canWrite) {
			emptyEl.textContent = state.cwd
				? `No terminal tabs yet. Use ＋ to start one in ${state.cwd}.`
				: "No terminal tabs yet. Use ＋ to start one."
			setStatus(state.cwd ? `Ready · ${state.cwd}` : "Ready", "ok")
			return
		}
		emptyEl.textContent = "Take over the session to create a terminal tab."
		setStatus("Read-only terminal", "warning")
	}

	function updateTerminalPermissions() {
		for (const local of state.tabs.values()) {
			local.term.options.disableStdin = !state.canWrite || local.snapshot.status !== "running"
		}
		renderCtrlState()
		renderStatus()
	}

	function renderStatus() {
		if (!state.sessionId) {
			setStatus("Open a session to start a terminal.")
			return
		}
		if (!state.connected) {
			setStatus(state.connecting ? "Connecting terminal…" : "Terminal disconnected. Reconnecting…", "warning")
			return
		}
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active) {
			renderEmptyState()
			return
		}
		const mode = state.canWrite ? "interactive" : "read-only"
		const detail = active.snapshot.cwd || state.cwd || ""
		setStatus(
			`${formatTabStatus(active.snapshot)} · ${mode}${detail ? ` · ${detail}` : ""}`,
			active.snapshot.status === "running" ? (state.canWrite ? "ok" : "warning") : "warning",
		)
	}

	function fitActiveTerminal() {
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active || !state.open) return
		requestAnimationFrame(() => {
			try {
				active.fitAddon.fit()
			} catch {}
		})
	}

	function selectTab(tabId, options = {}) {
		if (!state.tabs.has(tabId)) return
		state.activeTabId = tabId
		for (const local of state.tabs.values()) {
			const active = local.id === tabId
			local.viewEl.classList.toggle("active", active)
			local.buttonEl.classList.toggle("active", active)
		}
		renderStatus()
		fitActiveTerminal()
		if (options.focus !== false) focusActiveTerminal()
	}

	function applyTheme() {
		const theme = buildTerminalTheme()
		for (const local of state.tabs.values()) {
			local.term.options.theme = theme
			try {
				local.term.refresh(0, Math.max(0, local.term.rows - 1))
			} catch {}
		}
	}

	function closeSearch() {
		state.searchOpen = false
		searchEl.hidden = true
		for (const local of state.tabs.values()) {
			if (typeof local.searchAddon.clearDecorations === "function") local.searchAddon.clearDecorations()
		}
		focusActiveTerminal()
	}

	function openSearch() {
		if (!activeLocalTab()) {
			notice("Open a terminal tab first", "warning")
			return
		}
		state.searchOpen = true
		searchEl.hidden = false
		searchInput.focus()
		searchInput.select()
	}

	function performSearch(direction = "next") {
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active) return false
		const query = String(searchInput.value || "")
		if (!query.trim()) {
			if (typeof active.searchAddon.clearDecorations === "function") active.searchAddon.clearDecorations()
			return false
		}
		const opts = buildSearchOptions()
		return direction === "prev"
			? active.searchAddon.findPrevious(query, opts)
			: active.searchAddon.findNext(query, opts)
	}

	function renderCtrlState() {
		btnCtrl.classList.toggle("active", Boolean(state.stickyCtrl && state.canWrite))
		btnCtrl.disabled = !state.canWrite || state.tabs.size === 0
	}

	function activeLocalTab() {
		return state.activeTabId ? state.tabs.get(state.activeTabId) : null
	}

	function updateTabButton(local) {
		local.buttonEl.classList.toggle("exited", local.snapshot.status === "exited")
		local.labelEl.textContent = local.snapshot.label
		local.closeBtn.disabled = !state.canWrite
		local.term.options.disableStdin = !state.canWrite || local.snapshot.status !== "running"
	}

	function handleCustomKey(local, event) {
		if (event.type !== "keydown") return true
		if (state.searchOpen && event.key === "Escape") {
			closeSearch()
			event.preventDefault()
			return false
		}
		if (!state.canWrite || local.snapshot.status !== "running") return true
		if (!state.stickyCtrl) return true
		const seq = ctrlSequenceForKeyEvent(event)
		state.stickyCtrl = false
		renderCtrlState()
		if (!seq) return true
		event.preventDefault()
		send({ type: "input", tabId: local.id, data: seq })
		return false
	}

	function createLocalTab(snapshot) {
		const viewEl = document.createElement("div")
		viewEl.className = "terminal-view"
		stageEl.appendChild(viewEl)

		const buttonEl = document.createElement("button")
		buttonEl.className = "terminal-tab"
		buttonEl.type = "button"
		const labelEl = document.createElement("span")
		labelEl.className = "terminal-tab-label"
		const closeBtn = document.createElement("button")
		closeBtn.className = "terminal-tab-close"
		closeBtn.type = "button"
		closeBtn.textContent = "✕"
		closeBtn.title = "Close terminal tab"
		buttonEl.appendChild(labelEl)
		buttonEl.appendChild(closeBtn)
		tabsEl.appendChild(buttonEl)

		const term = new Terminal({
			allowTransparency: false,
			convertEol: false,
			cursorBlink: true,
			disableStdin: !state.canWrite || snapshot.status !== "running",
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
			fontSize: isPhoneLikeFn() ? 13 : 14,
			scrollback: 3000,
			theme: buildTerminalTheme(),
		})
		const fitAddon = new FitAddon()
		const searchAddon = new SearchAddon({ highlightLimit: 500 })
		const linksAddon = new WebLinksAddon((event, url) => {
			window.open(url, "_blank", "noopener")
		})
		const local = {
			id: snapshot.id,
			snapshot: { ...snapshot },
			term,
			fitAddon,
			searchAddon,
			viewEl,
			buttonEl,
			labelEl,
			closeBtn,
		}
		term.loadAddon(fitAddon)
		term.loadAddon(searchAddon)
		term.loadAddon(linksAddon)
		term.attachCustomKeyEventHandler((event) => handleCustomKey(local, event))
		term.open(viewEl)
		term.focus()
		term.onData((data) => {
			if (!state.canWrite || local.snapshot.status !== "running") return
			send({ type: "input", tabId: local.id, data })
		})
		term.onResize(({ cols, rows }) => {
			send({ type: "resize", tabId: local.id, cols, rows })
		})
		if (snapshot.history) {
			term.write(snapshot.history)
		}

		buttonEl.addEventListener("click", () => selectTab(local.id))
		closeBtn.addEventListener("click", (event) => {
			event.stopPropagation()
			if (!state.canWrite) {
				notice("Take over the session to close terminal tabs", "warning")
				return
			}
			send({ type: "close_tab", tabId: local.id })
		})
		viewEl.addEventListener("mousedown", () => selectTab(local.id, { focus: false }))
		viewEl.addEventListener("click", () => {
			selectTab(local.id, { focus: true })
			term.focus()
		})

		state.tabs.set(local.id, local)
		updateTabButton(local)
		return local
	}

	function handleInit(message) {
		const prevActive = state.activeTabId
		clearLocalTabs()
		for (const tab of message.tabs || []) {
			createLocalTab(tab)
		}
		const fallbackTabId = prevActive && state.tabs.has(prevActive)
			? prevActive
			: state.tabs.size > 0
				? [...state.tabs.keys()][0]
				: null
		if (fallbackTabId) selectTab(fallbackTabId, { focus: false })
		renderEmptyState()
		renderStatus()
		applyTheme()
		if (state.tabs.size === 0 && state.canWrite) {
			createNewTab()
		}
	}

	function handleTabOpened(message) {
		const local = createLocalTab(message.tab)
		if (!state.activeTabId || state.expectNewTabFocus) {
			selectTab(local.id)
		}
		state.expectNewTabFocus = false
		renderEmptyState()
		renderStatus()
	}

	function handleTabUpdated(message) {
		const local = state.tabs.get(message.tab?.id)
		if (!local) return
		local.snapshot = { ...local.snapshot, ...message.tab }
		updateTabButton(local)
		if (local.snapshot.status === "exited") state.stickyCtrl = false
		if (
			local.snapshot.cols
			&& local.snapshot.rows
			&& (local.term.cols !== local.snapshot.cols || local.term.rows !== local.snapshot.rows)
		) {
			try {
				local.term.resize(local.snapshot.cols, local.snapshot.rows)
			} catch {}
		}
		renderCtrlState()
		renderStatus()
	}

	function handleTabOutput(message) {
		const local = state.tabs.get(message.tabId)
		if (!local || typeof message.data !== "string" || message.data.length === 0) return
		local.term.write(message.data)
	}

	function handleTabClosed(message) {
		const local = state.tabs.get(message.tabId)
		if (!local) return
		const closingActive = state.activeTabId === message.tabId
		try { local.term.dispose() } catch {}
		try { local.buttonEl.remove() } catch {}
		try { local.viewEl.remove() } catch {}
		state.tabs.delete(message.tabId)
		if (closingActive) {
			const next = state.tabs.size > 0 ? [...state.tabs.keys()][0] : null
			if (next) selectTab(next)
			else {
				state.activeTabId = null
				renderEmptyState()
				renderStatus()
			}
		}
		renderEmptyState()
		renderStatus()
	}

	function handleServerError(message) {
		if (message?.message) notice(message.message, message.code === "not_controller" ? "warning" : "error")
		renderStatus()
	}

	function handleMessage(event) {
		let payload = null
		try {
			payload = JSON.parse(event.data)
		} catch {
			notice("Received invalid terminal payload", "error")
			return
		}
		if (!payload || typeof payload.type !== "string") return
		if (payload.type === "init") {
			state.connected = true
			state.connecting = false
			state.reconnectAttempts = 0
			handleInit(payload)
			return
		}
		if (payload.type === "tab_opened") {
			handleTabOpened(payload)
			return
		}
		if (payload.type === "tab_updated") {
			handleTabUpdated(payload)
			return
		}
		if (payload.type === "tab_output") {
			handleTabOutput(payload)
			return
		}
		if (payload.type === "tab_closed") {
			handleTabClosed(payload)
			return
		}
		if (payload.type === "error") {
			handleServerError(payload)
		}
	}

	function scheduleReconnect() {
		if (!state.open || !state.sessionId || state.ws || state.connecting || state.reconnectTimer) return
		if (document.visibilityState === "hidden") return
		const delay = Math.min(5000, 600 * Math.max(1, state.reconnectAttempts + 1))
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null
			connect()
		}, delay)
	}

	function closeSocket({ clearTabs = true } = {}) {
		clearReconnectTimer()
		const ws = state.ws
		state.ws = null
		state.connected = false
		state.connecting = false
		if (ws) {
			ws.onopen = null
			ws.onclose = null
			ws.onerror = null
			ws.onmessage = null
			try { ws.close() } catch {}
		}
		if (clearTabs) clearLocalTabs()
		state.stickyCtrl = false
		renderCtrlState()
		renderEmptyState()
	}

	function connect() {
		if (!state.open || !state.sessionId || state.ws || state.connecting) return
		if (document.visibilityState === "hidden") return
		clearReconnectTimer()
		state.connecting = true
		renderEmptyState()
		try {
			const ws = new WebSocket(wsUrlForSession(state.sessionId, clientId, token))
			state.ws = ws
			ws.onopen = () => {
				state.connecting = false
				renderStatus()
			}
			ws.onmessage = handleMessage
			ws.onerror = () => {
				// Close handler owns reconnection.
			}
			ws.onclose = () => {
				if (state.ws !== ws) return
				state.ws = null
				state.connected = false
				state.connecting = false
				state.reconnectAttempts += 1
				renderEmptyState()
				scheduleReconnect()
			}
		} catch (error) {
			state.connecting = false
			state.reconnectAttempts += 1
			notice(error instanceof Error ? error.message : String(error), "error")
			renderEmptyState()
			scheduleReconnect()
		}
	}

	function send(message) {
		if (!state.open || !state.sessionId) return false
		if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
			connect()
			return false
		}
		try {
			state.ws.send(JSON.stringify(message))
			return true
		} catch (error) {
			notice(error instanceof Error ? error.message : String(error), "error")
			return false
		}
	}

	function createNewTab() {
		if (!state.sessionId) {
			notice("Open a session first", "warning")
			return false
		}
		if (!state.canWrite) {
			notice("Take over the session to open a terminal", "warning")
			return false
		}
		const active = activeLocalTab()
		const size = active?.fitAddon?.proposeDimensions?.() || estimateTerminalSize(stageEl)
		state.expectNewTabFocus = true
		const sent = send({
			type: "create_tab",
			cwd: state.cwd || undefined,
			cols: size.cols,
			rows: size.rows,
		})
		if (!sent) renderEmptyState()
		return sent
	}

	function focusActiveTerminal() {
		const active = activeLocalTab()
		if (!active) return
		if (state.searchOpen) {
			searchInput.focus()
			return
		}
		try { active.term.focus() } catch {}
	}

	async function copySelection() {
		const active = activeLocalTab()
		if (!active) return
		let text = active.term.getSelection?.() || ""
		if (!text) {
			active.term.selectAll()
			text = active.term.getSelection?.() || ""
			active.term.clearSelection?.()
		}
		if (!text) {
			notice("Nothing to copy from the terminal yet", "warning")
			return
		}
		try {
			await navigator.clipboard.writeText(text)
			setStatus("Copied terminal text", "ok")
		} catch (error) {
			notice(error instanceof Error ? error.message : String(error), "error")
		}
	}

	async function pasteClipboard() {
		if (!state.canWrite) {
			notice("Take over the session to paste into the terminal", "warning")
			return
		}
		const active = activeLocalTab()
		if (!active) return
		try {
			const text = await navigator.clipboard.readText()
			if (!text) return
			send({ type: "input", tabId: active.id, data: text })
			focusActiveTerminal()
		} catch (error) {
			notice(error instanceof Error ? error.message : String(error), "error")
		}
	}

	function sendMobileSequence(sequence) {
		if (!state.canWrite) {
			notice("Take over the session to use the terminal", "warning")
			return
		}
		const active = activeLocalTab()
		if (!active) return
		state.stickyCtrl = false
		renderCtrlState()
		send({ type: "input", tabId: active.id, data: sequence })
		focusActiveTerminal()
	}

	function setOpen(open, options = {}) {
		const next = Boolean(open)
		if (state.open === next) {
			if (state.open && options.focus !== false) focusActiveTerminal()
			return
		}
		state.open = next
		rootEl.classList.toggle("open", next)
		document.body.classList.toggle("terminal-open", next && isOverlayLayout())
		if (typeof onOpenChange === "function") onOpenChange(next)
		if (!next) {
			closeSearch()
			closeSocket({ clearTabs: true })
			return
		}
		renderEmptyState()
		connect()
		fitActiveTerminal()
		if (options.focus !== false) focusActiveTerminal()
	}

	function syncSession({ sessionId, cwd, canWrite }) {
		const normalizedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null
		const normalizedCwd = typeof cwd === "string" ? cwd : ""
		const changedSession = normalizedSessionId !== state.sessionId
		state.sessionId = normalizedSessionId
		state.cwd = normalizedCwd
		state.canWrite = Boolean(canWrite)
		if (changedSession) {
			closeSearch()
			closeSocket({ clearTabs: true })
		}
		updateTerminalPermissions()
		if (state.open && state.sessionId) connect()
		renderEmptyState()
		renderStatus()
	}

	function toggle() {
		setOpen(!state.open)
	}

	function handleGlobalKeydown(event) {
		if (!state.open) return false
		if (state.searchOpen && event.key === "Escape") {
			event.preventDefault()
			closeSearch()
			return true
		}
		const focusedInside = rootEl.contains(document.activeElement)
		if (state.stickyCtrl && event.key === "Escape" && focusedInside) {
			state.stickyCtrl = false
			renderCtrlState()
			event.preventDefault()
			return true
		}
		if (event.key === "Escape" && focusedInside) {
			return true
		}
		if (isOverlayLayout() && event.key === "Escape" && !focusedInside) {
			event.preventDefault()
			setOpen(false, { focus: false })
			return true
		}
		return false
	}

	btnClose.addEventListener("click", () => setOpen(false, { focus: false }))
	btnFind.addEventListener("click", () => {
		if (state.searchOpen) closeSearch()
		else openSearch()
	})
	btnCopy.addEventListener("click", () => { void copySelection() })
	btnPaste.addEventListener("click", () => { void pasteClipboard() })
	btnNew.addEventListener("click", () => { createNewTab() })
	btnSearchPrev.addEventListener("click", () => performSearch("prev"))
	btnSearchNext.addEventListener("click", () => performSearch("next"))
	btnSearchClose.addEventListener("click", () => closeSearch())
	searchInput.addEventListener("input", () => { performSearch("next") })
	searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault()
			performSearch(event.shiftKey ? "prev" : "next")
			return
		}
		if (event.key === "Escape") {
			event.preventDefault()
			closeSearch()
		}
	})
	btnCtrl.addEventListener("click", () => {
		if (!state.canWrite) {
			notice("Take over the session to use the terminal", "warning")
			return
		}
		state.stickyCtrl = !state.stickyCtrl
		renderCtrlState()
		focusActiveTerminal()
	})
	for (const button of mobileKeyButtons) {
		button.addEventListener("click", () => {
			sendMobileSequence(decodeTerminalSequence(button.dataset.seq || ""))
		})
	}

	new ResizeObserver(() => fitActiveTerminal()).observe(stageEl)
	window.addEventListener("resize", () => fitActiveTerminal())
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && state.open && state.sessionId && !state.ws) {
			connect()
		}
	})

	renderCtrlState()
	renderEmptyState()

	return {
		setOpen,
		toggle,
		isOpen: () => state.open,
		isOverlayOpen: () => state.open && isOverlayLayout(),
		syncSession,
		refreshTheme: applyTheme,
		handleGlobalKeydown,
	}
}
