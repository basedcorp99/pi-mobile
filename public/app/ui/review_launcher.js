function quoteArg(text) {
	return JSON.stringify(String(text || ""));
}

function buildFocusText(state) {
	const selected = (state.focuses || []).filter(Boolean);
	const custom = String(state.customFocus || "").trim();
	const parts = [...selected];
	if (custom) parts.push(custom);
	return parts.join(", ").trim();
}

export function buildReviewCommand(state) {
	const mode = String(state?.mode || "working-tree").trim();
	const focus = buildFocusText(state);

	if (mode === "working-tree") {
		return focus ? `/review working-tree ${quoteArg(focus)}` : `/review working-tree`;
	}
	if (mode === "commit") {
		const ref = String(state?.commitRef || "").trim();
		if (!ref) return "";
		return focus ? `/review commit ${quoteArg(ref)} ${quoteArg(focus)}` : `/review commit ${quoteArg(ref)}`;
	}
	if (mode === "branch") {
		const base = String(state?.baseRef || "").trim();
		if (!base) return "";
		return focus ? `/review branch ${quoteArg(base)} ${quoteArg(focus)}` : `/review branch ${quoteArg(base)}`;
	}
	const custom = String(state?.customInstructions || "").trim() || focus;
	return custom ? `/review custom ${quoteArg(custom)}` : "";
}

export function createReviewLauncher({ menuOverlay, menuPanel, onSubmit }) {
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
		menuOverlay.dataset.kind = "review-launcher";
		menuPanel.innerHTML = "";
		menuPanel.style.left = "50%";
		menuPanel.style.top = "50%";
		menuPanel.style.right = "auto";
		menuPanel.style.width = "min(760px, 96vw)";
		menuPanel.style.maxWidth = "min(760px, 96vw)";
		menuPanel.style.maxHeight = "min(88vh, 920px)";
		menuPanel.style.transform = "translate(-50%, -50%)";

		const wrap = document.createElement("div");
		wrap.className = "agent-launcher";
		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const title = document.createElement("div");
		title.className = "menu-title";
		title.textContent = "Review";
		const closeBtn = document.createElement("button");
		closeBtn.className = "menu-mini";
		closeBtn.textContent = "Close";
		closeBtn.addEventListener("click", close);
		hdr.appendChild(title);
		hdr.appendChild(closeBtn);
		wrap.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body agent-launcher-body";
		wrap.appendChild(body);
		menuPanel.appendChild(wrap);

		const state = {
			mode: "working-tree",
			commitRef: "HEAD~1",
			baseRef: "main",
			focuses: ["Bugs", "Security", "Tests", "Error handling", "New dependencies"],
			customFocus: "",
			customInstructions: "",
		};

		const focusOptions = ["Bugs", "Security", "Performance", "Tests", "Error handling", "New dependencies"];

		const render = () => {
			body.innerHTML = "";

			const intro = document.createElement("div");
			intro.className = "agent-launcher-intro";
			intro.textContent = "Set up a review and run it without manually typing /review.";
			body.appendChild(intro);

			const tabs = document.createElement("div");
			tabs.className = "agent-launcher-tabs";
			for (const option of [
				["working-tree", "Uncommitted changes"],
				["commit", "Commit"],
				["branch", "Branch diff"],
				["custom", "Custom"],
			]) {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = `menu-mini agent-launcher-tab${state.mode === option[0] ? " active" : ""}`;
				btn.textContent = option[1];
				btn.addEventListener("click", () => {
					state.mode = option[0];
					render();
				});
				tabs.appendChild(btn);
			}
			body.appendChild(tabs);

			const section = document.createElement("div");
			section.className = "agent-launcher-step";

			if (state.mode === "commit") {
				const label = document.createElement("label");
				label.className = "agent-launcher-field";
				label.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Commit ref" }));
				const input = document.createElement("input");
				input.className = "menu-search";
				input.value = state.commitRef;
				input.placeholder = "HEAD~1";
				input.addEventListener("input", () => { state.commitRef = input.value; });
				label.appendChild(input);
				section.appendChild(label);
			}

			if (state.mode === "branch") {
				const label = document.createElement("label");
				label.className = "agent-launcher-field";
				label.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Base branch/ref" }));
				const input = document.createElement("input");
				input.className = "menu-search";
				input.value = state.baseRef;
				input.placeholder = "main";
				input.addEventListener("input", () => { state.baseRef = input.value; });
				label.appendChild(input);
				section.appendChild(label);
			}

			if (state.mode === "custom") {
				const label = document.createElement("label");
				label.className = "agent-launcher-field";
				label.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Custom instructions" }));
				const input = document.createElement("textarea");
				input.className = "agent-launcher-task";
				input.rows = 5;
				input.placeholder = "Call out risky changes, subtle bugs, missing tests, and new dependencies.";
				input.value = state.customInstructions;
				input.addEventListener("input", () => { state.customInstructions = input.value; });
				label.appendChild(input);
				section.appendChild(label);
			}

			const focusWrap = document.createElement("div");
			focusWrap.className = "agent-launcher-field";
			focusWrap.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: state.mode === "custom" ? "Extra focus (optional)" : "Focus" }));
			const grid = document.createElement("div");
			grid.style.display = "grid";
			grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(160px, 1fr))";
			grid.style.gap = "8px";
			for (const option of focusOptions) {
				const row = document.createElement("label");
				row.className = "menu-item";
				row.style.display = "flex";
				row.style.alignItems = "center";
				row.style.gap = "8px";
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = state.focuses.includes(option);
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) {
						if (!state.focuses.includes(option)) state.focuses.push(option);
					} else {
						state.focuses = state.focuses.filter((item) => item !== option);
					}
				});
				const text = document.createElement("span");
				text.textContent = option;
				row.appendChild(checkbox);
				row.appendChild(text);
				grid.appendChild(row);
			}
			focusWrap.appendChild(grid);
			const customFocus = document.createElement("input");
			customFocus.className = "menu-search";
			customFocus.placeholder = "Optional extra focus";
			customFocus.value = state.customFocus;
			customFocus.addEventListener("input", () => { state.customFocus = customFocus.value; });
			focusWrap.appendChild(customFocus);
			section.appendChild(focusWrap);

			body.appendChild(section);

			const preview = document.createElement("div");
			preview.className = "agent-launcher-preview";
			preview.textContent = buildReviewCommand(state) || "Fill in the required fields.";
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
			run.textContent = "Run review";
			run.addEventListener("click", () => {
				const command = buildReviewCommand(state);
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
