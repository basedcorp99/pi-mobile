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

function isWorktreePath(cwd) {
	return typeof cwd === "string" && /\/.worktrees\/worktree-/.test(cwd);
}

function fuzzyMatchSession(query, hay) {
	if (!query) return true;
	const q = query.toLowerCase();
	const h = hay.toLowerCase();
	// Exact substring match
	if (h.includes(q)) return true;
	// Token match: all query tokens must appear somewhere
	const tokens = q.split(/\s+/).filter(Boolean);
	if (tokens.length > 1 && tokens.every((t) => h.includes(t))) return true;
	// Fuzzy char match: all query chars appear in order
	let qi = 0;
	for (let i = 0; i < h.length && qi < q.length; i++) {
		if (h[i] === q[qi]) qi++;
	}
	return qi === q.length;
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

		// Extra warning for worktree sessions with uncommitted/unmerged work
		if (isWorktreePath(session.cwd)) {
			const wtName = extractWorktreeName(session.cwd) || session.cwd;
			const msg = `Delete worktree "${wtName}"?\n\nThis will remove the git worktree, its branch, and all uncommitted changes. Unmerged commits will be lost.\n\nAre you sure?`;
			if (!window.confirm(msg)) {
				if (activeDeleteButton === button) activeDeleteButton = null;
				resetDeleteButton(button);
				return;
			}
		}

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
			// If this is a worktree session, also delete the git worktree + branch
			if (isWorktreePath(session.cwd)) {
				try {
					await fetch(`/api/worktree?path=${encodeURIComponent(session.cwd)}`, { method: "DELETE", headers: api.headers() });
				} catch { /* best effort */ }
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
		document.body?.classList?.toggle("sidebar-open", isOpen);
	}

	function toggleOpen() { setOpen(!isOpen); }

	function highlightSessionRow(sessionId) {
		sessionsList.querySelectorAll(".si").forEach((row) => {
			row.classList.toggle("active", row.dataset.sessionId === sessionId);
		});
	}

	function extractWorktreeName(cwd) {
		const match = String(cwd || "").match(/\/\.worktrees\/worktree-(.+)$/);
		return match ? match[1] : null;
	}

	function renderSessionRow(s) {
		const isWt = isWorktreePath(s.cwd);
		const wtName = isWt ? extractWorktreeName(s.cwd) : null;

		const row = document.createElement("div");
		row.className = `si${isWt ? " si-wt" : ""}${s.id === getActiveSessionId() ? " active" : ""}`;
		row.dataset.sessionId = s.id;

		const stopRowTap = (e) => {
			e.preventDefault();
			e.stopPropagation();
		};

		const sessionLabel = (typeof s.name === "string" && s.name.trim())
			|| (typeof s.firstMessage === "string" && s.firstMessage.trim())
			|| s.id.slice(0, 8);
		const label = isWt
			? `\ud83c\udf3f ${wtName || sessionLabel}`
			: String(sessionLabel).replace(/\s+/g, " ").trim().slice(0, 60);

		const name = document.createElement("div");
		name.className = "si-name";
		name.textContent = label;
		name.title = isWt ? `${wtName} — ${String(sessionLabel).slice(0, 60)}` : label;

		const meta = document.createElement("div");
		meta.className = "si-meta";
		const rel = formatRelativeTime(s.modified);
		const dir = shortPath(s.cwd);
		meta.innerHTML = `${rel}${dir ? ` \u00b7 ${dir}` : ""}${s.isRunning ? ` \u00b7 <span class="si-run">running</span>` : ""}`;

		row.appendChild(name);
		row.appendChild(meta);

		// Worktree-specific: merge button
		if (isWt) {
			const mergeBtn = document.createElement("button");
			mergeBtn.className = "si-rename";
			mergeBtn.type = "button";
			mergeBtn.textContent = "\u2934";
			mergeBtn.title = `Merge branch worktree-${wtName} into the main branch (like cwm ${wtName})`;
			mergeBtn.style.right = "74px";
			mergeBtn.addEventListener("pointerdown", (e) => { stopRowTap(e); });
			mergeBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (!window.confirm(`Merge branch \"worktree-${wtName}\" into the repo's current branch?\n\n\u2022 If there are uncommitted changes, they will be auto-committed first\n\u2022 If the worktree has no new commits, git will say \"Already up to date\"\n\nLike running: cwm ${wtName}`)) return;
				try {
					const result = await api.postJson("/api/worktree/merge", { worktreePath: s.cwd });
					if (result.merged) {
						onNotice(`\u2705 Merged worktree-${wtName} into main branch. ${result.message}`, "info");
					} else {
						onNotice(`\u274c Merge failed for worktree-${wtName}. ${result.message}`, "error");
					}
					void refresh({ force: true });
				} catch (err) {
					onNotice(err instanceof Error ? err.message : String(err), "error");
				}
			});
			row.appendChild(mergeBtn);
		}

		const rename = document.createElement("button");
		rename.className = "si-rename";
		rename.type = "button";
		rename.textContent = "\u270e";
		rename.title = "Rename session";
		rename.setAttribute("aria-label", rename.title);
		rename.addEventListener("pointerdown", (e) => { stopRowTap(e); if (e.button !== 0) return; void renameSessionRow(s); });
		rename.addEventListener("click", stopRowTap);
		row.appendChild(rename);

		const del = document.createElement("button");
		del.className = "si-del";
		del.type = "button";
		del.textContent = "\u2715";
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
		del.addEventListener("pointerdown", (e) => { stopRowTap(e); if (e.button !== 0) return; handleDeleteTap(); });
		del.addEventListener("click", stopRowTap);
		del.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { stopRowTap(e); handleDeleteTap(); } });
		row.appendChild(del);

		row.addEventListener("click", () => {
			highlightSessionRow(s.id);
			void onSelectSession(s);
		});

		return row;
	}

	function renderSessionList(sessions) {
		lastFetchedSessions = Array.isArray(sessions) ? sessions.slice() : [];
		const query = sessionSearchQuery.trim().toLowerCase();
		const allFiltered = query
			? lastFetchedSessions.filter((s) => {
				const hay = [s?.name || "", s?.firstMessage || "", s?.cwd || "", s?.id || ""].join(" ");
				return fuzzyMatchSession(query, hay);
			})
			: lastFetchedSessions.slice();

		const normalSessions = allFiltered.filter((s) => !isWorktreePath(s.cwd));
		const worktreeSessions = allFiltered.filter((s) => isWorktreePath(s.cwd));
		lastRenderedSessions = allFiltered.slice();
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

		if (normalSessions.length === 0 && worktreeSessions.length === 0) {
			const empty = document.createElement("div");
			empty.className = "si";
			empty.innerHTML = `<div class="si-meta" style="padding:12px 0">${query ? "No matching sessions" : "No sessions yet"}</div>`;
			sessionsList.appendChild(empty);
			return;
		}

		// Group normal sessions by cwd
		if (normalSessions.length > 0) {
			const byDir = new Map();
			for (const s of normalSessions) {
				const dir = s.cwd || "unknown";
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir).push(s);
			}

			const sortedDirs = [...byDir.keys()].sort((a, b) => shortPath(a).localeCompare(shortPath(b)));
			for (const dir of sortedDirs) {
				const sessions = byDir.get(dir);
				const hdr = document.createElement("div");
				hdr.className = "sidebar-group-hdr";
				hdr.textContent = shortPath(dir);
				sessionsList.appendChild(hdr);
				for (const s of sessions) sessionsList.appendChild(renderSessionRow(s));
			}
		}

		// Group worktree sessions by repo
		if (worktreeSessions.length > 0) {
			const sectionHdr = document.createElement("div");
			sectionHdr.className = "sidebar-section-hdr";
			sectionHdr.textContent = "Worktrees";
			sessionsList.appendChild(sectionHdr);

			const byRepo = new Map();
			for (const s of worktreeSessions) {
				const match = String(s.cwd || "").match(/^(.+)\/\.worktrees\//);
				const repoRoot = match ? match[1] : "unknown";
				if (!byRepo.has(repoRoot)) byRepo.set(repoRoot, []);
				byRepo.get(repoRoot).push(s);
			}

			const sortedRepos = [...byRepo.keys()].sort((a, b) => shortPath(a).localeCompare(shortPath(b)));
			for (const repoRoot of sortedRepos) {
				const sessions = byRepo.get(repoRoot);
				const hdr = document.createElement("div");
				hdr.className = "sidebar-group-hdr";
				hdr.textContent = shortPath(repoRoot);
				sessionsList.appendChild(hdr);
				for (const s of sessions) sessionsList.appendChild(renderSessionRow(s));
			}
		}
	}

	async function showNewSessionPicker() {
		viewMode = "picker";
		let currentResults = [];
		let recentDirs = [];

		// Fetch recent/known repos in background (non-blocking)
		const reposPromise = api.getJson("/api/repos").then((data) => {
			recentDirs = Array.isArray(data.repos) ? data.repos : [];
			return recentDirs;
		}).catch(() => []);

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
		pathInput.placeholder = "Type to search any folder on the server…";
		pathInput.autocomplete = "off";
		pathInput.spellcheck = false;

		// Container for folder results
		const resultsContainer = document.createElement("div");
		resultsContainer.id = "new-session-results";

		let searchTimer = null;
		let searchSeq = 0;
		let isSearching = false;

		const filterDirsLocally = (query, pool) => {
			const q = String(query || "").trim().toLowerCase();
			if (!q) return pool.slice();
			const tokens = q.split(/[\s/_-]+/).filter(Boolean);
			return pool
				.map((dir) => {
					const lower = String(dir || "").toLowerCase();
					const base = lower.split("/").pop() || lower;
					let score = 0;
					if (base === q) score += 2000;
					else if (base.startsWith(q)) score += 1200;
					else if (base.includes(q)) score += 900;
					else if (lower.includes(q)) score += 500;
					if (tokens.length > 1 && tokens.every((t) => lower.includes(t))) score += 400;
					if (score <= 0) {
						const compactQ = q.replace(/[^a-z0-9]+/g, "");
						const compactB = base.replace(/[^a-z0-9]+/g, "");
						if (compactQ && compactB.includes(compactQ)) score += 700;
					}
					return { dir, score };
				})
				.filter((entry) => entry.score > 0)
				.sort((a, b) => b.score - a.score)
				.map((entry) => entry.dir);
		};

		const renderFolderList = (dirs, emptyMessage) => {
			currentResults = Array.isArray(dirs) ? dirs.slice() : [];
			resultsContainer.innerHTML = "";
			if (dirs.length === 0) {
				const hint = document.createElement("div");
				hint.className = "si";
				const meta = document.createElement("div");
				meta.className = "si-meta new-session-empty";
				meta.textContent = emptyMessage || "No matching folders.";
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

		const showSearching = () => {
			if (!isSearching) return;
			const existing = resultsContainer.querySelector(".new-session-searching");
			if (existing) return;
			const hint = document.createElement("div");
			hint.className = "si new-session-searching";
			const meta = document.createElement("div");
			meta.className = "si-meta new-session-empty";
			meta.textContent = "Searching…";
			hint.appendChild(meta);
			resultsContainer.appendChild(hint);
		};

		const doRemoteSearch = async (val, seq) => {
			try {
				isSearching = true;
				if (currentResults.length === 0) showSearching();
				const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
				if (seq !== searchSeq || pathInput.value.trim() !== val) return;
				const dirs = Array.isArray(data.dirs) ? data.dirs : [];
				isSearching = false;
				if (dirs.length > 0) {
					renderFolderList(dirs);
				} else if (currentResults.length === 0) {
					renderFolderList([], "No matching folders on this server.");
				}
			} catch {
				isSearching = false;
				if (seq !== searchSeq || pathInput.value.trim() !== val) return;
				if (currentResults.length === 0) {
					renderFolderList(filterDirsLocally(val, recentDirs), "No matching folders.");
				}
			}
		};

		pathInput.addEventListener("input", () => {
			const val = pathInput.value.trim();
			if (searchTimer) clearTimeout(searchTimer);
			if (!val) {
				if (recentDirs.length > 0) {
					renderFolderList(recentDirs);
				} else {
					renderFolderList([], "Type to search any folder on the server.");
				}
				return;
			}
			// Immediate local filter for snappy feedback
			const localHits = filterDirsLocally(val, recentDirs);
			if (localHits.length > 0) renderFolderList(localHits);
			else renderFolderList([], "Searching…");

			// Fire remote search quickly (150ms debounce)
			const seq = ++searchSeq;
			searchTimer = setTimeout(() => void doRemoteSearch(val, seq), 150);
		});

		pathInput.addEventListener("keydown", async (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const val = pathInput.value.trim();
			if (!val) {
				void startInDir("/root");
				return;
			}
			// Use first visible result if available
			if (currentResults.length > 0) {
				void startInDir(currentResults[0]);
				return;
			}
			const looksLikePath = val.startsWith("/") || val.startsWith("~/") || val === "~" || val.startsWith("./") || val.startsWith("../");
			if (looksLikePath) {
				void startInDir(val);
				return;
			}
			// Last resort: fire a remote search and use first result
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

		// Show initial state: loading recent dirs, then show them or hint
		renderFolderList([], "Loading…");
		reposPromise.then((repos) => {
			if (pathInput.value.trim()) return; // user already typing
			if (repos.length > 0) renderFolderList(repos);
			else renderFolderList([], "Type to search any folder on the server.");
		});
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
			const result = await api.postJson("/api/sessions", { clientId, cwd: cwd.trim(), forceNew: true });
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


	async function refresh(options = {}) {
		if (viewMode === "picker" && !options.force) return;
		viewMode = "sessions";
		if (sidebarLabel) sidebarLabel.textContent = "Sessions";
		try {
			const [activeData, allData] = await Promise.all([
				api.getJson("/api/active-sessions"),
				api.getJson("/api/sessions"),
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
		isOpen: () => isOpen,
		isPickerOpen: () => viewMode === "picker",
		setMode: () => {}, // compat
		updateHeader: () => {}, // compat
	};
}
