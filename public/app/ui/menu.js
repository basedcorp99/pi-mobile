function normalizeForSearch(text) {
	return String(text || "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "");
}

function fuzzyCharsMatch(query, hay) {
	const q = normalizeForSearch(query);
	const h = normalizeForSearch(hay);
	if (!q) return true;
	let qi = 0;
	for (let i = 0; i < h.length && qi < q.length; i += 1) {
		if (h[i] === q[qi]) qi += 1;
	}
	return qi === q.length;
}

function fuzzyMatch(query, hay) {
	const tokens = String(query || "")
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return true;
	const h = String(hay || "").toLowerCase();
	return tokens.every((t) => h.includes(t) || fuzzyCharsMatch(t, h));
}

export function getCommandMenuEntries(commands) {
	const review = Array.isArray(commands)
		? commands.find((cmd) => cmd && typeof cmd === "object" && String(cmd.name || "").toLowerCase() === "review") || null
		: null;
	return [
		{ key: "agents", title: "subagents", description: "Open the subagents modal", kind: "agents" },
		{
			key: "review",
			title: "review",
			description: review?.description || "Start an interactive code review",
			kind: "review",
			command: review,
			disabled: !review,
		},
	];
}

export async function handleCommandMenuAction({ entry, state, onExecuteCommand, onInsertCommand, onNotice }) {
	if (!entry || entry.disabled) return { ok: false, reason: "disabled" };

	if (entry.kind === "agents") {
		return { ok: true, action: "agents" };
	}
	if (entry.kind === "review") {
		return { ok: true, action: "review" };
	}

	const cmd = entry.command;
	if (!cmd) return { ok: false, reason: "missing-command" };

	if (!cmd.executeImmediately) {
		if (typeof onInsertCommand === "function") onInsertCommand(`/${cmd.name} `);
		return { ok: true, action: "insert", command: cmd.name };
	}

	if (state.executingCommand) {
		return { ok: false, reason: "busy", command: state.executingCommand };
	}

	state.executingCommand = cmd.name;
	try {
		if (typeof onExecuteCommand === "function") await onExecuteCommand(`/${cmd.name}`);
		return { ok: true, action: "execute", command: cmd.name };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof onNotice === "function") onNotice(message, "error");
		return { ok: false, reason: "error", message };
	} finally {
		state.executingCommand = null;
	}
}

