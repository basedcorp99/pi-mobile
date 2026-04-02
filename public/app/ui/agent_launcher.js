function sortByLabel(items) {
	return [...items].sort((a, b) => String(a.label || a.name || "").localeCompare(String(b.label || b.name || "")));
}

function quoteArg(text) {
	return JSON.stringify(String(text || ""));
}

function agentToken(step) {
	const name = String(step?.agent || "").trim();
	if (!name) return "";
	const inline = [];
	if (step?.model) inline.push(`model=${step.model}`);
	return inline.length > 0 ? `${name}[${inline.join(",")}]` : name;
}

function makeStep(agents = []) {
	return {
		agent: agents[0]?.name || "",
		model: "",
		task: "",
	};
}

function commandForMode(mode, steps, flags) {
	const enabledSteps = (steps || []).filter((step) => String(step?.agent || "").trim() && String(step?.task || "").trim());
	if (enabledSteps.length === 0) return "";
	if (mode === "single") {
		const step = enabledSteps[0];
		let cmd = `/run ${agentToken(step)} ${quoteArg(step.task.trim())}`;
		if (flags?.fork) cmd += " --fork";
		if (flags?.bg) cmd += " --bg";
		return cmd;
	}
	const slash = mode === "parallel" ? "/parallel" : "/chain";
	let cmd = `${slash} ${enabledSteps.map((step) => `${agentToken(step)} ${quoteArg(step.task.trim())}`).join(" -> ")}`;
	if (flags?.fork) cmd += " --fork";
	if (flags?.bg) cmd += " --bg";
	return cmd;
}

export function createAgentLauncher({ menuOverlay, menuPanel, api, onSubmit }) {
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
		title.textContent = "Subagents";
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
		try {
			[agentData, modelData] = await Promise.all([
				api.getJson("/api/agents"),
				api.getJson("/api/models"),
			]);
		} catch {
			body.textContent = "Failed to load subagent data.";
			return;
		}

		const agents = sortByLabel((Array.isArray(agentData?.agents) ? agentData.agents : []).map((agent) => ({
			name: agent.name,
			label: agent.name,
			description: agent.description || "",
			scope: agent.scope || "builtin",
		})));
		const models = sortByLabel((Array.isArray(modelData?.models) ? modelData.models : []).map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: model.name || model.id,
			secondary: `${model.provider}/${model.id}`,
		})));

		if (agents.length === 0) {
			body.textContent = "No subagents found.";
			return;
		}

		let mode = "single";
		let steps = [makeStep(agents)];
		let flags = { fork: false, bg: false };

		const ensureStepsForMode = () => {
			if (mode === "single") {
				steps = [steps[0] || makeStep(agents)];
				return;
			}
			while (steps.length < 2) steps.push(makeStep(agents));
		};

		const buildAgentSelect = (value, onChange) => {
			const select = document.createElement("select");
			select.className = "agent-launcher-select";
			for (const agent of agents) {
				const option = document.createElement("option");
				option.value = agent.name;
				option.textContent = `${agent.name} · ${agent.scope}`;
				if (agent.name === value) option.selected = true;
				select.appendChild(option);
			}
			select.addEventListener("change", () => onChange(select.value));
			return select;
		};

		const buildModelSelect = (value, onChange) => {
			const select = document.createElement("select");
			select.className = "agent-launcher-select";
			const defaultOption = document.createElement("option");
			defaultOption.value = "";
			defaultOption.textContent = "Session default model";
			select.appendChild(defaultOption);
			for (const model of models) {
				const option = document.createElement("option");
				option.value = model.value;
				option.textContent = `${model.label} · ${model.secondary}`;
				if (model.value === value) option.selected = true;
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
			intro.textContent = "Run one subagent, or build a chain / parallel run with per-step model overrides.";
			body.appendChild(intro);

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

				const grid = document.createElement("div");
				grid.className = "agent-launcher-grid";

				const agentField = document.createElement("label");
				agentField.className = "agent-launcher-field";
				agentField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Agent" }));
				agentField.appendChild(buildAgentSelect(step.agent, (value) => { step.agent = value; }));
				grid.appendChild(agentField);

				const modelField = document.createElement("label");
				modelField.className = "agent-launcher-field";
				modelField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Model override" }));
				modelField.appendChild(buildModelSelect(step.model, (value) => { step.model = value; }));
				grid.appendChild(modelField);

				card.appendChild(grid);

				const taskField = document.createElement("label");
				taskField.className = "agent-launcher-field";
				taskField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Task" }));
				const taskInput = document.createElement("textarea");
				taskInput.className = "agent-launcher-textarea";
				taskInput.rows = 3;
				taskInput.placeholder = mode === "single" ? "What should this subagent do?" : "What should this step do?";
				taskInput.value = step.task;
				taskInput.addEventListener("input", () => { step.task = taskInput.value; });
				taskField.appendChild(taskInput);
				card.appendChild(taskField);

				const meta = document.createElement("div");
				meta.className = "agent-launcher-meta";
				const agentInfo = agents.find((item) => item.name === step.agent);
				meta.textContent = agentInfo?.description || "";
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
					steps.push(makeStep(agents));
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
				});
				label.appendChild(input);
				label.appendChild(document.createTextNode(option.label));
				options.appendChild(label);
			}
			body.appendChild(options);

			const preview = document.createElement("div");
			preview.className = "agent-launcher-preview";
			const cmd = commandForMode(mode, steps, flags);
			preview.textContent = cmd || "Fill in at least one agent and task.";
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
			run.textContent = mode === "single" ? "Run subagent" : mode === "parallel" ? "Run parallel" : "Run chain";
			run.addEventListener("click", () => {
				const command = commandForMode(mode, steps, flags);
				if (!command) return;
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
