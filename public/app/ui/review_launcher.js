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

function formatModelValue(model) {
	if (!model || typeof model !== "object") return "";
	const provider = typeof model.provider === "string" ? model.provider.trim() : "";
	const id = typeof model.id === "string" ? model.id.trim() : "";
	return provider && id ? `${provider}/${id}` : "";
}

function formatModelOptionLabel(model) {
	const value = formatModelValue(model);
	const name = typeof model?.name === "string" ? model.name.trim() : "";
	return name && name !== value ? `${name} · ${value}` : value;
}

function getEffectiveModelValue(state) {
	const choice = String(state?.modelChoice || "").trim();
	if (!choice || choice === "default") return String(state?.defaultModelValue || "").trim();
	if (choice === "session") return String(state?.sessionModelValue || "").trim();
	return choice;
}

function buildModelFlag(state) {
	const choice = String(state?.modelChoice || "").trim();
	if (!choice || choice === "default") return "";
	return ` --model ${quoteArg(choice)}`;
}

export function buildReviewCommand(state) {
	const mode = String(state?.mode || "working-tree").trim();
	const focus = buildFocusText(state);
	const modelFlag = buildModelFlag(state);

	if (mode === "working-tree") {
		return focus ? `/review${modelFlag} working-tree ${quoteArg(focus)}` : `/review${modelFlag} working-tree`;
	}
	if (mode === "commit") {
		const ref = String(state?.commitRef || "").trim();
		if (!ref) return "";
		return focus ? `/review${modelFlag} commit ${ref} ${quoteArg(focus)}` : `/review${modelFlag} commit ${ref}`;
	}
	if (mode === "branch") {
		const base = String(state?.baseRef || "").trim();
		if (!base) return "";
		return focus ? `/review${modelFlag} branch ${base} ${quoteArg(focus)}` : `/review${modelFlag} branch ${base}`;
	}
	const custom = String(state?.customInstructions || "").trim() || focus;
	return custom ? `/review${modelFlag} custom ${quoteArg(custom)}` : "";
}

