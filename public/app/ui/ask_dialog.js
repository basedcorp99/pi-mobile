const OTHER_OPTION = "Other (provide your own answer)";

export function createAskDialog({ menuOverlay, menuScrim, menuPanel }) {
	let activeDialog = null;

	function resetUi() {
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

	function close(cancelled = false) {
		const current = activeDialog;
		activeDialog = null;
		resetUi();
		if (cancelled && current) {
			current.onSubmit(current.askId, true, []);
		}
	}

	function show(askId, questions, onSubmit) {
		if (!menuOverlay || !menuPanel) return;
		close(false);
		activeDialog = { askId, onSubmit };

		const selections = questions.map(() => ({ selectedOptions: [], customInput: undefined }));
		const finish = (cancelled, answerSelections) => {
			activeDialog = null;
			resetUi();
			onSubmit(askId, cancelled, answerSelections);
		};

		menuOverlay.classList.add("open");
		menuOverlay.dataset.locked = "1";
		menuOverlay.dataset.kind = "ask";
		menuPanel.innerHTML = "";
		menuPanel.style.left = "50%";
		menuPanel.style.top = "50%";
		menuPanel.style.right = "auto";
		menuPanel.style.width = "min(560px, 94vw)";
		menuPanel.style.maxWidth = "min(560px, 94vw)";
		menuPanel.style.maxHeight = "min(82vh, 760px)";
		menuPanel.style.transform = "translate(-50%, -50%)";

		function renderQuestion(index) {
			menuPanel.innerHTML = "";
			const q = questions[index];
			const sel = selections[index];
			const isMulti = Boolean(q.multi);

			const hdr = document.createElement("div");
			hdr.className = "menu-hdr";
			const title = document.createElement("div");
			title.className = "menu-title";
			title.textContent = questions.length > 1 ? `Question ${index + 1}/${questions.length}` : "Choose an option";
			const cancelBtn = document.createElement("button");
			cancelBtn.className = "menu-mini";
			cancelBtn.textContent = "Cancel";
			cancelBtn.addEventListener("click", () => close(true));
			hdr.appendChild(title);
			hdr.appendChild(cancelBtn);
			menuPanel.appendChild(hdr);

			const body = document.createElement("div");
			body.className = "menu-body";

			const qText = document.createElement("div");
			qText.className = "ask-question";
			qText.textContent = q.question;
			body.appendChild(qText);

			if (q.description && q.description.trim()) {
				const desc = document.createElement("div");
				desc.className = "ask-desc";
				desc.textContent = q.description;
				body.appendChild(desc);
			}

			const hint = document.createElement("div");
			hint.className = "ask-hint";
			hint.textContent = isMulti ? "Select one or more. Tap Cancel to leave this dialog." : "Choose one option. Tap Cancel to leave this dialog.";
			body.appendChild(hint);

			const list = document.createElement("div");
			list.className = "menu-list ask-options";

			for (let oi = 0; oi < q.options.length; oi++) {
				const opt = q.options[oi];
				const label = typeof opt === "string" ? opt : opt.label;
				const isRecommended = typeof q.recommended === "number" && q.recommended === oi;
				const item = document.createElement("div");
				item.className = "menu-item ask-option";
				if (sel.selectedOptions.includes(label)) item.classList.add("active");

				const row = document.createElement("div");
				row.className = "ask-option-row";
				const marker = document.createElement("span");
				marker.className = "ask-option-marker";
				marker.textContent = sel.selectedOptions.includes(label) ? "●" : "•";
				const primary = document.createElement("div");
				primary.className = "primary ask-option-primary";
				primary.textContent = label;
				row.appendChild(marker);
				row.appendChild(primary);
				item.appendChild(row);
				if (isRecommended) {
					const badge = document.createElement("div");
					badge.className = "secondary ask-option-secondary";
					badge.textContent = "Recommended";
					item.appendChild(badge);
				}

				item.addEventListener("click", () => {
					if (isMulti) {
						const idx = sel.selectedOptions.indexOf(label);
						if (idx >= 0) sel.selectedOptions.splice(idx, 1);
						else sel.selectedOptions.push(label);
						renderQuestion(index);
					} else {
						sel.selectedOptions = [label];
						sel.customInput = undefined;
						if (questions.length === 1) {
							finish(false, selections);
						} else {
							renderQuestion(index);
						}
					}
				});
				list.appendChild(item);
			}

			const otherItem = document.createElement("div");
			otherItem.className = "menu-item ask-option ask-option-other";
			if (sel.customInput !== undefined) otherItem.classList.add("active");
			const otherRow = document.createElement("div");
			otherRow.className = "ask-option-row";
			const otherMarker = document.createElement("span");
			otherMarker.className = "ask-option-marker";
			otherMarker.textContent = sel.customInput !== undefined ? "●" : "•";
			const otherPrimary = document.createElement("div");
			otherPrimary.className = "primary ask-option-primary";
			otherPrimary.textContent = OTHER_OPTION;
			otherRow.appendChild(otherMarker);
			otherRow.appendChild(otherPrimary);
			otherItem.appendChild(otherRow);
			const otherSecondary = document.createElement("div");
			otherSecondary.className = "secondary ask-option-secondary";
			otherSecondary.textContent = sel.customInput !== undefined ? `Custom: ${sel.customInput}` : "Type your own answer";
			otherItem.appendChild(otherSecondary);
			otherItem.addEventListener("click", () => {
				const input = window.prompt("Your answer:");
				if (input !== null && input.trim()) {
					sel.customInput = input.trim();
					if (!isMulti) sel.selectedOptions = [];
					if (questions.length === 1 && !isMulti) {
						finish(false, selections);
					} else {
						renderQuestion(index);
					}
				}
			});
			list.appendChild(otherItem);
			body.appendChild(list);

			if (isMulti || questions.length > 1) {
				const nav = document.createElement("div");
				nav.className = "ask-nav";

				if (questions.length > 1 && index > 0) {
					const prev = document.createElement("button");
					prev.className = "menu-mini";
					prev.textContent = "← Previous";
					prev.addEventListener("click", () => renderQuestion(index - 1));
					nav.appendChild(prev);
				}

				const spacer = document.createElement("div");
				spacer.style.flex = "1";
				nav.appendChild(spacer);

				if (questions.length > 1 && index < questions.length - 1) {
					const next = document.createElement("button");
					next.className = "menu-mini";
					next.textContent = "Next →";
					next.addEventListener("click", () => renderQuestion(index + 1));
					nav.appendChild(next);
				} else {
					const submit = document.createElement("button");
					submit.className = "menu-mini";
					submit.style.background = "#1e2a20";
					submit.style.borderColor = "#2a3a2a";
					submit.style.color = "#b5bd68";
					submit.textContent = "Submit";
					submit.addEventListener("click", () => finish(false, selections));
					nav.appendChild(submit);
				}

				body.appendChild(nav);
			}

			menuPanel.appendChild(body);
		}

		renderQuestion(0);
	}

	return { show, close, isOpen: () => Boolean(activeDialog) };
}
