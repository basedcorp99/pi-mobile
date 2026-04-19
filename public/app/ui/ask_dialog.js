const OTHER_OPTION = "Other (provide your own answer)";

function emptySelection() {
	return { selectedOptions: [], customInput: undefined };
}

function cloneSelection(selection) {
	return {
		selectedOptions: Array.isArray(selection?.selectedOptions) ? [...selection.selectedOptions] : [],
		customInput: typeof selection?.customInput === "string" ? selection.customInput : undefined,
	};
}

function mergeSelections(previousQuestions, previousSelections, nextQuestions) {
	const byId = new Map();
	for (let i = 0; i < previousQuestions.length; i += 1) {
		const question = previousQuestions[i];
		if (!question?.id) continue;
		byId.set(question.id, cloneSelection(previousSelections[i]));
	}
	return nextQuestions.map((question) => byId.get(question.id) || emptySelection());
}

export function createAskDialog({ host, getSendOnEnter }) {
	const dialogs = new Map();
	let activeSessionId = null;
	let isController = false;
	let overlay = null;
	let panel = null;

	function ensureUi() {
		if (overlay && panel) return;
		if (!host) return;
		overlay = document.createElement("div");
		overlay.className = "ask-session-overlay";
		overlay.hidden = true;
		const scrim = document.createElement("div");
		scrim.className = "ask-session-scrim";
		scrim.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			close(undefined, true);
		});
		panel = document.createElement("div");
		panel.className = "ask-session-panel";
		overlay.appendChild(scrim);
		overlay.appendChild(panel);
		host.appendChild(overlay);
	}

	function getVisibleDialog() {
		if (!activeSessionId || !isController) return null;
		return dialogs.get(activeSessionId) || null;
	}

	function hideUi() {
		if (overlay) overlay.hidden = true;
		if (panel) panel.innerHTML = "";
	}

	function finish(dialog, cancelled, answerSelections) {
		dialogs.delete(dialog.sessionId);
		if (dialog.sessionId === activeSessionId) hideUi();
		dialog.onSubmit(dialog.askId, cancelled, answerSelections);
	}

	function close(sessionId = activeSessionId, cancelled = false, askId = undefined) {
		if (!sessionId) {
			hideUi();
			return;
		}
		const dialog = dialogs.get(sessionId);
		if (!dialog) {
			if (sessionId === activeSessionId) hideUi();
			return;
		}
		if (typeof askId === "string" && askId && dialog.askId !== askId) return;
		dialogs.delete(sessionId);
		if (sessionId === activeSessionId) hideUi();
		if (cancelled) {
			dialog.onSubmit(dialog.askId, true, []);
		}
	}

	function renderCurrent() {
		ensureUi();
		if (!panel || !overlay) return;
		const dialog = getVisibleDialog();
		if (!dialog) {
			hideUi();
			return;
		}

		overlay.hidden = false;
		panel.innerHTML = "";
		const index = Math.max(0, Math.min(dialog.currentIndex, dialog.questions.length - 1));
		dialog.currentIndex = index;
		const q = dialog.questions[index];
		const sel = dialog.selections[index] || (dialog.selections[index] = emptySelection());
		const questionCount = dialog.questions.length;
		const isMulti = Boolean(q?.multi);
		const editorQuestionId = q?.id || `idx:${index}`;
		const isEditingCustom = dialog.customEditor?.questionId === editorQuestionId;
		const sendOnEnter = typeof getSendOnEnter === "function" ? Boolean(getSendOnEnter()) : true;
		const persistCustomDraft = (draftText) => {
			const raw = typeof draftText === "string"
				? draftText
				: dialog.customEditor?.questionId === editorQuestionId
					? (dialog.customEditor.draft || "")
					: (sel.customInput || "");
			if (dialog.customEditor?.questionId === editorQuestionId) {
				dialog.customEditor.draft = raw;
			}
			const trimmed = raw.trim();
			sel.customInput = trimmed || undefined;
			if (!isMulti && (trimmed || dialog.customEditor?.questionId === editorQuestionId)) {
				sel.selectedOptions = [];
			}
			return trimmed;
		};
		const closeCustomEditor = () => {
			if (dialog.customEditor?.questionId === editorQuestionId) dialog.customEditor = null;
		};
		const goToQuestion = (nextIndex) => {
			persistCustomDraft();
			closeCustomEditor();
			dialog.currentIndex = Math.max(0, Math.min(nextIndex, questionCount - 1));
			renderCurrent();
		};
		const submitSelections = () => {
			persistCustomDraft();
			closeCustomEditor();
			finish(dialog, false, dialog.selections.map((entry) => cloneSelection(entry)));
		};

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const title = document.createElement("div");
		title.className = "menu-title";
		title.textContent = questionCount > 1 ? `Question ${index + 1}/${questionCount}` : "Choose an option";
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "menu-mini";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", () => close(dialog.sessionId, true));
		hdr.appendChild(title);
		hdr.appendChild(cancelBtn);
		panel.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body";
		const qText = document.createElement("div");
		qText.className = "ask-question";
		qText.textContent = q?.question || "";
		body.appendChild(qText);

		if (q?.description && q.description.trim()) {
			const desc = document.createElement("div");
			desc.className = "ask-desc";
			desc.textContent = q.description;
			body.appendChild(desc);
		}

		const hint = document.createElement("div");
		hint.className = "ask-hint";
		hint.textContent = isMulti ? "Select one or more. You can switch sessions and come back later." : "Choose one option. You can switch sessions and come back later.";
		body.appendChild(hint);

		const list = document.createElement("div");
		list.className = "menu-list ask-options";
		for (let oi = 0; oi < (q?.options?.length || 0); oi += 1) {
			const opt = q.options[oi];
			const label = typeof opt === "string" ? opt : opt?.label;
			if (!label) continue;
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
					persistCustomDraft();
					const idx = sel.selectedOptions.indexOf(label);
					if (idx >= 0) sel.selectedOptions.splice(idx, 1);
					else sel.selectedOptions.push(label);
					renderCurrent();
					return;
				}
				sel.selectedOptions = [label];
				sel.customInput = undefined;
				dialog.customEditor = null;
				if (questionCount === 1) {
					finish(dialog, false, dialog.selections.map((entry) => cloneSelection(entry)));
					return;
				}
				renderCurrent();
			});
			list.appendChild(item);
		}

		const otherItem = document.createElement("div");
		otherItem.className = "menu-item ask-option ask-option-other";
		if (sel.customInput !== undefined || isEditingCustom) otherItem.classList.add("active");
		const otherRow = document.createElement("div");
		otherRow.className = "ask-option-row";
		const otherMarker = document.createElement("span");
		otherMarker.className = "ask-option-marker";
		otherMarker.textContent = sel.customInput !== undefined || isEditingCustom ? "●" : "•";
		const otherPrimary = document.createElement("div");
		otherPrimary.className = "primary ask-option-primary";
		otherPrimary.textContent = OTHER_OPTION;
		otherRow.appendChild(otherMarker);
		otherRow.appendChild(otherPrimary);
		otherItem.appendChild(otherRow);
		const otherSecondary = document.createElement("div");
		otherSecondary.className = "secondary ask-option-secondary";
		otherSecondary.textContent = sel.customInput !== undefined
			? `Custom: ${sel.customInput}`
			: isEditingCustom
				? "Enter your own answer below"
				: "Type your own answer";
		otherItem.appendChild(otherSecondary);
		otherItem.addEventListener("click", () => {
			if (!isMulti) sel.selectedOptions = [];
			dialog.customEditor = {
				questionId: editorQuestionId,
				draft: dialog.customEditor?.questionId === editorQuestionId
					? dialog.customEditor.draft
					: sel.customInput || "",
			};
			renderCurrent();
		});
		list.appendChild(otherItem);
		body.appendChild(list);

		if (isEditingCustom) {
			const customEditor = document.createElement("div");
			customEditor.className = "ask-custom-editor";
			const customInput = document.createElement("textarea");
			customInput.className = "ask-custom-input";
			customInput.rows = 3;
			customInput.placeholder = "Type your answer here";
			customInput.value = dialog.customEditor?.draft || "";
			customInput.addEventListener("input", () => {
				persistCustomDraft(customInput.value);
			});
			customInput.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					closeCustomEditor();
					renderCurrent();
					return;
				}
				if (sendOnEnter) {
					if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
						event.preventDefault();
						if (questionCount > 1 && index < questionCount - 1) goToQuestion(index + 1);
						else submitSelections();
					}
					return;
				}
				if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					if (questionCount > 1 && index < questionCount - 1) goToQuestion(index + 1);
					else submitSelections();
				}
			});
			customEditor.appendChild(customInput);
			body.appendChild(customEditor);

			requestAnimationFrame(() => {
				customInput.focus();
				const end = customInput.value.length;
				customInput.setSelectionRange(end, end);
			});
		}

		if (isMulti || questionCount > 1 || isEditingCustom || sel.customInput !== undefined) {
			const nav = document.createElement("div");
			nav.className = "ask-nav";
			if (questionCount > 1 && index > 0) {
				const prev = document.createElement("button");
				prev.className = "menu-mini";
				prev.textContent = "← Previous";
				prev.addEventListener("click", () => {
					goToQuestion(index - 1);
				});
				nav.appendChild(prev);
			}

			const spacer = document.createElement("div");
			spacer.style.flex = "1";
			nav.appendChild(spacer);

			if (questionCount > 1 && index < questionCount - 1) {
				const next = document.createElement("button");
				next.className = "menu-mini";
				next.textContent = "Next →";
				next.addEventListener("click", () => {
					goToQuestion(index + 1);
				});
				nav.appendChild(next);
			} else {
				const submit = document.createElement("button");
				submit.className = "menu-mini";
				submit.style.background = "#1e2a20";
				submit.style.borderColor = "#2a3a2a";
				submit.style.color = "#b5bd68";
				submit.textContent = "Submit";
				submit.addEventListener("click", () => submitSelections());
				nav.appendChild(submit);
			}
			body.appendChild(nav);
		}

		panel.appendChild(body);
	}

	function setActiveSession(sessionId, controller) {
		const nextSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
		const nextController = Boolean(controller);
		if (nextSessionId === activeSessionId && nextController === isController) return;
		activeSessionId = nextSessionId;
		isController = nextController;
		renderCurrent();
	}

	function reconcile(sessionId, pendingAskIds = []) {
		const normalizedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
		if (!normalizedSessionId) return;
		const dialog = dialogs.get(normalizedSessionId);
		if (!dialog) return;
		const pending = Array.isArray(pendingAskIds) ? pendingAskIds : [];
		if (pending.includes(dialog.askId)) return;
		dialogs.delete(normalizedSessionId);
		if (normalizedSessionId === activeSessionId) hideUi();
	}

	function show(sessionId, askId, questions, onSubmit) {
		if (!sessionId || typeof askId !== "string" || !Array.isArray(questions)) return;
		const existing = dialogs.get(sessionId);
		if (existing && existing.askId === askId) {
			const previousQuestions = existing.questions;
			const previousSelections = existing.selections;
			existing.questions = questions;
			existing.selections = mergeSelections(previousQuestions, previousSelections, questions);
			existing.currentIndex = Math.max(0, Math.min(existing.currentIndex, Math.max(0, questions.length - 1)));
			existing.onSubmit = onSubmit;
		} else {
			dialogs.set(sessionId, {
				sessionId,
				askId,
				questions,
				selections: questions.map(() => emptySelection()),
				currentIndex: 0,
				customEditor: null,
				onSubmit,
			});
		}
		if (sessionId === activeSessionId) renderCurrent();
	}

	return {
		show,
		close,
		reconcile,
		setActiveSession,
		isOpen: (sessionId) => (typeof sessionId === "string" ? dialogs.has(sessionId) : Boolean(getVisibleDialog())),
	};
}