export function createReviewLauncher({ menuOverlay, menuPanel, api, getActiveState, onSubmit }) {
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
		body.textContent = "Loading review options…";
		wrap.appendChild(body);
		menuPanel.appendChild(wrap);

		let models = [];
		let defaultModelValue = "";
		try {
			const [modelData, configData] = await Promise.all([
				typeof api?.getJson === "function" ? api.getJson("/api/models") : Promise.resolve({ models: [] }),
				typeof api?.getJson === "function" ? api.getJson("/api/review/config") : Promise.resolve({ defaultModel: null }),
			]);
			models = Array.isArray(modelData?.models)
				? [...modelData.models]
					.map((model) => ({
						value: formatModelValue(model),
						label: formatModelOptionLabel(model),
					}))
					.filter((model) => model.value)
					.sort((a, b) => a.label.localeCompare(b.label))
				: [];
			defaultModelValue = typeof configData?.defaultModel === "string" ? configData.defaultModel.trim() : "";
		} catch (error) {
			body.innerHTML = "";
			const err = document.createElement("div");
			err.className = "notice-text error";
			err.textContent = error instanceof Error ? error.message : String(error);
			body.appendChild(err);
			return;
		}

		const activeState = typeof getActiveState === "function" ? getActiveState() : null;
		const sessionModelValue = activeState?.model ? formatModelValue(activeState.model) : "";
		const sessionModelLabel = sessionModelValue
			? (activeState?.model?.name && activeState.model.name !== sessionModelValue
				? `${activeState.model.name} · ${sessionModelValue}`
				: sessionModelValue)
			: "";

		const state = {
			mode: "working-tree",
			commitRef: "HEAD~1",
			baseRef: "main",
			focuses: ["Bugs", "Security", "Tests", "Error handling", "New dependencies"],
			customFocus: "",
			customInstructions: "",
			defaultModelValue,
			sessionModelValue,
			modelChoice: defaultModelValue ? "default" : sessionModelValue ? "session" : (models[0]?.value || "default"),
			saveAsDefault: false,
		};
		const hasAnyModelOption = Boolean(defaultModelValue || sessionModelValue || models.length > 0);

		const focusOptions = ["Bugs", "Security", "Performance", "Tests", "Error handling", "New dependencies"];

		const renderModelSummary = () => {
			if (state.defaultModelValue) return `Saved review default: ${state.defaultModelValue}`;
			if (state.sessionModelValue) return `No saved review default. /review currently falls back to the session model: ${state.sessionModelValue}`;
			return "No saved review default. Pick a specific model for this run, or save one for future reviews.";
		};

		const clearSavedDefault = async (errorEl) => {
			if (!state.defaultModelValue || typeof api?.postJson !== "function") return;
			errorEl.textContent = "";
			errorEl.style.display = "none";
			try {
				const result = await api.postJson("/api/review/config", { defaultModel: null });
				state.defaultModelValue = typeof result?.defaultModel === "string" ? result.defaultModel.trim() : "";
				if (state.modelChoice === "default") {
					state.modelChoice = state.sessionModelValue ? "session" : (models[0]?.value || "default");
				}
				state.saveAsDefault = false;
				render();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				errorEl.style.display = "";
			}
		};

		const render = () => {
			body.innerHTML = "";

			const intro = document.createElement("div");
			intro.className = "agent-launcher-intro";
			intro.textContent = "Set up a review and run it without manually typing /review.";
			body.appendChild(intro);

			const modelSection = document.createElement("div");
			modelSection.className = "agent-launcher-step";

			const modelField = document.createElement("label");
			modelField.className = "agent-launcher-field";
			modelField.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Model" }));
			const modelSelect = document.createElement("select");
			modelSelect.className = "menu-search";

			if (state.defaultModelValue) {
				const option = document.createElement("option");
				option.value = "default";
				option.textContent = `Saved review default · ${state.defaultModelValue}`;
				modelSelect.appendChild(option);
			}
			if (state.sessionModelValue) {
				const option = document.createElement("option");
				option.value = "session";
				option.textContent = `Current session model · ${sessionModelLabel || state.sessionModelValue}`;
				modelSelect.appendChild(option);
			}
			if (models.length > 0 && (state.defaultModelValue || state.sessionModelValue)) {
				const separator = document.createElement("option");
				separator.disabled = true;
				separator.textContent = "──────────";
				modelSelect.appendChild(separator);
			}
			for (const model of models) {
				const option = document.createElement("option");
				option.value = model.value;
				option.textContent = model.label;
				modelSelect.appendChild(option);
			}
			modelSelect.value = state.modelChoice;
			modelSelect.addEventListener("change", () => {
				state.modelChoice = modelSelect.value;
				if (state.modelChoice === "default") state.saveAsDefault = false;
				render();
			});
			modelField.appendChild(modelSelect);

			const modelHint = document.createElement("div");
			modelHint.className = "secondary";
			modelHint.style.marginTop = "8px";
			modelHint.style.whiteSpace = "normal";
			modelHint.textContent = renderModelSummary();
			modelField.appendChild(modelHint);

			const saveRow = document.createElement("label");
			saveRow.className = "menu-item";
			saveRow.style.display = "flex";
			saveRow.style.alignItems = "center";
			saveRow.style.gap = "8px";
			saveRow.style.marginTop = "8px";
			const saveCheckbox = document.createElement("input");
			saveCheckbox.type = "checkbox";
			saveCheckbox.checked = Boolean(state.saveAsDefault);
			saveCheckbox.disabled = state.modelChoice === "default" || !getEffectiveModelValue(state);
			saveCheckbox.addEventListener("change", () => {
				state.saveAsDefault = saveCheckbox.checked;
			});
			const saveText = document.createElement("span");
			saveText.textContent = "Save the selected model as the default for future /review runs";
			saveRow.appendChild(saveCheckbox);
			saveRow.appendChild(saveText);
			modelField.appendChild(saveRow);

			if (state.defaultModelValue) {
				const clearDefaultBtn = document.createElement("button");
				clearDefaultBtn.type = "button";
				clearDefaultBtn.className = "menu-mini";
				clearDefaultBtn.style.marginTop = "8px";
				clearDefaultBtn.textContent = "Clear saved review default";
				modelField.appendChild(clearDefaultBtn);
				clearDefaultBtn.addEventListener("click", () => void clearSavedDefault(errorEl));
			}

			modelSection.appendChild(modelField);
			body.appendChild(modelSection);

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
				input.addEventListener("input", () => { state.commitRef = input.value; render(); });
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
				input.addEventListener("input", () => { state.baseRef = input.value; render(); });
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
				input.addEventListener("input", () => { state.customInstructions = input.value; render(); });
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
					render();
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
			customFocus.addEventListener("input", () => { state.customFocus = customFocus.value; render(); });
			focusWrap.appendChild(customFocus);
			section.appendChild(focusWrap);

			body.appendChild(section);

			const preview = document.createElement("div");
			preview.className = "agent-launcher-preview";
			preview.textContent = !hasAnyModelOption
				? "No review models are currently available."
				: buildReviewCommand(state) || "Fill in the required fields.";
			body.appendChild(preview);

			const errorEl = document.createElement("div");
			errorEl.className = "notice-text error";
			errorEl.style.display = "none";
			body.appendChild(errorEl);

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
			const command = buildReviewCommand(state);
			run.disabled = !hasAnyModelOption || !command;
			run.addEventListener("click", async () => {
				if (!command) return;
				errorEl.style.display = "none";
				errorEl.textContent = "";
				run.disabled = true;
				try {
					if (state.saveAsDefault && typeof api?.postJson === "function") {
						const effectiveModelValue = getEffectiveModelValue(state);
						if (effectiveModelValue) {
							const result = await api.postJson("/api/review/config", { defaultModel: effectiveModelValue });
							state.defaultModelValue = typeof result?.defaultModel === "string" ? result.defaultModel.trim() : "";
						}
					}
					close();
					if (typeof onSubmit === "function") onSubmit(command);
				} catch (error) {
					errorEl.textContent = error instanceof Error ? error.message : String(error);
					errorEl.style.display = "";
					run.disabled = false;
				}
			});
			actions.appendChild(cancel);
			actions.appendChild(run);
			body.appendChild(actions);
		};

		render();
	}

	return { show, close };
}
