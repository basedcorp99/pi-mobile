const RECENT_AGENT_KEY = "piWebRecentAgent";
const RECENT_AGENT_CWD_KEY_PREFIX = "piWebRecentAgentCwd:";

function safeLocalStorageGet(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalStorageSet(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

function sortByLabel(items) {
	return [...items].sort((a, b) => String(a.label || a.name || "").localeCompare(String(b.label || b.name || "")));
}

function displayScopeRank(scope) {
	if (scope === "user") return 0;
	if (scope === "project") return 1;
	if (scope === "builtin") return 2;
	return 3;
}

function executionScopeRank(scope) {
	if (scope === "project") return 2;
	if (scope === "user") return 1;
	if (scope === "builtin") return 0;
	return -1;
}

function makeAgentKey(agentOrScope, name) {
	if (agentOrScope && typeof agentOrScope === "object") {
		return `${agentOrScope.scope || "builtin"}:${agentOrScope.name || ""}`;
	}
	return `${agentOrScope || "builtin"}:${name || ""}`;
}

function findAgentByKey(agents = [], key = "") {
	return agents.find((agent) => makeAgentKey(agent) === key) || null;
}

// The launcher intentionally shows only effective runtime choices.
// Same-named lower-priority agents are hidden here because /run resolves by
// name using project > user > builtin precedence.
function buildEffectiveAgents(items = []) {
	const byName = new Map();
	for (const agent of items) {
		const existing = byName.get(agent.name);
		if (!existing || executionScopeRank(agent.scope) > executionScopeRank(existing.scope)) {
			byName.set(agent.name, agent);
		}
	}
	return [...byName.values()];
}

function scopeGroupLabel(scope) {
	if (scope === "user") return "Custom (~/.pi)";
	if (scope === "project") return "Project";
	if (scope === "builtin") return "Built-in";
	return "Other";
}

function scopeDescription(scope) {
	if (scope === "user") return "Custom agent from ~/.pi";
	if (scope === "project") return "Project agent";
	if (scope === "builtin") return "Built-in agent";
	return "Agent";
}

function normalizeCwdForStorage(cwd) {
	const raw = typeof cwd === "string" ? cwd.trim() : "";
	if (!raw) return "";
	const normalized = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
	return normalized || raw;
}

function resolveRecentAgentKey(agents = [], recentKey = "") {
	const exact = String(recentKey || "").trim();
	if (!exact) return "";
	if (agents.some((agent) => makeAgentKey(agent) === exact)) return exact;
	const sep = exact.indexOf(":");
	const fallbackName = sep === -1 ? exact : exact.slice(sep + 1);
	if (!fallbackName) return "";
	const byName = agents.find((agent) => String(agent?.name || "") === fallbackName);
	return byName ? makeAgentKey(byName) : "";
}

function buildRecentAgentCwdStorageKey(cwd) {
	const normalized = normalizeCwdForStorage(cwd);
	return normalized ? `${RECENT_AGENT_CWD_KEY_PREFIX}${normalized}` : "";
}

function getRecentAgentKey(agents = [], cwd = "") {
	const cwdKey = buildRecentAgentCwdStorageKey(cwd);
	const cwdRecent = cwdKey ? resolveRecentAgentKey(agents, safeLocalStorageGet(cwdKey)) : "";
	if (cwdRecent) return cwdRecent;
	const recent = resolveRecentAgentKey(agents, safeLocalStorageGet(RECENT_AGENT_KEY));
	if (recent) return recent;
	return "";
}

function sortAgents(items, cwd = "") {
	const recent = getRecentAgentKey(items, cwd);
	return [...items].sort((a, b) => {
		const aRecent = makeAgentKey(a) === recent;
		const bRecent = makeAgentKey(b) === recent;
		if (aRecent !== bRecent) return aRecent ? -1 : 1;
		const rankDiff = displayScopeRank(a.scope) - displayScopeRank(b.scope);
		if (rankDiff !== 0) return rankDiff;
		return String(a.label || a.name || "").localeCompare(String(b.label || b.name || ""));
	});
}

function setRecentAgentKey(key, agents = [], cwd = "") {
	if (typeof key !== "string" || key.length === 0) return;
	const agent = findAgentByKey(agents, key);
	const scope = agent?.scope || String(key).split(":", 1)[0] || "";
	const cwdKey = buildRecentAgentCwdStorageKey(cwd);
	if (cwdKey) safeLocalStorageSet(cwdKey, key);
	if (scope !== "project") safeLocalStorageSet(RECENT_AGENT_KEY, key);
}

function getDefaultAgentKey(agents = [], cwd = "") {
	const recent = getRecentAgentKey(agents, cwd);
	if (recent) return recent;
	return agents[0] ? makeAgentKey(agents[0]) : "";
}

function buildAgentRequestUrl(cwd) {
	return cwd ? `/api/agents?cwd=${encodeURIComponent(cwd)}` : "/api/agents";
}

function quoteArg(text) {
	return JSON.stringify(String(text || ""));
}

function agentToken(step, agents = []) {
	const agent = findAgentByKey(agents, String(step?.agent || ""));
	const name = String(agent?.name || "").trim();
	if (!name) return "";
	const inline = [];
	if (step?.model) inline.push(`model=${step.model}`);
	return inline.length > 0 ? `${name}[${inline.join(",")}]` : name;
}

function makeStep(agents = [], cwd = "") {
	return {
		agent: getDefaultAgentKey(agents, cwd),
		model: "", // empty = agent default
		task: "",
	};
}

function isRunnableStep(step, agents = []) {
	return Boolean(findAgentByKey(agents, String(step?.agent || "")) && String(step?.task || "").trim());
}

function getRecentAgentKeyForSubmit(mode, steps, lastTouchedAgentKey, agents = []) {
	if (mode === "single") {
		return isRunnableStep(steps?.[0], agents) ? String(steps[0]?.agent || "") : "";
	}
	const touchedIsRunnable = Boolean(
		lastTouchedAgentKey
		&& findAgentByKey(agents, String(lastTouchedAgentKey || ""))
		&& (steps || []).some((step) => String(step?.agent || "") === String(lastTouchedAgentKey || "") && isRunnableStep(step, agents)),
	);
	if (touchedIsRunnable) return String(lastTouchedAgentKey || "");
	return String((steps || []).find((step) => isRunnableStep(step, agents))?.agent || "");
}

function commandForMode(mode, steps, flags, agents = []) {
	const enabledSteps = (steps || []).filter((step) => isRunnableStep(step, agents));
	if (enabledSteps.length === 0) return "";
	if (mode === "single") {
		const step = enabledSteps[0];
		let cmd = `/run ${agentToken(step, agents)} ${quoteArg(step.task.trim())}`;
		if (flags?.fork) cmd += " --fork";
		if (flags?.bg) cmd += " --bg";
		return cmd;
	}
	const slash = mode === "parallel" ? "/parallel" : "/chain";
	let cmd = `${slash} ${enabledSteps.map((step) => `${agentToken(step, agents)} ${quoteArg(step.task.trim())}`).join(" -> ")}`;
	if (flags?.fork) cmd += " --fork";
	if (flags?.bg) cmd += " --bg";
	return cmd;
}

export function createAgentLauncher({ menuOverlay, menuPanel, api, onSubmit, getActiveState }) {
	function close() {
		if (menuOverlay) {
			menuOverlay.classList.remove("open");
			delete menuOverlay.dataset.locked;
			delete menuOverlay.dataset.kind;
		}
		if (menuPanel) {
			menuPanel.innerHTML = "";
			menuPanel.style.left = "";
			menuPanel.style.top = "";
			menuPanel.style.right = "";
			menuPanel.style.width = "";
			menuPanel.style.maxWidth = "";
			menuPanel.style.maxHeight = "";
			menuPanel.style.transform = "";
		}
	}

	async function show() {
		if (!menuOverlay || !menuPanel) return;

		menuOverlay.classList.add("open");
		menuOverlay.dataset.locked = "1";
		menuOverlay.dataset.kind = "agent-launcher";
		menuPanel.innerHTML = "";
		menuPanel.style.left = "50%";
		menuPanel.style.top = "50%";
		menuPanel.style.right = "auto";
		menuPanel.style.width = "min(980px, 96vw)";
		menuPanel.style.maxWidth = "min(980px, 96vw)";
		menuPanel.style.maxHeight = "min(88vh, 920px)";
		menuPanel.style.transform = "translate(-50%, -50%)";

		const wrap = document.createElement("div");
		wrap.className = "agent-launcher";

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const title = document.createElement("div");
		title.className = "menu-title";
		title.textContent = "Agents";
		const closeBtn = document.createElement("button");
		closeBtn.className = "menu-mini";
		closeBtn.textContent = "Close";
		closeBtn.addEventListener("click", close);
		hdr.appendChild(title);
		hdr.appendChild(closeBtn);
		wrap.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body agent-launcher-body";
		body.textContent = "Loading agents and models…";
		wrap.appendChild(body);
		menuPanel.appendChild(wrap);

		let agentData;
		let modelData;
		const activeCwd = getActiveState?.()?.cwd || "";
		const agentUrl = buildAgentRequestUrl(activeCwd);
		try {
			[agentData, modelData] = await Promise.all([
				api.getJson(agentUrl),
				api.getJson("/api/models"),
			]);
		} catch {
			body.textContent = "Failed to load agent data.";
			return;
		}

		const allAgents = (Array.isArray(agentData?.agents) ? agentData.agents : []).map((agent) => ({
			name: agent.name,
			label: agent.name,
			description: agent.description || "",
			scope: agent.scope || "builtin",
			model: agent.model || null,
		}));
		const agents = sortAgents(buildEffectiveAgents(allAgents), activeCwd);
		const shadowedCount = Math.max(0, allAgents.length - agents.length);
		const models = sortByLabel((Array.isArray(modelData?.models) ? modelData.models : []).map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: model.name || model.id,
			secondary: `${model.provider}/${model.id}`,
		})));

		if (agents.length === 0) {
			body.textContent = activeCwd
				? "No agents found for this session directory. Project agents depend on the current cwd."
				: "No agents found.";
			return;
		}

		let mode = "single";
		let steps = [makeStep(agents, activeCwd)];
		let flags = { fork: false, bg: false };
		let lastTouchedAgentKey = getDefaultAgentKey(agents, activeCwd);

		const normalizeStep = (step) => ({
			agent: findAgentByKey(agents, String(step?.agent || "")) ? String(step.agent || "") : getDefaultAgentKey(agents, activeCwd),
			model: String(step?.model || ""),
			task: String(step?.task || ""),
		});

		const ensureStepsForMode = () => {
			if (mode === "single") {
				steps = [normalizeStep(steps[0] || makeStep(agents, activeCwd))];
				return;
			}
			steps = steps.map((step) => normalizeStep(step));
			while (steps.length < 2) steps.push(makeStep(agents, activeCwd));
		};

		// --- Build the native <select> for picking an agent ---
		const buildAgentSelect = (value, onChange) => {
			const select = document.createElement("select");
			select.className = "agent-launcher-select";
			const recent = getRecentAgentKey(agents, activeCwd);
			const selectedValue = findAgentByKey(agents, value) ? value : getDefaultAgentKey(agents, activeCwd);
			const knownScopes = ["user", "project", "builtin"];
			for (const scope of knownScopes) {
				const scopedAgents = agents.filter((agent) => agent.scope === scope);
				if (scopedAgents.length === 0) continue;
				const group = document.createElement("optgroup");
				group.label = scopeGroupLabel(scope);
				for (const agent of scopedAgents) {
					const key = makeAgentKey(agent);
					const option = document.createElement("option");
					option.value = key;
					option.textContent = key === recent ? `${agent.name} · recent` : agent.name;
					if (key === selectedValue) option.selected = true;
					group.appendChild(option);
				}
				select.appendChild(group);
			}
			const otherAgents = agents.filter((agent) => !knownScopes.includes(agent.scope));
			if (otherAgents.length > 0) {
				const group = document.createElement("optgroup");
				group.label = scopeGroupLabel("other");
				for (const agent of otherAgents) {
					const key = makeAgentKey(agent);
					const option = document.createElement("option");
					option.value = key;
					option.textContent = key === recent ? `${agent.name} · recent` : agent.name;
					if (key === selectedValue) option.selected = true;
					group.appendChild(option);
				}
				select.appendChild(group);
			}
			select.addEventListener("change", () => {
				lastTouchedAgentKey = select.value;
				setRecentAgentKey(select.value, agents, activeCwd);
				onChange(select.value);
			});
			return select;
		};

		// --- Build the native <select> for model with Default + Session + all models ---
		const buildModelSelect = (agentKey, value, onChange) => {
			const select = document.createElement("select");
			select.className = "agent-launcher-select";

			const agentInfo = findAgentByKey(agents, agentKey);
			const activeModel = getActiveState?.()?.model || null;
			const fallbackModel = activeModel ? `${activeModel.provider}/${activeModel.id}` : null;
			const defaultModelLabel = agentInfo?.model
				? `Default (${agentInfo.model})`
				: fallbackModel
					? `Default (${fallbackModel})`
					: "Default";

			// Option 1: Default – don't override
			const defaultOpt = document.createElement("option");
			defaultOpt.value = "";
			defaultOpt.textContent = defaultModelLabel;
			if (!value) defaultOpt.selected = true;
			select.appendChild(defaultOpt);

			// Option 2: Current session model (if available and different from agent default)
			const sessionModel = getActiveState?.()?.model || null;
			if (sessionModel) {
				const sessionKey = `${sessionModel.provider}/${sessionModel.id}`;
				const sessionLabel = sessionModel.name || sessionModel.id;
				const sessionOpt = document.createElement("option");
				sessionOpt.value = sessionKey;
				sessionOpt.textContent = `⚡ Session: ${sessionLabel} (${sessionKey})`;
				if (value === sessionKey) sessionOpt.selected = true;
				select.appendChild(sessionOpt);
			}

			// Separator
			const sep = document.createElement("option");
			sep.disabled = true;
			sep.textContent = "────────────";
			select.appendChild(sep);

			// All other models
			for (const m of models) {
				const option = document.createElement("option");
				option.value = m.value;
				option.textContent = `${m.label}  ·  ${m.secondary}`;
				if (m.value === value) option.selected = true;
				select.appendChild(option);
			}

			select.addEventListener("change", () => onChange(select.value));
			return select;
		};

		const render = () => {
			ensureStepsForMode();
			body.innerHTML = "";

			const intro = document.createElement("div");
			intro.className = "agent-launcher-intro";
			intro.textContent = agents.some((agent) => agent.scope === "user" || agent.scope === "project")
				? "Run one agent, or build a chain / parallel run. Custom agents are easy to reach without taking over the main flow."
				: "Run one agent, or build a chain / parallel run with per-step model overrides.";
			body.appendChild(intro);

			const notes = [];
			if (activeCwd) notes.push(`Project agents resolve from ${activeCwd}.`);
			else notes.push("Project agents depend on the current session directory.");
			if (shadowedCount > 0) {
				notes.push(`${shadowedCount} same-named agent${shadowedCount === 1 ? " is" : "s are"} hidden because higher-priority scopes override them at run time.`);
			}
			if (notes.length > 0) {
				const note = document.createElement("div");
				note.className = "agent-launcher-note";
				note.textContent = notes.join(" ");
				body.appendChild(note);
			}

			const tabs = document.createElement("div");
			tabs.className = "agent-launcher-tabs";
			for (const nextMode of ["single", "chain", "parallel"]) {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = `menu-mini agent-launcher-tab${mode === nextMode ? " active" : ""}`;
				btn.textContent = nextMode[0].toUpperCase() + nextMode.slice(1);
				btn.addEventListener("click", () => {
					mode = nextMode;
					render();
				});
				tabs.appendChild(btn);
			}
			body.appendChild(tabs);

			const stepsWrap = document.createElement("div");
			stepsWrap.className = "agent-launcher-steps";

			steps.forEach((step, index) => {
				const card = document.createElement("div");
				card.className = "agent-launcher-step";

				const stepHdr = document.createElement("div");
				stepHdr.className = "agent-launcher-step-hdr";
				const stepTitle = document.createElement("div");
				stepTitle.className = "agent-launcher-step-title";
				stepTitle.textContent = mode === "single" ? "Agent" : `${mode === "parallel" ? "Parallel slot" : "Chain step"} ${index + 1}`;
				stepHdr.appendChild(stepTitle);
				if (mode !== "single" && steps.length > 2) {
					const removeBtn = document.createElement("button");
					removeBtn.type = "button";
					removeBtn.className = "menu-mini";
					removeBtn.textContent = "Remove";
					removeBtn.addEventListener("click", () => {
						steps.splice(index, 1);
						render();
					});
					stepHdr.appendChild(removeBtn);
				}
				card.appendChild(stepHdr);

				// --- Single row: Agent (left half) + Model (right half) ---
				const selectRow = document.createElement("div");
				selectRow.className = "agent-launcher-select-row";

				const agentField = document.createElement("label");
				agentField.className = "agent-launcher-field";
				agentField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Agent" }));

				let modelSelectEl = null;

				const rebuildModelSelect = () => {
					const newSelect = buildModelSelect(step.agent, step.model, (value) => {
						step.model = value;
						updateMeta();
						updatePreview();
					});
					if (modelSelectEl) {
						modelSelectEl.replaceWith(newSelect);
					}
					modelSelectEl = newSelect;
					return newSelect;
				};

				agentField.appendChild(buildAgentSelect(step.agent, (value) => {
					step.agent = value;
					rebuildModelSelect();
					updateMeta();
					updatePreview();
				}));
				selectRow.appendChild(agentField);

				const modelField = document.createElement("label");
				modelField.className = "agent-launcher-field";
				modelField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Model" }));
				modelSelectEl = buildModelSelect(step.agent, step.model, (value) => {
					step.model = value;
					updateMeta();
					updatePreview();
				});
				modelField.appendChild(modelSelectEl);
				selectRow.appendChild(modelField);

				card.appendChild(selectRow);

				// --- Meta (agent description + model info) ---
				const meta = document.createElement("div");
				meta.className = "agent-launcher-meta";
				const updateMeta = () => {
					const agentInfo = findAgentByKey(agents, step.agent);
					const lines = [];
					if (agentInfo) lines.push(scopeDescription(agentInfo.scope));
					if (agentInfo?.description) lines.push(agentInfo.description);
					if (step.model) {
						const m = models.find((m) => m.value === step.model);
						lines.push(`Model override: ${m ? `${m.label} · ${m.secondary}` : step.model}`);
					}
					meta.innerHTML = "";
					for (const line of lines) {
						const row = document.createElement("div");
						row.textContent = line;
						meta.appendChild(row);
					}
				};

				// --- Task textarea ---
				const taskField = document.createElement("label");
				taskField.className = "agent-launcher-field";
				taskField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Task" }));
				const taskInput = document.createElement("textarea");
				taskInput.className = "agent-launcher-textarea";
				taskInput.rows = 3;
				taskInput.placeholder = mode === "single" ? "What should this agent do?" : "What should this step do?";
				taskInput.value = step.task;
				taskInput.addEventListener("input", () => {
					step.task = taskInput.value;
					updatePreview();
				});
				taskField.appendChild(taskInput);
				card.appendChild(taskField);

				updateMeta();
				card.appendChild(meta);
				stepsWrap.appendChild(card);
			});
			body.appendChild(stepsWrap);

			if (mode !== "single") {
				const addRow = document.createElement("button");
				addRow.type = "button";
				addRow.className = "menu-mini agent-launcher-add";
				addRow.textContent = mode === "parallel" ? "+ Add slot" : "+ Add step";
				addRow.addEventListener("click", () => {
					steps.push(makeStep(agents, activeCwd));
					render();
				});
				body.appendChild(addRow);
			}

			const options = document.createElement("div");
			options.className = "agent-launcher-options";
			for (const option of [
				{ key: "fork", label: "Fork context" },
				{ key: "bg", label: "Run in background" },
			]) {
				const label = document.createElement("label");
				label.className = "agent-launcher-check";
				const input = document.createElement("input");
				input.type = "checkbox";
				input.checked = Boolean(flags[option.key]);
				input.addEventListener("change", () => {
					flags[option.key] = input.checked;
					updatePreview();
				});
				label.appendChild(input);
				label.appendChild(document.createTextNode(option.label));
				options.appendChild(label);
			}
			body.appendChild(options);

			const preview = document.createElement("div");
			preview.className = "agent-launcher-preview";
			const updatePreview = () => {
				const cmd = commandForMode(mode, steps, flags, agents);
				preview.textContent = cmd || "Fill in at least one agent and task.";
			};
			updatePreview();
			body.appendChild(preview);

			const actions = document.createElement("div");
			actions.className = "agent-launcher-actions";
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "menu-mini";
			cancel.textContent = "Cancel";
			cancel.addEventListener("click", close);
			const run = document.createElement("button");
			run.type = "button";
			run.className = "menu-mini agent-launcher-run";
			run.textContent = mode === "single" ? "Run agent" : mode === "parallel" ? "Run parallel" : "Run chain";
			run.addEventListener("click", () => {
				const command = commandForMode(mode, steps, flags, agents);
				if (!command) return;
				const recentAgent = getRecentAgentKeyForSubmit(mode, steps, lastTouchedAgentKey, agents);
				if (recentAgent) setRecentAgentKey(recentAgent, agents, activeCwd);
				close();
				if (typeof onSubmit === "function") onSubmit(command);
			});
			actions.appendChild(cancel);
			actions.appendChild(run);
			body.appendChild(actions);
		};

		render();
	}

	return { show, close };
}

export const __test = {
	makeAgentKey,
	findAgentByKey,
	buildEffectiveAgents,
	normalizeCwdForStorage,
	resolveRecentAgentKey,
	buildRecentAgentCwdStorageKey,
	getRecentAgentKey,
	sortAgents,
	setRecentAgentKey,
	getDefaultAgentKey,
	getRecentAgentKeyForSubmit,
	buildAgentRequestUrl,
	commandForMode,
};
