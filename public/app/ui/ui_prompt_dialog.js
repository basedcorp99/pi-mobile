export function createUiPromptDialog({ menuOverlay, menuScrim, menuPanel }) {
	let activeCallback = null;

	function close() {
		if (menuOverlay) menuOverlay.classList.remove("open");
		if (menuPanel) menuPanel.innerHTML = "";
		activeCallback = null;
	}

	function showSelect(uiId, title, options, onSubmit) {
		if (!menuOverlay || !menuPanel) return;
		activeCallback = onSubmit;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "8px";
		menuPanel.style.top = "60px";
		menuPanel.style.right = "8px";
		menuPanel.style.width = "auto";
		menuPanel.style.maxWidth = "min(520px, 92vw)";

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const titleEl = document.createElement("div");
		titleEl.className = "menu-title";
		titleEl.textContent = title;
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "menu-mini";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", () => {
			close();
			onSubmit(uiId, true);
		});
		hdr.appendChild(titleEl);
		hdr.appendChild(cancelBtn);
		menuPanel.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body";
		const list = document.createElement("div");
		list.className = "menu-list";

		for (const option of options) {
			const item = document.createElement("div");
			item.className = "menu-item";
			const primary = document.createElement("div");
			primary.className = "primary";
			const label = typeof option === "string"
				? option
				: typeof option?.label === "string"
					? option.label
					: String(option?.label ?? option?.value ?? "");
			const value = typeof option === "string"
				? option
				: typeof option?.value === "string"
					? option.value
					: label;
			primary.textContent = label;
			item.appendChild(primary);
			item.addEventListener("click", () => {
				close();
				onSubmit(uiId, false, value);
			});
			list.appendChild(item);
		}
		body.appendChild(list);
		menuPanel.appendChild(body);
	}

	function showInput(uiId, title, placeholder, onSubmit) {
		if (!menuOverlay || !menuPanel) return;
		activeCallback = onSubmit;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "8px";
		menuPanel.style.top = "60px";
		menuPanel.style.right = "8px";
		menuPanel.style.width = "auto";
		menuPanel.style.maxWidth = "min(520px, 92vw)";

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const titleEl = document.createElement("div");
		titleEl.className = "menu-title";
		titleEl.textContent = title;
		const cancelBtn = document.createElement("button");
		cancelBtn.className = "menu-mini";
		cancelBtn.textContent = "Cancel";
		cancelBtn.addEventListener("click", () => {
			close();
			onSubmit(uiId, true);
		});
		hdr.appendChild(titleEl);
		hdr.appendChild(cancelBtn);
		menuPanel.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body";
		body.style.padding = "12px";

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = placeholder || "";
		input.style.cssText = "width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:6px;font-size:15px;box-sizing:border-box;";
		body.appendChild(input);

		const submitBtn = document.createElement("button");
		submitBtn.className = "menu-mini";
		submitBtn.style.cssText = "margin-top:10px;width:100%;padding:10px;background:#1e2a20;border-color:#2a3a2a;color:#b5bd68;";
		submitBtn.textContent = "Submit";
		submitBtn.addEventListener("click", () => {
			const val = input.value.trim();
			close();
			onSubmit(uiId, false, val || undefined);
		});
		body.appendChild(submitBtn);
		menuPanel.appendChild(body);

		setTimeout(() => input.focus(), 100);
	}

	function showConfirm(uiId, title, message, onSubmit) {
		if (!menuOverlay || !menuPanel) return;
		activeCallback = onSubmit;
		menuOverlay.classList.add("open");
		menuPanel.innerHTML = "";
		menuPanel.style.left = "8px";
		menuPanel.style.top = "60px";
		menuPanel.style.right = "8px";
		menuPanel.style.width = "auto";
		menuPanel.style.maxWidth = "min(520px, 92vw)";

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const titleEl = document.createElement("div");
		titleEl.className = "menu-title";
		titleEl.textContent = title;
		hdr.appendChild(titleEl);
		menuPanel.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body";
		body.style.padding = "12px";

		const msg = document.createElement("div");
		msg.style.cssText = "color:#ccc;margin-bottom:12px;";
		msg.textContent = message;
		body.appendChild(msg);

		const btnRow = document.createElement("div");
		btnRow.style.cssText = "display:flex;gap:8px;";

		const noBtn = document.createElement("button");
		noBtn.className = "menu-mini";
		noBtn.style.cssText = "flex:1;padding:10px;";
		noBtn.textContent = "No";
		noBtn.addEventListener("click", () => {
			close();
			onSubmit(uiId, false, "false");
		});
		btnRow.appendChild(noBtn);

		const yesBtn = document.createElement("button");
		yesBtn.className = "menu-mini";
		yesBtn.style.cssText = "flex:1;padding:10px;background:#1e2a20;border-color:#2a3a2a;color:#b5bd68;";
		yesBtn.textContent = "Yes";
		yesBtn.addEventListener("click", () => {
			close();
			onSubmit(uiId, false, "true");
		});
		btnRow.appendChild(yesBtn);

		body.appendChild(btnRow);
		menuPanel.appendChild(body);
	}

	return { showSelect, showInput, showConfirm, close };
}
