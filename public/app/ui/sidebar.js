function formatRelativeTime(iso) {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 10) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d === 1) return "yesterday";
	return `${d}d ago`;
}

function shortPath(cwd) {
	if (!cwd) return "";
	return cwd.replace(/^\/root\//, "~/").replace(/^\/home\/[^/]+\//, "~/");
}

function shouldShowSession(s) {
	if (!s || typeof s !== "object") return false;
	if (s.isRunning) return true;
	const name = typeof s.name === "string" ? s.name.trim() : "";
	if (name) return true;
	const first = typeof s.firstMessage === "string" ? s.firstMessage.trim() : "";
	return first && first !== "(no messages)";
}

export function createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	api,
	clientId,
	onNotice,
	getActiveSessionId,
	onSelectSession,
	onSessionIdSelected,
}) {
	let isOpen = false;
	let viewMode = "sessions";
	let activeDeleteButton = null;
	let activeDeleteTimer = null;
	let lastRenderedSessions = [];
	let lastFetchedSessions = [];
	let sessionSearchQuery = "";
	let consecutiveRefreshFailures = 0;

	function resetDeleteButton(button) {
		if (!button) return;
		button.disabled = false;
		button.classList.remove("si-del-sure", "si-del-busy");
		button.textContent = "✕";
	}

	function armDeleteButton(button) {
		if (activeDeleteTimer) {
			clearTimeout(activeDeleteTimer);
			activeDeleteTimer = null;
		}
		if (activeDeleteButton && activeDeleteButton !== button) {
			resetDeleteButton(activeDeleteButton);
		}
		activeDeleteButton = button;
		button.classList.remove("si-del-busy");
		button.classList.add("si-del-sure");
		button.textContent = "Sure?";
		activeDeleteTimer = setTimeout(() => {
			if (activeDeleteButton === button) activeDeleteButton = null;
			resetDeleteButton(button);
			activeDeleteTimer = null;
		}, 2500);
	}

	async function deleteSessionRow(session, button, row) {
		if (activeDeleteTimer) {
			clearTimeout(activeDeleteTimer);
			activeDeleteTimer = null;
		}
		activeDeleteButton = button;
		if (row) row.remove();
		try {
			if (session.isRunning) {
				await api.postJson(`/api/sessions/${encodeURIComponent(session.id)}/stop`, {});
			}
			if (session.path) {
				const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/delete?path=${encodeURIComponent(session.path)}`, {
					method: "DELETE",
					headers: api.headers(),
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) {
					throw new Error(body.error || `${res.status} ${res.statusText}`);
				}
			}
			if (session.id === getActiveSessionId()) {
				onSelectSession(null);
			}
			await refresh();
		} catch (err) {
			await refresh({ force: true });
			onNotice(err instanceof Error ? err.message : String(err), "error");
			return;
		} finally {
			if (activeDeleteButton === button) activeDeleteButton = null;
		}
	}

	function setOpen(open) {
		if (!sidebar) return;
		isOpen = Boolean(open);
		sidebar.classList.toggle("open", isOpen);
		if (sidebarOverlay) sidebarOverlay.classList.toggle("open", isOpen);
	}

	function toggleOpen() { setOpen(!isOpen); }

	function highlightSessionRow(sessionId) {
		sessionsList.querySelectorAll(".si").forEach((row) => {
			row.classList.toggle("active", row.dataset.sessionId === sessionId);
		});
	}

	function renderSessionList(sessions) {
		lastFetchedSessions = Array.isArray(sessions) ? sessions.slice() : [];
		const query = sessionSearchQuery.trim().toLowerCase();
		const filtered = query
			? lastFetchedSessions.filter((s) => {
				const hay = [s?.name || "", s?.firstMessage || "", s?.cwd || "", s?.id || ""].join(" ").toLowerCase();
				return hay.includes(query);
			})
			: lastFetchedSessions.slice();
		lastRenderedSessions = filtered.slice();
		consecutiveRefreshFailures = 0;
		sessionsList.innerHTML = "";

		// New session button at top
		const newBtn = document.createElement("div");
		newBtn.className = "si si-new";
		newBtn.innerHTML = `<div class="si-name">＋ New Session</div><div class="si-meta">tap to pick a directory</div>`;
		newBtn.addEventListener("click", () => void showNewSessionPicker());
		sessionsList.appendChild(newBtn);

		const searchWrap = document.createElement("div");
		searchWrap.className = "sessions-search-wrap";
		const searchInput = document.createElement("input");
		searchInput.className = "sessions-search";
		searchInput.type = "search";
		searchInput.placeholder = "Search sessions…";
		searchInput.autocomplete = "off";
		searchInput.value = sessionSearchQuery;
		searchInput.addEventListener("input", () => {
			sessionSearchQuery = searchInput.value;
			renderSessionList(lastFetchedSessions);
			requestAnimationFrame(() => {
				const next = sessionsList.querySelector(".sessions-search");
				if (next) {
					next.focus();
					const end = next.value.length;
					next.setSelectionRange(end, end);
				}
			});
		});
		searchWrap.appendChild(searchInput);
		sessionsList.appendChild(searchWrap);

		if (filtered.length === 0) {
			const empty = document.createElement("div");
			empty.className = "si";
			empty.innerHTML = `<div class="si-meta" style="padding:12px 0">${query ? "No matching sessions" : "No sessions yet"}</div>`;
			sessionsList.appendChild(empty);
			return;
		}

		for (const s of filtered) {
			const row = document.createElement("div");
			row.className = `si${s.id === getActiveSessionId() ? " active" : ""}`;
			row.dataset.sessionId = s.id;

			const labelRaw = (typeof s.name === "string" && s.name.trim())
				|| (typeof s.firstMessage === "string" && s.firstMessage.trim())
				|| s.id.slice(0, 8);
			const label = String(labelRaw).replace(/\s+/g, " ").trim().slice(0, 60);

			const name = document.createElement("div");
			name.className = "si-name";
			name.textContent = label;
			name.title = label;

			const meta = document.createElement("div");
			meta.className = "si-meta";
			const rel = formatRelativeTime(s.modified);
			const dir = shortPath(s.cwd);
			meta.innerHTML = `${rel}${dir ? ` · ${dir}` : ""}${s.isRunning ? ` · <span class="si-run">running</span>` : ""}`;

			row.appendChild(name);
			row.appendChild(meta);

			// Delete button — touch-first in-place "Sure?" confirmation
			const del = document.createElement("button");
			del.className = "si-del";
			del.type = "button";
			del.textContent = "✕";
			del.title = s.isRunning ? "Stop & delete" : "Delete";
			del.setAttribute("aria-label", del.title);
			const stopRowTap = (e) => {
				e.preventDefault();
				e.stopPropagation();
			};
			const handleDeleteTap = () => {
				if (del.disabled) return;
				if (del.classList.contains("si-del-sure")) {
					void deleteSessionRow(s, del, row);
					return;
				}
				armDeleteButton(del);
			};
			del.addEventListener("pointerdown", (e) => {
				stopRowTap(e);
				if (e.button !== 0) return;
				handleDeleteTap();
			});
			del.addEventListener("click", stopRowTap);
			del.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					stopRowTap(e);
					handleDeleteTap();
				}
			});
			row.appendChild(del);

			row.addEventListener("click", () => {
				highlightSessionRow(s.id);
				void onSelectSession(s);
			});

			sessionsList.appendChild(row);
		}
	}

	async function showNewSessionPicker() {
		viewMode = "picker";
		let repos = [];
		let currentResults = [];
		try {
			const data = await api.getJson("/api/repos");
			repos = Array.isArray(data.repos) ? data.repos : [];
		} catch { /* ignore */ }

		// Show inline picker replacing the session list
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "New Session";

		// Back button
		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => {
			viewMode = "sessions";
			if (sidebarLabel) sidebarLabel.textContent = "Sessions";
			void refresh({ force: true });
		});
		sessionsList.appendChild(backBtn);

		// Fuzzy search input
		const inputRow = document.createElement("div");
		inputRow.style.cssText = "padding:8px 12px;";
		const pathInput = document.createElement("input");
		pathInput.type = "text";
		pathInput.placeholder = "Search folders…";
		pathInput.style.cssText = "width:100%;padding:8px;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:6px;font-size:13px;box-sizing:border-box;";

		// Container for folder results
		const resultsContainer = document.createElement("div");
		resultsContainer.id = "new-session-results";

		let searchTimer = null;
		const renderFolderList = (dirs) => {
			currentResults = Array.isArray(dirs) ? dirs.slice() : [];
			resultsContainer.innerHTML = "";
			if (dirs.length === 0) {
				const hint = document.createElement("div");
				hint.className = "si";
				hint.innerHTML = `<div class="si-meta" style="padding:8px 0">No matching directories.</div>`;
				resultsContainer.appendChild(hint);
				return;
			}
			for (const cwd of dirs) {
				const row = document.createElement("div");
				row.className = "si";
				const name = document.createElement("div");
				name.className = "si-name";
				name.textContent = shortPath(cwd);
				name.title = cwd;
				row.appendChild(name);
				row.addEventListener("click", () => void startInDir(cwd));
				resultsContainer.appendChild(row);
			}
		};

		pathInput.addEventListener("input", () => {
			const val = pathInput.value.trim();
			if (searchTimer) clearTimeout(searchTimer);
			if (!val) {
				// Show known repos when input is empty
				renderFolderList(repos);
				return;
			}
			// Debounce fuzzy search
			searchTimer = setTimeout(async () => {
				try {
					const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
					const dirs = Array.isArray(data.dirs) ? data.dirs : [];
					renderFolderList(dirs);
				} catch {
					renderFolderList([]);
				}
			}, 250);
		});

		pathInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const val = pathInput.value.trim();
				if (!val) return;
				if (currentResults.length > 0) {
					void startInDir(currentResults[0]);
					return;
				}
				const looksLikePath = val.startsWith("/") || val.startsWith("~/") || val === "~" || val.startsWith("./") || val.startsWith("../");
				if (looksLikePath) {
					void startInDir(val);
					return;
				}
				onNotice("No matching directory yet — keep typing or tap a result.", "warning");
			}
		});
		inputRow.appendChild(pathInput);
		sessionsList.appendChild(inputRow);
		sessionsList.appendChild(resultsContainer);

		// Show known repos initially
		renderFolderList(repos);
		setTimeout(() => pathInput.focus(), 0);
	}

	async function startInDir(cwd) {
		try {
			const result = await api.postJson("/api/sessions", { clientId, cwd: cwd.trim() });
			viewMode = "sessions";
			onSessionIdSelected(result.sessionId);
			setOpen(false);
		} catch (err) {
			viewMode = "picker";
			onNotice(err instanceof Error ? err.message : String(err), "error");
		}
	}

	async function refresh(options = {}) {
		if (viewMode === "picker" && !options.force) return;
		viewMode = "sessions";
		if (sidebarLabel) sidebarLabel.textContent = "Sessions";
		try {
			// Show all sessions: active first, then recent saved
			const activeData = await api.getJson("/api/active-sessions");
			const active = Array.isArray(activeData.sessions) ? activeData.sessions : [];

			const allData = await api.getJson("/api/sessions");
			const all = Array.isArray(allData.sessions) ? allData.sessions : [];

			// Merge: active sessions first, then saved (deduplicated)
			const seen = new Set();
			const merged = [];
			for (const s of active) {
				if (!shouldShowSession(s)) continue;
				seen.add(s.id);
				merged.push(s);
			}
			for (const s of all) {
				if (seen.has(s.id)) continue;
				if (!shouldShowSession(s)) continue;
				merged.push(s);
			}

			// Sort by modified descending
			merged.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));

			renderSessionList(merged.slice(0, 50));
		} catch (error) {
			consecutiveRefreshFailures += 1;
			if (lastRenderedSessions.length > 0 && consecutiveRefreshFailures < 3) {
				// Keep the existing list during transient fetch failures instead of replacing it
				// with a scary error state. This makes stale "running" entries much less disruptive.
				return;
			}
			sessionsList.innerHTML = "";
			const row = document.createElement("div");
			row.className = "si";
			row.innerHTML = `<div class="si-meta">Failed to load: ${error instanceof Error ? error.message : String(error)}</div>`;
			sessionsList.appendChild(row);
		}
	}

	// Header buttons
	if (btnSidebarLeft) {
		btnSidebarLeft.innerHTML = `<span class="txt">Sessions</span>`;
		btnSidebarLeft.onclick = () => void refresh();
	}
	if (btnSidebarRight) {
		btnSidebarRight.innerHTML = `<span class="txt">＋</span>`;
		btnSidebarRight.onclick = () => void showNewSessionPicker();
	}

	return {
		setOpen,
		toggleOpen,
		refresh,
		highlightSessionRow,
		isPickerOpen: () => viewMode === "picker",
		setMode: () => {}, // compat
		updateHeader: () => {}, // compat
	};
}