export function createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	btnCommands,
	btnSettings,
	api,
	clientId,
	onNotice,
	getActiveSessionId,
	getActiveState,
	getPrefs,
	onToggleTheme,
	onToggleSendOnEnter,
	onAdjustFontScale,
	onTogglePush,
	onTestPush,
	onSetSteeringMode,
	onSetFollowUpMode,
	onInsertCommand,
	onExecuteCommand,
	onRunAgent,
	onRunReview,
}) {
	let open = false;
	let cachedModels = null;
	let cachedModelsAtMs = 0;

	function close() {
		if (!menuOverlay || !menuPanel) return;
		open = false;
		menuOverlay.classList.remove("open");
		delete menuOverlay.dataset.locked;
		delete menuOverlay.dataset.kind;
		menuPanel.innerHTML = "";
		menuPanel.style.transform = "";
		menuPanel.style.width = "";
		menuPanel.style.maxWidth = "";
		menuPanel.style.maxHeight = "";
	}

	function position(anchor) {
		if (!menuPanel) return;
		const rect = anchor.getBoundingClientRect();
		const margin = 8;

		// Clamp after render so we can read panel size.
		requestAnimationFrame(() => {
			const panelRect = menuPanel.getBoundingClientRect();
			// Default: open below, centered to anchor.
			let left = rect.left + rect.width / 2 - panelRect.width / 2;
			let top = rect.bottom + 6;

			const maxLeft = window.innerWidth - panelRect.width - margin;
			const maxTop = window.innerHeight - panelRect.height - margin;

			left = Math.max(margin, Math.min(left, maxLeft));
			top = Math.max(margin, Math.min(top, maxTop));

			// If it doesn't fit below, try above.
			if (rect.bottom + 6 + panelRect.height > window.innerHeight - margin && rect.top - 6 - panelRect.height >= margin) {
				top = rect.top - 6 - panelRect.height;
			}

			menuPanel.style.left = `${left}px`;
			menuPanel.style.top = `${top}px`;
		});
	}

	function openMenu(anchor, build) {
		if (!menuOverlay || !menuPanel) return;
		open = true;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "0px";
		menuPanel.style.top = "0px";
		menuPanel.style.transform = "";
		menuPanel.style.width = "";
		menuPanel.style.maxWidth = "";
		menuPanel.style.maxHeight = "";
		build(menuPanel);
		position(anchor);
	}

	async function getAvailableModels() {
		if (cachedModels && Date.now() - cachedModelsAtMs < 30_000) return cachedModels;
		const data = await api.getJson("/api/models");
		const models = Array.isArray(data.models) ? data.models : [];
		cachedModels = models;
		cachedModelsAtMs = Date.now();
		return models;
	}

	async function setModel(provider, modelId) {
		const activeSessionId = getActiveSessionId();
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_model",
			clientId,
			provider,
			modelId,
		});
	}

	async function setThinkingLevel(level) {
		const activeSessionId = getActiveSessionId();
		if (!activeSessionId) return;
		await api.postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/command`, {
			type: "set_thinking_level",
			clientId,
			level,
		});
	}

	async function openModelMenu() {
		if (!btnModel || btnModel.disabled) return;
		if (menuOverlay) menuOverlay.dataset.locked = "1";
		openMenu(btnModel, (panel) => {
			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "Model";
			const actions = document.createElement("div");
			actions.style.display = "flex";
			actions.style.gap = "6px";
			const refresh = document.createElement("button");
			refresh.className = "menu-mini";
			refresh.textContent = "Refresh";
			refresh.addEventListener("click", async () => {
				cachedModels = null;
				cachedModelsAtMs = 0;
				await openModelMenu();
			});
			const closeBtn = document.createElement("button");
			closeBtn.className = "menu-mini";
			closeBtn.textContent = "Close";
			closeBtn.addEventListener("click", () => close());
			actions.appendChild(refresh);
			actions.appendChild(closeBtn);
			hdr.appendChild(title);
			hdr.appendChild(actions);

			const body = document.createElement("div");
			body.className = "menu-body";

			const search = document.createElement("input");
			search.className = "menu-search";
			search.placeholder = "Search model name…";

			const list = document.createElement("div");
			list.className = "menu-list";
			list.textContent = "Loading…";

			const render = (models, query) => {
				list.innerHTML = "";
				const activeState = getActiveState();
				const currentKey = activeState?.model ? `${activeState.model.provider}/${activeState.model.id}` : null;
				const filtered = models.filter((m) => fuzzyMatch(query, `${m.name || m.id}`));
				const shown = filtered.slice(0, 200);
				if (shown.length === 0) {
					const empty = document.createElement("div");
					empty.className = "si-meta";
					empty.textContent = "No matches.";
					list.appendChild(empty);
					return;
				}
				for (const m of shown) {
					const item = document.createElement("div");
					item.className = "menu-item";
					const key = `${m.provider}/${m.id}`;
					if (currentKey && key === currentKey) item.classList.add("active");

					const primary = document.createElement("div");
					primary.className = "primary";
					primary.textContent = key;
					const secondary = document.createElement("div");
					secondary.className = "secondary";
					secondary.textContent = m.name || (m.reasoning ? "reasoning" : "");

					item.appendChild(primary);
					item.appendChild(secondary);
					item.addEventListener("click", async () => {
						try {
							await setModel(m.provider, m.id);
							close();
						} catch (error) {
							onNotice(error instanceof Error ? error.message : String(error), "error");
						}
					});
					list.appendChild(item);
				}
			};

			search.addEventListener("input", async () => {
				try {
					const models = await getAvailableModels();
					render(models, search.value);
				} catch (error) {
					list.textContent = error instanceof Error ? error.message : String(error);
				}
			});

			body.appendChild(search);
			body.appendChild(list);

			panel.appendChild(hdr);
			panel.appendChild(body);

			(async () => {
				try {
					const models = await getAvailableModels();
					render(models, "");
					position(btnModel);
					search.focus();
				} catch (error) {
					list.textContent = error instanceof Error ? error.message : String(error);
				}
			})();
		});
	}

	function openThinkingMenu() {
		if (!btnThinking || btnThinking.disabled) return;
		openMenu(btnThinking, (panel) => {
			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "Thinking level";
			const closeBtn = document.createElement("button");
			closeBtn.className = "menu-mini";
			closeBtn.textContent = "Close";
			closeBtn.addEventListener("click", () => close());
			hdr.appendChild(title);
			hdr.appendChild(closeBtn);

			const body = document.createElement("div");
			body.className = "menu-body";

			const list = document.createElement("div");
			list.className = "menu-list";

			const activeState = getActiveState();
			const current = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "off";
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
			for (const level of levels) {
				const item = document.createElement("div");
				item.className = "menu-item";
				if (level === current) item.classList.add("active");
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = level;
				item.appendChild(primary);
				item.addEventListener("click", async () => {
					try {
						await setThinkingLevel(level);
						close();
					} catch (error) {
						onNotice(error instanceof Error ? error.message : String(error), "error");
					}
				});
				list.appendChild(item);
			}

			body.appendChild(list);
			panel.appendChild(hdr);
			panel.appendChild(body);
		});
	}

	function openCommandsMenu() {
		if (!btnCommands || btnCommands.disabled) return;
		const state = { executingCommand: null };
		openMenu(btnCommands, (panel) => {
			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "/Cmd";
			const closeBtn = document.createElement("button");
			closeBtn.className = "menu-mini";
			closeBtn.textContent = "Close";
			closeBtn.addEventListener("click", () => close());
			hdr.appendChild(title);
			hdr.appendChild(closeBtn);

			const body = document.createElement("div");
			body.className = "menu-body";
			const list = document.createElement("div");
			list.className = "menu-list";

			const render = () => {
				list.innerHTML = "";
				const activeState = getActiveState();
				const commands = Array.isArray(activeState?.commands) ? activeState.commands : [];
				const entries = getCommandMenuEntries(commands);
				for (const entry of entries) {
					const item = document.createElement("div");
					item.className = `menu-item${entry.disabled ? " disabled" : ""}`;
					if (state.executingCommand && entry.kind === "command" && entry.command?.name === state.executingCommand) {
						item.classList.add("active");
					}
					const primary = document.createElement("div");
					primary.className = "primary";
					primary.textContent = state.executingCommand && entry.kind === "command" && entry.command?.name === state.executingCommand
						? `${entry.title}…`
						: entry.title;
					const secondary = document.createElement("div");
					secondary.className = "secondary";
					secondary.textContent = entry.disabled
						? "Unavailable in this session"
						: state.executingCommand && entry.kind === "command" && entry.command?.name === state.executingCommand
							? "Starting…"
							: entry.description;
					item.appendChild(primary);
					item.appendChild(secondary);
					item.addEventListener("click", async () => {
						const result = await handleCommandMenuAction({ entry, state, onExecuteCommand, onInsertCommand, onNotice });
						if (result.ok) {
							close();
							if (result.action === "agents") {
								setTimeout(() => { if (typeof onRunAgent === "function") onRunAgent(); }, 0);
								return;
							}
							if (result.action === "review") {
								setTimeout(() => { if (typeof onRunReview === "function") onRunReview(); }, 0);
								return;
							}
						}
						render();
					});
					list.appendChild(item);
				}
			};

			body.appendChild(list);
			panel.appendChild(hdr);
			panel.appendChild(body);
			render();
		});
	}

	function openSettingsMenu() {
		if (!btnSettings || !menuOverlay || !menuPanel) return;
		open = true;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "50%";
		menuPanel.style.top = "56px";
		menuPanel.style.transform = "translateX(-50%)";
		menuPanel.style.width = "min(760px, 94vw)";
		menuPanel.style.maxWidth = "94vw";
		menuPanel.style.maxHeight = "calc(100vh - 72px)";

		const renderSettings = () => {
			menuPanel.innerHTML = "";
			const prefs = typeof getPrefs === "function"
				? getPrefs()
				: { theme: "dark", sendOnEnter: true, fontScale: 1, faceIdEnabled: false, pushSupported: false, pushSubscribed: false, steeringMode: null, followUpMode: null, hasSessionControl: false };

			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = "Settings";
			const closeBtn = document.createElement("button");
			closeBtn.className = "menu-mini";
			closeBtn.textContent = "Close";
			closeBtn.addEventListener("click", () => close());
			hdr.appendChild(title);
			hdr.appendChild(closeBtn);

			const body = document.createElement("div");
			body.className = "menu-body";
			body.style.paddingBottom = "16px";

			const addSection = (label) => {
				const heading = document.createElement("div");
				heading.className = "sidebar-label";
				heading.style.margin = "10px 0 8px";
				heading.textContent = label;
				body.appendChild(heading);
			};

			const makeSetting = ({ name, value, description, active, onClick }) => {
				const item = document.createElement("div");
				item.className = `menu-item${active ? " active" : ""}`;
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = `${name} · ${value}`;
				const secondary = document.createElement("div");
				secondary.className = "secondary";
				secondary.textContent = description;
				item.appendChild(primary);
				item.appendChild(secondary);
				if (typeof onClick === "function") item.addEventListener("click", onClick);
				return item;
			};

			const makeStepperSetting = ({ name, value, description, onMinus, onPlus, canMinus = true, canPlus = true }) => {
				const item = document.createElement("div");
				item.className = "menu-item setting-stepper";
				const textWrap = document.createElement("div");
				textWrap.className = "setting-stepper-text";
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = `${name} · ${value}`;
				const secondary = document.createElement("div");
				secondary.className = "secondary";
				secondary.textContent = description;
				textWrap.appendChild(primary);
				textWrap.appendChild(secondary);
				const controls = document.createElement("div");
				controls.className = "setting-stepper-controls";
				const minus = document.createElement("button");
				minus.className = "menu-mini setting-stepper-btn";
				minus.textContent = "−";
				minus.disabled = !canMinus;
				minus.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (typeof onMinus === "function") onMinus();
				});
				const plus = document.createElement("button");
				plus.className = "menu-mini setting-stepper-btn";
				plus.textContent = "+";
				plus.disabled = !canPlus;
				plus.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (typeof onPlus === "function") onPlus();
				});
				controls.appendChild(minus);
				controls.appendChild(plus);
				item.appendChild(textWrap);
				item.appendChild(controls);
				return item;
			};

			addSection("App");
			body.appendChild(makeSetting({
				name: "Theme",
				value: prefs.theme === "light" ? "light" : "dark",
				description: "Toggle light/dark appearance.",
				active: prefs.theme === "light",
				onClick: () => {
					if (typeof onToggleTheme === "function") onToggleTheme();
					renderSettings();
				},
			}));
			body.appendChild(makeSetting({
				name: "Enter sends",
				value: prefs.sendOnEnter ? "on" : "off",
				description: prefs.sendOnEnter
					? "Enter sends, Shift+Enter makes a newline."
					: "Enter makes a newline, Ctrl+Enter sends.",
				active: prefs.sendOnEnter,
				onClick: () => {
					if (typeof onToggleSendOnEnter === "function") onToggleSendOnEnter();
					renderSettings();
				},
			}));
			body.appendChild(makeStepperSetting({
				name: "Text size",
				value: `${Math.round((Number(prefs.fontScale || 1) || 1) * 100)}%`,
				description: "Use − / + to decrease or increase text size.",
				canMinus: Number(prefs.fontScale || 1) > 0.85,
				canPlus: Number(prefs.fontScale || 1) < 1.35,
				onMinus: () => {
					if (typeof onAdjustFontScale === "function") onAdjustFontScale(-0.05);
					renderSettings();
				},
				onPlus: () => {
					if (typeof onAdjustFontScale === "function") onAdjustFontScale(0.05);
					renderSettings();
				},
			}));
			body.appendChild(makeSetting({
				name: "Notifications",
				value: prefs.pushSupported ? (prefs.pushSubscribed ? "on" : "off") : "unsupported",
				description: prefs.pushSupported ? "Enable or disable push notifications." : "Push notifications are not available in this browser.",
				active: prefs.pushSubscribed,
				onClick: prefs.pushSupported ? async () => {
					try {
						if (typeof onTogglePush === "function") await onTogglePush();
						renderSettings();
					} catch (error) {
						onNotice(error instanceof Error ? error.message : String(error), "error");
					}
				} : undefined,
			}));
			body.appendChild(makeSetting({
				name: "Test notifications",
				value: prefs.pushSupported ? "send" : "unavailable",
				description: prefs.pushSupported ? "Send a local test notification now." : "Requires browser notification support.",
				active: false,
				onClick: prefs.pushSupported ? async () => {
					try {
						if (typeof onTestPush === "function") await onTestPush();
					} catch (error) {
						onNotice(error instanceof Error ? error.message : String(error), "error");
					}
				} : undefined,
			}));

			addSection("Pi session");
			if (!prefs.hasSessionControl) {
				const note = document.createElement("div");
				note.className = "menu-item";
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = "No controllable session";
				const secondary = document.createElement("div");
				secondary.className = "secondary";
				secondary.textContent = "Open a session and take over control to change pi runtime behavior.";
				note.appendChild(primary);
				note.appendChild(secondary);
				body.appendChild(note);
			} else {
				const nextSteering = prefs.steeringMode === "all" ? "one-at-a-time" : "all";
				body.appendChild(makeSetting({
					name: "Steering mode",
					value: prefs.steeringMode || "one-at-a-time",
					description: "Tap to toggle between delivering all queued steering messages or one at a time.",
					active: prefs.steeringMode === "all",
					onClick: async () => {
						try {
							if (typeof onSetSteeringMode === "function") await onSetSteeringMode(nextSteering);
							renderSettings();
						} catch (error) {
							onNotice(error instanceof Error ? error.message : String(error), "error");
						}
					},
				}));
				const nextFollow = prefs.followUpMode === "all" ? "one-at-a-time" : "all";
				body.appendChild(makeSetting({
					name: "Follow-up mode",
					value: prefs.followUpMode || "one-at-a-time",
					description: "Tap to toggle how follow-up queued prompts are delivered after the agent finishes.",
					active: prefs.followUpMode === "all",
					onClick: async () => {
						try {
							if (typeof onSetFollowUpMode === "function") await onSetFollowUpMode(nextFollow);
							renderSettings();
						} catch (error) {
							onNotice(error instanceof Error ? error.message : String(error), "error");
						}
					},
				}));
			}

			const footer = document.createElement("div");
			footer.className = "si-meta";
			footer.style.marginTop = "12px";
			footer.textContent = "Model and Thinking stay in the top bar for quick access.";
			body.appendChild(footer);

			menuPanel.appendChild(hdr);
			menuPanel.appendChild(body);
		};

		renderSettings();
	}

	if (menuScrim) menuScrim.addEventListener("click", () => {
		if (menuOverlay?.dataset?.locked === "1") return;
		close();
	});

	return {
		close,
		isOpen: () => open,
		openModelMenu,
		openThinkingMenu,
		openCommandsMenu,
		openSettingsMenu,
	};
}

