export function createAgentLauncher({ menuOverlay, menuPanel, api, onSubmit }) {
	function close() {
		if (menuOverlay) menuOverlay.classList.remove("open");
		if (menuPanel) menuPanel.innerHTML = "";
	}

	async function show() {
		if (!menuOverlay || !menuPanel) return;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "8px";
		menuPanel.style.top = "60px";
		menuPanel.style.right = "8px";
		menuPanel.style.width = "auto";
		menuPanel.style.maxWidth = "min(520px, 92vw)";

		// Header
		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const title = document.createElement("div");
		title.className = "menu-title";
		title.textContent = "🤖 Run Agent";
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "menu-mini";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", close);
		hdr.appendChild(title);
		hdr.appendChild(cancelBtn);
		menuPanel.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body";

		// Loading
		body.textContent = "Loading agents…";
		menuPanel.appendChild(body);

		let agents = [];
		try {
			const data = await api.getJson("/api/agents");
			agents = Array.isArray(data.agents) ? data.agents : [];
		} catch {
			body.textContent = "Failed to load agents.";
			return;
		}

		if (agents.length === 0) {
			body.textContent = "No agents found.";
			return;
		}

		body.innerHTML = "";

		// Agent picker
		let selectedAgent = agents[0]?.name || "";

		const label1 = document.createElement("div");
		label1.style.cssText = "color:#888;font-size:11px;margin-bottom:4px;";
		label1.textContent = "Agent";
		body.appendChild(label1);

		const list = document.createElement("div");
		list.className = "menu-list";
		list.style.maxHeight = "180px";

		function renderAgentList() {
			list.innerHTML = "";
			for (const agent of agents) {
				const item = document.createElement("div");
				item.className = "menu-item" + (agent.name === selectedAgent ? " active" : "");
				const primary = document.createElement("div");
				primary.className = "primary";
				primary.textContent = agent.name;
				const secondary = document.createElement("div");
				secondary.className = "secondary";
				secondary.textContent = `${agent.scope}${agent.description ? " • " + agent.description.slice(0, 60) : ""}`;
				item.appendChild(primary);
				item.appendChild(secondary);
				item.addEventListener("click", () => {
					selectedAgent = agent.name;
					renderAgentList();
				});
				list.appendChild(item);
			}
		}
		renderAgentList();
		body.appendChild(list);

		// Task input
		const label2 = document.createElement("div");
		label2.style.cssText = "color:#888;font-size:11px;margin-top:10px;margin-bottom:4px;";
		label2.textContent = "Task";
		body.appendChild(label2);

		const taskInput = document.createElement("textarea");
		taskInput.rows = 3;
		taskInput.placeholder = "What should the agent do?";
		taskInput.style.cssText = "width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:6px;font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit;";
		body.appendChild(taskInput);

		// Flags
		const flagRow = document.createElement("div");
		flagRow.style.cssText = "display:flex;gap:12px;margin-top:8px;align-items:center;";

		const bgLabel = document.createElement("label");
		bgLabel.style.cssText = "color:#888;font-size:12px;display:flex;align-items:center;gap:4px;";
		const bgCheck = document.createElement("input");
		bgCheck.type = "checkbox";
		bgLabel.appendChild(bgCheck);
		bgLabel.appendChild(document.createTextNode("Background"));
		flagRow.appendChild(bgLabel);

		body.appendChild(flagRow);

		// Submit
		const submitBtn = document.createElement("button");
		submitBtn.className = "menu-mini";
		submitBtn.style.cssText = "margin-top:12px;width:100%;padding:10px;background:#1e2a20;border-color:#2a3a2a;color:#b5bd68;font-size:14px;";
		submitBtn.textContent = "Run";
		submitBtn.addEventListener("click", () => {
			const task = taskInput.value.trim();
			if (!task) { taskInput.focus(); return; }
			if (!selectedAgent) return;
			const bg = bgCheck.checked;
			close();
			const cmd = `/run ${selectedAgent} ${task}${bg ? " --bg" : ""}`;
			if (typeof onSubmit === "function") onSubmit(cmd);
		});
		body.appendChild(submitBtn);

		setTimeout(() => taskInput.focus(), 100);
	}

	return { show, close };
}
