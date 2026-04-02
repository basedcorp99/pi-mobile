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
	onRenameSession,
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

	async function renameSessionRow(session) {
		if (typeof onRenameSession !== "function") return;
		const currentLabel = (typeof session?.name === "string" && session.name.trim())
			|| (typeof session?.firstMessage === "string" && session.firstMessage.trim())
			|| "";
		const next = window.prompt("Rename session", currentLabel);
		if (next === null) return;
		const trimmed = next.trim();
		if (!trimmed) {
			onNotice("Session name cannot be empty", "error");
			return;
		}
		try {
			await onRenameSession(session, trimmed);
			await refresh({ force: true });
		} catch (err) {
			onNotice(err instanceof Error ? err.message : String(err), "error");
		}
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

			const stopRowTap = (e) => {
				e.preventDefault();
				e.stopPropagation();
			};

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

			const rename = document.createElement("button");
			rename.className = "si-rename";
			rename.type = "button";
			rename.textContent = "✎";
			rename.title = "Rename session";
			rename.setAttribute("aria-label", rename.title);
			rename.addEventListener("pointerdown", (e) => {
				stopRowTap(e);
				if (e.button !== 0) return;
				void renameSessionRow(s);
			});
			rename.addEventListener("click", stopRowTap);
			rename.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					stopRowTap(e);
					void renameSessionRow(s);
				}
			});
			row.appendChild(rename);

			// Delete button — touch-first in-place "Sure?" confirmation
			const del = document.createElement("button");
			del.className = "si-del";
			del.type = "button";
			del.textContent = "✕";
			del.title = s.isRunning ? "Stop & delete" : "Delete";
			del.setAttribute("aria-label", del.title);
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
		inputRow.className = "sessions-search-wrap";
		const pathInput = document.createElement("input");
		pathInput.className = "sessions-search";
		pathInput.type = "text";
		pathInput.placeholder = "Search folders…";

		// Container for folder results
		const resultsContainer = document.createElement("div");
		resultsContainer.id = "new-session-results";

		let searchTimer = null;
		let searchSeq = 0;
		const filterDirsLocally = (query) => {
			const q = String(query || "").trim().toLowerCase();
			if (!q) return repos.slice();
			return repos.filter((dir) => String(dir || "").toLowerCase().includes(q));
		};
		const renderFolderList = (dirs) => {
			currentResults = Array.isArray(dirs) ? dirs.slice() : [];
			resultsContainer.innerHTML = "";
			if (dirs.length === 0) {
				const hint = document.createElement("div");
				hint.className = "si";
				const meta = document.createElement("div");
				meta.className = "si-meta new-session-empty";
				meta.textContent = "No matching directories.";
				hint.appendChild(meta);
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
				renderFolderList(repos);
				return;
			}
			renderFolderList(filterDirsLocally(val));
			const seq = ++searchSeq;
			searchTimer = setTimeout(async () => {
				try {
					const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
					if (seq !== searchSeq || pathInput.value.trim() !== val) return;
					const dirs = Array.isArray(data.dirs) ? data.dirs : [];
					renderFolderList(dirs);
				} catch {
					if (seq !== searchSeq || pathInput.value.trim() !== val) return;
					renderFolderList(filterDirsLocally(val));
				}
			}, 250);
		});

		pathInput.addEventListener("keydown", async (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const val = pathInput.value.trim();
			if (!val) {
				void startInDir("/root");
				return;
			}
			const immediate = currentResults[0] || filterDirsLocally(val)[0] || null;
			if (immediate) {
				void startInDir(immediate);
				return;
			}
			const looksLikePath = val.startsWith("/") || val.startsWith("~/") || val === "~" || val.startsWith("./") || val.startsWith("../");
			if (looksLikePath) {
				void startInDir(val);
				return;
			}
			try {
				const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
				const dirs = Array.isArray(data.dirs) ? data.dirs : [];
				if (dirs[0]) {
					void startInDir(dirs[0]);
					return;
				}
			} catch {
				// fall through to default cwd
			}
			void startInDir("/root");
		});
		inputRow.appendChild(pathInput);
		sessionsList.appendChild(inputRow);
		sessionsList.appendChild(resultsContainer);

		// Show known repos initially
		renderFolderList(repos);
		setTimeout(() => pathInput.focus(), 0);
	}

	async function startInDir(cwd) {
		const trimmedCwd = cwd.trim();
		try {
			const gitCheck = await api.getJson(`/api/is-git-repo?path=${encodeURIComponent(trimmedCwd)}`);
			if (gitCheck?.isGitRepo) {
				void showWorktreeChoice(trimmedCwd);
				return;
			}
		} catch { /* non-git, proceed normally */ }
		try {
			const result = await api.postJson("/api/sessions", { clientId, cwd: trimmedCwd });
			viewMode = "sessions";
			onSessionIdSelected(result.sessionId);
			setOpen(false);
		} catch (err) {
			viewMode = "picker";
			onNotice(err instanceof Error ? err.message : String(err), "error");
		}
	}

	async function startNormalSession(cwd) {
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

	function showWorktreeChoice(cwd) {
		viewMode = "picker";
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "Session Type";

		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => void showNewSessionPicker());
		sessionsList.appendChild(backBtn);

		const info = document.createElement("div");
		info.className = "si";
		const infoMeta = document.createElement("div");
		infoMeta.className = "si-meta new-session-empty";
		infoMeta.textContent = `Git repo: ${shortPath(cwd)}`;
		info.appendChild(infoMeta);
		sessionsList.appendChild(info);

		const normalBtn = document.createElement("div");
		normalBtn.className = "si si-new";
		normalBtn.innerHTML = `<div class="si-name">Normal Session</div><div class="si-meta">Open directly in the repo root</div>`;
		normalBtn.addEventListener("click", () => void startNormalSession(cwd));
		sessionsList.appendChild(normalBtn);

		const wtBtn = document.createElement("div");
		wtBtn.className = "si si-new";
		wtBtn.innerHTML = `<div class="si-name">🌿 New Worktree</div><div class="si-meta">Independent branch + isolated copy</div>`;
		wtBtn.addEventListener("click", () => void showWorktreeForm(cwd));
		sessionsList.appendChild(wtBtn);
	}

	async function showWorktreeForm(cwd) {
		viewMode = "picker";
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "New Worktree";

		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => void showWorktreeChoice(cwd));
		sessionsList.appendChild(backBtn);

		const form = document.createElement("div");
		form.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:10px;";

		const nameLabel = document.createElement("label");
		nameLabel.className = "agent-launcher-label";
		nameLabel.textContent = "Worktree name";
		const nameInput = document.createElement("input");
		nameInput.className = "sessions-search";
		nameInput.type = "text";
		nameInput.placeholder = "e.g. fix-auth";
		nameInput.value = `wt-${Date.now().toString(36)}`;
		nameLabel.appendChild(nameInput);
		form.appendChild(nameLabel);

		const branchLabel = document.createElement("label");
		branchLabel.className = "agent-launcher-label";
		branchLabel.textContent = "Base branch";
		const branchSelect = document.createElement("select");
		branchSelect.className = "sessions-search";
		const headOption = document.createElement("option");
		headOption.value = "HEAD";
		headOption.textContent = "HEAD (current)";
		branchSelect.appendChild(headOption);
		branchLabel.appendChild(branchSelect);
		form.appendChild(branchLabel);

		// Load branches async
		api.getJson(`/api/worktree/branches?repo=${encodeURIComponent(cwd)}`).then((data) => {
			const branches = Array.isArray(data?.branches) ? data.branches : [];
			for (const branch of branches) {
				const opt = document.createElement("option");
				opt.value = branch;
				opt.textContent = branch;
				branchSelect.appendChild(opt);
			}
		}).catch(() => {});

		const createBtn = document.createElement("button");
		createBtn.className = "new-btn";
		createBtn.style.cssText = "background:#1e2a20;border-color:#2a3a2a;color:#b5bd68;padding:10px 14px;font-weight:600;justify-content:center;";
		createBtn.textContent = "Create Worktree";
		createBtn.addEventListener("click", async () => {
			const name = nameInput.value.trim();
			if (!name) { onNotice("Name cannot be empty", "error"); return; }
			createBtn.disabled = true;
			createBtn.textContent = "Creating…";
			try {
				const result = await api.postJson("/api/worktree/create", {
					repoPath: cwd,
					name,
					baseBranch: branchSelect.value === "HEAD" ? undefined : branchSelect.value,
					clientId,
				});
				viewMode = "sessions";
				onSessionIdSelected(result.sessionId);
				setOpen(false);
			} catch (err) {
				createBtn.disabled = false;
				createBtn.textContent = "Create Worktree";
				onNotice(err instanceof Error ? err.message : String(err), "error");
			}
		});
		form.appendChild(createBtn);

		nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); createBtn.click(); }
		});

		sessionsList.appendChild(form);
		setTimeout(() => {
			nameInput.focus();
			nameInput.select();
		}, 0);
	}

	function renderWorktreeSection(worktrees) {
		if (!Array.isArray(worktrees) || worktrees.length === 0) return;

		const sectionHdr = document.createElement("div");
		sectionHdr.className = "sidebar-wt-section-hdr";
		sectionHdr.textContent = "Worktrees";
		sessionsList.appendChild(sectionHdr);

		// Group by repoName
		const byRepo = new Map();
		for (const wt of worktrees) {
			const key = wt.repoRoot || wt.repoName;
			if (!byRepo.has(key)) byRepo.set(key, { repoName: wt.repoName, repoRoot: wt.repoRoot, items: [] });
			byRepo.get(key).items.push(wt);
		}

		for (const [, group] of byRepo) {
			const repoHdr = document.createElement("div");
			repoHdr.className = "sidebar-wt-repo-hdr";
			repoHdr.textContent = group.repoName;
			sessionsList.appendChild(repoHdr);

			for (const wt of group.items) {
				const row = document.createElement("div");
				row.className = "si si-wt";

				const name = document.createElement("div");
				name.className = "si-name";
				name.textContent = `\ud83c\udf3f ${wt.name}`;
				name.title = wt.path;

				const meta = document.createElement("div");
				meta.className = "si-meta";
				const parts = [];
				if (wt.aheadCount > 0) parts.push(`${wt.aheadCount} commit${wt.aheadCount > 1 ? "s" : ""} ahead`);
				if (wt.hasChanges) parts.push("uncommitted changes");
				if (wt.isRunning) parts.push(`<span class="si-run">running</span>`);
				if (parts.length === 0) parts.push("clean");
				meta.innerHTML = parts.join(" \u00b7 ");

				row.appendChild(name);
				row.appendChild(meta);

				// Merge button
				const mergeBtn = document.createElement("button");
				mergeBtn.className = "si-rename";
				mergeBtn.type = "button";
				mergeBtn.textContent = "\u2934";
				mergeBtn.title = "Merge into main branch";
				mergeBtn.style.right = "74px";
				mergeBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
				mergeBtn.addEventListener("click", async (e) => {
					e.stopPropagation();
					if (!window.confirm(`Merge worktree "${wt.name}" into main branch?`)) return;
					try {
						const result = await api.postJson("/api/worktree/merge", { worktreePath: wt.path });
						onNotice(result.merged ? `Merged: ${result.message}` : `Failed: ${result.message}`, result.merged ? "info" : "error");
						void refresh({ force: true });
					} catch (err) {
						onNotice(err instanceof Error ? err.message : String(err), "error");
					}
				});
				row.appendChild(mergeBtn);

				// Open button
				const openBtn = document.createElement("button");
				openBtn.className = "si-rename";
				openBtn.type = "button";
				openBtn.textContent = "\u25b6";
				openBtn.title = "Open session in this worktree";
				openBtn.style.right = "40px";
				openBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
				openBtn.addEventListener("click", async (e) => {
					e.stopPropagation();
					try {
						const result = await api.postJson("/api/sessions", { clientId, cwd: wt.path });
						onSessionIdSelected(result.sessionId);
						setOpen(false);
					} catch (err) {
						onNotice(err instanceof Error ? err.message : String(err), "error");
					}
				});
				row.appendChild(openBtn);

				// Delete button
				const del = document.createElement("button");
				del.className = "si-del";
				del.type = "button";
				del.textContent = "\u2715";
				del.title = "Delete worktree";
				del.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
				del.addEventListener("click", async (e) => {
					e.stopPropagation();
					if (!window.confirm(`Delete worktree "${wt.name}"? This removes the branch and all uncommitted changes.`)) return;
					try {
						await fetch(`/api/worktree?path=${encodeURIComponent(wt.path)}`, { method: "DELETE", headers: api.headers() });
						void refresh({ force: true });
					} catch (err) {
						onNotice(err instanceof Error ? err.message : String(err), "error");
					}
				});
				row.appendChild(del);

				row.addEventListener("click", async () => {
					try {
						const result = await api.postJson("/api/sessions", { clientId, cwd: wt.path });
						onSessionIdSelected(result.sessionId);
						setOpen(false);
					} catch (err) {
						onNotice(err instanceof Error ? err.message : String(err), "error");
					}
				});

				sessionsList.appendChild(row);
			}
		}
	}

	async function refresh(options = {}) {
		if (viewMode === "picker" && !options.force) return;
		viewMode = "sessions";
		if (sidebarLabel) sidebarLabel.textContent = "Sessions";
		try {
			const [activeData, allData, wtData] = await Promise.all([
				api.getJson("/api/active-sessions"),
				api.getJson("/api/sessions"),
				api.getJson("/api/worktrees").catch(() => ({ worktrees: [] })),
			]);
			const active = Array.isArray(activeData.sessions) ? activeData.sessions : [];
			const all = Array.isArray(allData.sessions) ? allData.sessions : [];

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

			merged.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));

			renderSessionList(merged.slice(0, 50));

			const worktrees = Array.isArray(wtData?.worktrees) ? wtData.worktrees : [];
			renderWorktreeSection(worktrees);
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
