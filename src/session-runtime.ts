import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	ApiAskQuestion,
	ApiCommandRequest,
	ApiCreateSessionRequest,
	ApiModelInfo,
	ApiSessionCommand,
	ApiSessionState,
	ApiSessionSummary,
	ClientRole,
	ApiSessionPatch,
	SseEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Worktree isolation guardrails
// ---------------------------------------------------------------------------

const WORKTREE_CWD_RE = /\/\.worktrees\/worktree-([^/]+)$/;

function parseWorktreeInfo(cwd: string): { name: string; branch: string; repoRoot: string } | null {
	const match = cwd.match(WORKTREE_CWD_RE);
	if (!match) return null;
	const name = match[1];
	const branch = `worktree-${name}`;
	const repoRoot = cwd.replace(/\/\.worktrees\/worktree-[^/]+$/, "");
	return { name, branch, repoRoot };
}

const WORKTREE_GUARDRAILS = `
## ⚠️ Worktree isolation rules

You are running inside a **git worktree**, an isolated branch meant for a single task.

### Hard constraints

1. **Stay on your branch.** Do NOT checkout, merge into, push to, or modify \`main\` or any other branch. Commit only to your current worktree branch. Only touch other branches if the user explicitly asks you to.
2. **Stay in your directory.** Do NOT read, write, or execute anything outside this worktree's directory tree. Other worktrees under \`.worktrees/\` are off-limits. Only access other worktrees if the user explicitly asks you to.
3. **No live-service operations.** Do NOT run \`systemctl restart\`, \`systemctl stop\`, \`systemctl start\`, or any command that affects running services, databases, reverse proxies, or DNS. Do NOT deploy, publish, or push to production. Only perform service operations if the user explicitly asks you to.
4. **No destructive git operations.** Do NOT \`git push\`, \`git push --force\`, \`git branch -D\`, or \`git worktree remove\` on anything. Only perform these if the user explicitly asks you to.

If the user explicitly asks you to do any of the above, comply — but reconfirm first with a brief warning that it affects resources outside this worktree.

When your work is done, just commit to your branch. Merging into main is handled externally.
`.trim();

function buildWorktreeResourceLoader(cwd: string): DefaultResourceLoader | null {
	const info = parseWorktreeInfo(cwd);
	if (!info) return null;

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		appendSystemPromptOverride: (base: string[]) => [
			...base,
			`You are on branch \`${info.branch}\` in worktree \`${info.name}\` (repo root: \`${info.repoRoot}\`).\n\n${WORKTREE_GUARDRAILS}`,
		],
	});
	return loader;
}

async function createSessionWithWorktreeGuard(opts: {
	cwd: string;
	sessionManager: InstanceType<typeof SessionManager>;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}) {
	const loader = buildWorktreeResourceLoader(opts.cwd);
	if (loader) await loader.reload();
	return createAgentSession({
		...opts,
		...(loader ? { resourceLoader: loader } : {}),
	});
}

// ---------------------------------------------------------------------------

export interface SessionClient {
	connectionId: string;
	clientId: string;
	connectedAtMs: number;
	send(event: SseEvent): void;
	close(): void;
}

export interface SessionNotification {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	messageRole: string;
	messageText: string;
}

export interface PiWebRuntimeOptions {
	onMessageNotification?: (payload: SessionNotification) => void | Promise<void>;
}

interface RunningSession {
	session: AgentSession;
	cwd: string;
	sessionFile: string | null;
	createdAtMs: number;
	modifiedAtMs: number;
	controllerClientId: string | null;
	clients: Map<string, SessionClient>;
	unsubscribe: (() => void) | null;
	lastAssistantMessageText: string;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("");
}

function computeFirstMessage(messages: AgentSession["messages"]): string {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "user") continue;
		const text = extractTextContent((message as { content?: unknown }).content);
		if (text.trim().length > 0) return text;
	}
	return "(no messages)";
}

function extractLastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		const text = extractTextContent((message as { content?: unknown }).content).trim();
		if (text) return text;
	}
	return "";
}

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function safeModelSnapshot(session: AgentSession): ApiSessionState["model"] {
	const model = session.model;
	if (!model) return null;
	const name = typeof (model as { name?: unknown }).name === "string" ? (model as { name: string }).name : undefined;
	return { provider: model.provider, id: model.id, name };
}

function safeContextUsageSnapshot(session: AgentSession): ApiSessionState["contextUsage"] {
	try {
		const usage = session.getContextUsage();
		if (!usage) return null;
		return {
			tokens: typeof usage.tokens === "number" ? usage.tokens : null,
			contextWindow: usage.contextWindow,
			percent: typeof usage.percent === "number" ? usage.percent : null,
		};
	} catch {
		return null;
	}
}

function safeStatsSnapshot(session: AgentSession): ApiSessionState["stats"] {
	try {
		const stats = session.getSessionStats();
		return { tokens: stats.tokens, cost: stats.cost };
	} catch {
		return null;
	}
}

// Only include built-in commands that actually work in pi-mobile (SDK/headless mode).
// Commands like /login, /model, /tree, /fork etc. are TUI-only (handled by interactive-mode)
// and would fall through to the LLM if sent as prompts.
const BUILTIN_COMMANDS: ApiSessionCommand[] = [
	{ name: "compact", description: "Compact conversation history", source: "extension" },
];

function safeCommandsSnapshot(session: AgentSession): ApiSessionCommand[] {
	try {
		const result: ApiSessionCommand[] = [];
		const seen = new Set<string>();

		// 1. Extension commands via private _extensionRunner
		const runner = (session as any)._extensionRunner;
		if (runner && typeof runner.getRegisteredCommands === "function") {
			const cmds = runner.getRegisteredCommands();
			if (Array.isArray(cmds)) {
				for (const cmd of cmds) {
					const name = typeof cmd?.invocationName === "string" ? cmd.invocationName.trim()
						: typeof cmd?.name === "string" ? cmd.name.trim() : "";
					if (!name || seen.has(name)) continue;
					seen.add(name);
					result.push({
						name,
						description: typeof cmd?.description === "string" ? cmd.description.trim() || undefined : undefined,
						source: "extension",
						executeImmediately: Boolean((cmd as { executeImmediately?: unknown })?.executeImmediately),
					});
				}
			}
		}

		// 2. Prompt templates (public getter)
		const templates = session.promptTemplates;
		if (Array.isArray(templates)) {
			for (const tpl of templates) {
				const name = typeof (tpl as any)?.name === "string" ? (tpl as any).name.trim() : "";
				if (!name || seen.has(name)) continue;
				seen.add(name);
				result.push({
					name,
					description: typeof (tpl as any)?.description === "string" ? (tpl as any).description.trim() || undefined : undefined,
					source: "prompt",
				});
			}
		}

		// 3. Skills via private _resourceLoader
		const resourceLoader = (session as any)._resourceLoader;
		if (resourceLoader && typeof resourceLoader.getSkills === "function") {
			const skillsResult = resourceLoader.getSkills();
			const skills = Array.isArray(skillsResult?.skills) ? skillsResult.skills : [];
			for (const skill of skills) {
				const name = typeof skill?.name === "string" ? skill.name.trim() : "";
				if (!name) continue;
				const fullName = `skill:${name}`;
				if (seen.has(fullName)) continue;
				seen.add(fullName);
				result.push({
					name: fullName,
					description: typeof skill?.description === "string" ? skill.description.trim() || undefined : undefined,
					source: "skill",
				});
			}
		}

		// 4. Built-in pi commands
		for (const cmd of BUILTIN_COMMANDS) {
			if (!seen.has(cmd.name)) {
				seen.add(cmd.name);
				result.push(cmd);
			}
		}

		return result;
	} catch {
		return [];
	}
}

function buildState(session: AgentSession, cwd: string): ApiSessionState {
	return {
		sessionId: session.sessionId,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		messages: session.messages,
		commands: safeCommandsSnapshot(session),
	};
}

function buildPatch(session: AgentSession): ApiSessionPatch {
	return {
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		sessionName: session.sessionName,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		commands: safeCommandsSnapshot(session),
	};
}

async function ensureDirectory(path: string): Promise<void> {
	let info: { isDirectory(): boolean };
	try {
		info = await stat(path);
	} catch {
		throw new Error(`cwd does not exist: ${path}`);
	}
	if (!info.isDirectory()) {
		throw new Error(`cwd is not a directory: ${path}`);
	}
}

function normalizeCwd(input: string): string {
	return resolve(input.trim());
}

function serializeSessionSummary(entry: {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage?: string;
}): ApiSessionSummary {
	return {
		id: entry.id,
		path: entry.path,
		cwd: entry.cwd,
		name: entry.name,
		firstMessage: entry.firstMessage ?? "(no messages)",
		created: entry.created.toISOString(),
		modified: entry.modified.toISOString(),
		messageCount: entry.messageCount,
		isRunning: false,
	};
}

interface PendingAsk {
	resolve: (value: { cancelled?: boolean; selections: Array<{ selectedOptions: string[]; customInput?: string }> }) => void;
	sessionId: string;
	questions: ApiAskQuestion[];
}

type PendingUiPromptEvent = Extract<SseEvent, { type: "ui_select" | "ui_input" | "ui_confirm" }>;

interface PendingUiPrompt {
	resolve: (value: string | undefined) => void;
	sessionId: string;
	event: PendingUiPromptEvent;
}

export class PiWebRuntime {
	private runningById = new Map<string, RunningSession>();
	private runningByPath = new Map<string, string>();
	private onMessageNotification?: (payload: SessionNotification) => void | Promise<void>;
	private pendingAsks = new Map<string, PendingAsk>();
	private pendingUiPrompts = new Map<string, PendingUiPrompt>();

	constructor(options: PiWebRuntimeOptions = {}) {
		this.onMessageNotification = options.onMessageNotification;
		this.installAskAdapter();
	}

	private installAskAdapter(): void {
		// jiti sandboxes globalThis so __piTelegramAskAdapter doesn't work.
		// Instead we wrap the ask tool's execute after each session is created.
	}

	private getClientConnections(runtime: RunningSession, clientId: string): SessionClient[] {
		return [...runtime.clients.values()]
			.filter((client) => client.clientId === clientId)
			.sort((a, b) => b.connectedAtMs - a.connectedAtMs);
	}

	private getPreferredClientConnection(runtime: RunningSession, clientId: string): SessionClient | null {
		return this.getClientConnections(runtime, clientId)[0] ?? null;
	}

	private sendToConnection(sessionId: string, connectionId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return false;
		const client = runtime.clients.get(connectionId);
		if (!client) return false;
		try {
			client.send(event);
			return true;
		} catch {
			return false;
		}
	}

	private sendToClient(sessionId: string, clientId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return false;
		for (const client of this.getClientConnections(runtime, clientId)) {
			if (this.sendToConnection(sessionId, client.connectionId, event)) return true;
		}
		return false;
	}

	private sendToController(sessionId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime?.controllerClientId) return false;
		return this.sendToClient(sessionId, runtime.controllerClientId, event);
	}

	replayPendingDialogs(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		const client = runtime.clients.get(connectionId);
		if (!client) return;
		if (runtime.controllerClientId !== client.clientId) return;

		for (const [askId, pending] of this.pendingAsks.entries()) {
			if (pending.sessionId !== sessionId) continue;
			this.sendToConnection(sessionId, connectionId, {
				type: "ask_request",
				askId,
				questions: pending.questions,
			});
		}

		for (const pending of this.pendingUiPrompts.values()) {
			if (pending.sessionId !== sessionId) continue;
			this.sendToConnection(sessionId, connectionId, pending.event);
		}
	}

	private replayPendingDialogsToController(sessionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime?.controllerClientId) return;
		const client = this.getPreferredClientConnection(runtime, runtime.controllerClientId);
		if (!client) return;
		this.replayPendingDialogs(sessionId, client.connectionId);
	}

	private wrapAskTool(session: AgentSession, sessionId: string): void {
		const runner = (session as any)._extensionRunner;
		if (!runner) return;

		// Find the ask tool and wrap its execute
		for (const ext of (runner as any).extensions ?? []) {
			const askTool = ext.tools?.get?.("ask");
			if (!askTool?.definition?.execute) continue;

			const originalExecute = askTool.definition.execute;
			const self = this;
			askTool.definition.execute = async function (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
				if (params?.questions?.length > 0) {
					const askId = randomUUID();
					const questions: ApiAskQuestion[] = Array.isArray(params.questions)
						? params.questions.map((q: any) => ({
							id: typeof q?.id === "string" ? q.id : "",
							question: typeof q?.question === "string" ? q.question : "",
							...(typeof q?.description === "string" && q.description.trim() ? { description: q.description } : {}),
							options: Array.isArray(q?.options)
								? q.options
									.map((o: any) => ({ label: typeof o?.label === "string" ? o.label : String(o?.label ?? "") }))
									.filter((o: { label: string }) => o.label.length > 0)
								: [],
							...(typeof q?.multi === "boolean" ? { multi: q.multi } : {}),
							...(typeof q?.recommended === "number" && Number.isFinite(q.recommended) ? { recommended: q.recommended } : {}),
						}))
						: [];

					const result = await new Promise<{ cancelled?: boolean; selections: Array<{ selectedOptions: string[]; customInput?: string }> }>((resolve) => {
						let done = false;
						let timeout: ReturnType<typeof setTimeout> | null = null;
						const onAbort = () => finish({ cancelled: true, selections: [] });
						const finish = (value: { cancelled?: boolean; selections: Array<{ selectedOptions: string[]; customInput?: string }> }) => {
							if (done) return;
							done = true;
							self.pendingAsks.delete(askId);
							if (timeout) clearTimeout(timeout);
							if (signal && typeof signal.removeEventListener === "function") {
								signal.removeEventListener("abort", onAbort);
							}
							resolve(value);
						};
						self.pendingAsks.set(askId, { resolve: finish, sessionId, questions });
						self.sendToController(sessionId, { type: "ask_request", askId, questions });
						timeout = setTimeout(() => finish({ cancelled: true, selections: [] }), 5 * 60 * 1000);
						if (signal?.aborted) finish({ cancelled: true, selections: [] });
						else if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
					});

					const results = questions.map((q: any, i: number) => {
						const sel = result.selections[i] ?? { selectedOptions: [] };
						return {
							id: q.id,
							question: q.question,
							...(q.description?.trim() ? { description: q.description } : {}),
							options: q.options.map((o: any) => o.label),
							multi: q.multi ?? false,
							selectedOptions: result.cancelled ? [] : sel.selectedOptions,
							customInput: sel.customInput,
						};
					});

					const summaryLines = results.map((r: any) => {
						const selected = r.selectedOptions.length > 0
							? (r.multi ? `[${r.selectedOptions.join(", ")}]` : r.selectedOptions[0])
							: r.customInput ? `"${r.customInput}"` : "(cancelled)";
						return `${r.id}: ${selected}`;
					}).join("\n");

					return {
						content: [{ type: "text", text: `User answers:\n${summaryLines}` }],
						details: questions.length === 1 ? results[0] : { results },
					};
				}

				return originalExecute.call(this, toolCallId, params, signal, onUpdate, ctx);
			};
			break;
		}
	}

	resolveAsk(sessionId: string, askId: string, cancelled: boolean, selections: Array<{ selectedOptions: string[]; customInput?: string }>): void {
		const pending = this.pendingAsks.get(askId);
		if (!pending || pending.sessionId !== sessionId) return;
		this.pendingAsks.delete(askId);
		pending.resolve({ cancelled, selections });
	}

	resolveUiPrompt(sessionId: string, uiId: string, cancelled: boolean, value?: string): void {
		const pending = this.pendingUiPrompts.get(uiId);
		if (!pending || pending.sessionId !== sessionId) return;
		this.pendingUiPrompts.delete(uiId);
		pending.resolve(cancelled ? undefined : value);
	}

	private cancelPendingDialogsForSession(sessionId: string): void {
		for (const [askId, pending] of this.pendingAsks.entries()) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingAsks.delete(askId);
			pending.resolve({ cancelled: true, selections: [] });
		}
		for (const [uiId, pending] of this.pendingUiPrompts.entries()) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingUiPrompts.delete(uiId);
			pending.resolve(undefined);
		}
	}

	private createWebUIContext(sessionId: string): any {
		const self = this;
		return {
			async select(title: string, options: string[]): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_select", uiId, title, options };
				return new Promise<string | undefined>((resolve) => {
					self.pendingUiPrompts.set(uiId, { resolve, sessionId, event });
					self.sendToController(sessionId, event);
					setTimeout(() => {
						if (self.pendingUiPrompts.has(uiId)) {
							self.pendingUiPrompts.delete(uiId);
							resolve(undefined);
						}
					}, 5 * 60 * 1000);
				});
			},
			async confirm(title: string, message: string): Promise<boolean> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_confirm", uiId, title, message };
				const result = await new Promise<string | undefined>((resolve) => {
					self.pendingUiPrompts.set(uiId, { resolve, sessionId, event });
					self.sendToController(sessionId, event);
					setTimeout(() => {
						if (self.pendingUiPrompts.has(uiId)) {
							self.pendingUiPrompts.delete(uiId);
							resolve(undefined);
						}
					}, 5 * 60 * 1000);
				});
				return result === "true";
			},
			async input(title: string, placeholder?: string): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_input", uiId, title, placeholder };
				return new Promise<string | undefined>((resolve) => {
					self.pendingUiPrompts.set(uiId, { resolve, sessionId, event });
					self.sendToController(sessionId, event);
					setTimeout(() => {
						if (self.pendingUiPrompts.has(uiId)) {
							self.pendingUiPrompts.delete(uiId);
							resolve(undefined);
						}
					}, 5 * 60 * 1000);
				});
			},
			notify(message: string, type?: "info" | "warning" | "error") {
				self.broadcast(sessionId, { type: "ui_notify", message, level: type ?? "info" });
			},
			onTerminalInput: () => () => {},
			setStatus() {},
			setWorkingMessage() {},
			setHiddenThinkingLabel() {},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setTitle() {},
			async editor(title: string, defaultValue?: string): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_input", uiId, title, placeholder: defaultValue };
				return new Promise<string | undefined>((resolve) => {
					self.pendingUiPrompts.set(uiId, { resolve, sessionId, event });
					self.sendToController(sessionId, event);
					setTimeout(() => {
						if (self.pendingUiPrompts.has(uiId)) {
							self.pendingUiPrompts.delete(uiId);
							resolve(undefined);
						}
					}, 5 * 60 * 1000);
				});
			},
			async custom() {
				self.broadcast(sessionId, {
					type: "ui_notify",
					message: "This command needs a custom TUI/overlay, which pi-mobile does not support yet.",
					level: "warning",
				});
				return undefined;
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText: () => "",
			async editor() { return undefined; },
			setEditorComponent() {},
			get theme(): any { return undefined; },
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded() {},
		};
	}

	private authStorage = AuthStorage.create();
	private modelRegistry = ModelRegistry.create(this.authStorage);
	private repoStorePath = join(homedir(), ".pi", "agent", "pi-web", "repos.json");

	private async loadReposFromDisk(): Promise<string[]> {
		try {
			const raw = await readFile(this.repoStorePath, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async saveReposToDisk(repos: string[]): Promise<void> {
		const dir = dirname(this.repoStorePath);
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify(repos, null, 2);
		await writeFile(this.repoStorePath, payload, "utf8");
	}

	async listRepos(): Promise<string[]> {
		const repos = new Set<string>();

		for (const repo of await this.loadReposFromDisk()) {
			repos.add(repo);
		}

		const saved = await SessionManager.listAll().catch(() => []);
		for (const entry of saved) {
			if (typeof entry.cwd === "string" && entry.cwd.trim()) {
				repos.add(entry.cwd.trim());
			}
		}

		for (const runtime of this.runningById.values()) {
			if (runtime.cwd.trim()) repos.add(runtime.cwd.trim());
		}

		// Only return directories that exist on this machine
		return [...repos].filter(r => existsSync(r)).sort((a, b) => a.localeCompare(b));
	}

	async addRepo(rawCwd: string): Promise<void> {
		const cwd = normalizeCwd(rawCwd);
		await ensureDirectory(cwd);

		const repos = new Set(await this.loadReposFromDisk());
		repos.add(cwd);
		await this.saveReposToDisk([...repos].sort((a, b) => a.localeCompare(b)));
	}

	listActiveSessions(): ApiSessionSummary[] {
		const sessions: ApiSessionSummary[] = [];
		for (const runtime of this.runningById.values()) {
			sessions.push({
				id: runtime.session.sessionId,
				path: runtime.sessionFile && existsSync(runtime.sessionFile) ? runtime.sessionFile : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(runtime.createdAtMs),
				modified: toIso(runtime.modifiedAtMs),
				messageCount: runtime.session.messages.length,
				isRunning: true,
				isStreaming: runtime.session.isStreaming ?? false,
			});
		}
		sessions.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listSessions(): Promise<ApiSessionSummary[]> {
		const saved = await SessionManager.listAll().catch(() => []);
		const byId = new Map<string, ApiSessionSummary>();

		for (const entry of saved) {
			const summary = serializeSessionSummary(entry);
			summary.isRunning = this.runningByPath.has(entry.path);
			byId.set(summary.id, summary);
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
			// If the saved list already contains this session id, just mark it running and move on.
			const existing = byId.get(sessionId);
			if (existing) {
				existing.isRunning = true;
				existing.modified = toIso(runtime.modifiedAtMs);
				existing.messageCount = runtime.session.messages.length;
				continue;
			}

			// Running session may not have flushed to disk yet (no assistant message).
			const path = runtime.sessionFile;
			const createdAt = runtime.createdAtMs;
			const modifiedAt = runtime.modifiedAtMs;
			byId.set(sessionId, {
				id: sessionId,
				path: path && existsSync(path) ? path : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(createdAt),
				modified: toIso(modifiedAt),
				messageCount: runtime.session.messages.length,
				isRunning: true,
			});
		}

		const sessions = [...byId.values()]
			.filter(s => s.isRunning || existsSync(s.cwd))  // hide sessions from non-existent dirs
			.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listModels(): Promise<ApiModelInfo[]> {
		// Use the session's model registry if available — it includes models
		// registered by extensions via pi.registerProvider().
		// Fall back to the standalone registry for the model picker before any session.
		let registry = this.modelRegistry;
		for (const runtime of this.runningById.values()) {
			if (runtime.session.modelRegistry) {
				registry = runtime.session.modelRegistry;
				break;
			}
		}

		try {
			this.authStorage.reload();
		} catch {}
		try {
			registry.refresh();
		} catch {}

		const available = registry.getAvailable();
		return available.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	}

	getSessionState(sessionId: string): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return buildState(runtime.session, runtime.cwd);
	}

	getSessionRole(sessionId: string, clientId: string): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const controllerClientId = runtime.controllerClientId;
		const role: ClientRole = controllerClientId === clientId ? "controller" : "viewer";
		return { role, controllerClientId };
	}

	addClient(sessionId: string, client: SessionClient): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.clients.set(client.connectionId, client);
		return this.getSessionRole(sessionId, client.clientId);
	}

	removeClient(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.clients.delete(connectionId);
	}

	async startSession(request: ApiCreateSessionRequest): Promise<{ sessionId: string }> {
		const clientId = request.clientId ?? randomUUID();

		if (request.resumeSessionPath) {
			const path = request.resumeSessionPath;
			const existingId = this.runningByPath.get(path);
			if (existingId) {
				const existing = this.runningById.get(existingId);
				if (existing && existing.controllerClientId === null) {
					existing.controllerClientId = clientId;
					this.broadcast(existingId, { type: "controller_changed", controllerClientId: clientId });
				}
				return { sessionId: existingId };
			}

			if (!existsSync(path)) {
				throw new Error(`session file does not exist: ${path}`);
			}

			const sessionManager = SessionManager.open(path);
			const cwd = sessionManager.getCwd();
			const { session } = await createSessionWithWorktreeGuard({
				cwd,
				sessionManager,
				authStorage: this.authStorage,
				modelRegistry: this.modelRegistry,
			});
			const runtime = this.registerSession(session, cwd, clientId);
			await session.bindExtensions({ uiContext: this.createWebUIContext(runtime.session.sessionId) });
			this.wrapAskTool(session, runtime.session.sessionId);
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = request.cwd ?? process.cwd();
		await ensureDirectory(cwd);

		// If there's already a running session in this cwd and forceNew is not set, reuse it
		if (!request.forceNew) {
			for (const [existingId, existing] of this.runningById.entries()) {
				if (existing.cwd === cwd) {
					if (existing.controllerClientId === null) {
						existing.controllerClientId = clientId;
						this.broadcast(existingId, { type: "controller_changed", controllerClientId: clientId });
					}
					return { sessionId: existingId };
				}
			}
		}

		const sessionManager = SessionManager.create(cwd);
		const { session } = await createSessionWithWorktreeGuard({
			cwd,
			sessionManager,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
		});
		const runtime = this.registerSession(session, cwd, clientId);
		await session.bindExtensions({ uiContext: this.createWebUIContext(runtime.session.sessionId) });
		this.wrapAskTool(session, runtime.session.sessionId);
		return { sessionId: runtime.session.sessionId };
	}

	async handleCommand(sessionId: string, command: ApiCommandRequest): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		if (command.type === "abort") {
			this.cancelPendingDialogsForSession(sessionId);
			await runtime.session.abort();
			return;
		}

		if (command.type === "ask_response") {
			this.assertController(runtime, command.clientId);
			const askId = typeof command.askId === "string" ? command.askId.trim() : "";
			if (!askId) throw new Error("missing_ask_id");
			const selections = Array.isArray(command.selections) ? command.selections : [];
			this.resolveAsk(sessionId, askId, Boolean(command.cancelled), selections);
			return;
		}

		if (command.type === "ui_response") {
			this.assertController(runtime, command.clientId);
			const uiId = typeof command.uiId === "string" ? command.uiId.trim() : "";
			if (!uiId) throw new Error("missing_ui_id");
			this.resolveUiPrompt(sessionId, uiId, Boolean(command.cancelled), command.value);
			return;
		}

		if (command.type === "compact") {
			this.assertController(runtime, command.clientId);
			const customInstructions =
				typeof command.customInstructions === "string" && command.customInstructions.trim().length > 0
					? command.customInstructions.trim()
					: undefined;
			await runtime.session.compact(customInstructions);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "bash") {
			this.assertController(runtime, command.clientId);
			const bashCommand = typeof command.command === "string" ? command.command.trim() : "";
			if (!bashCommand) return;
			// session.executeBash uses process.cwd() internally, so wrap with cd to the session's cwd
			const wrappedCommand = `cd ${JSON.stringify(runtime.cwd)} && ${bashCommand}`;
			await runtime.session.executeBash(wrappedCommand, undefined, {
				excludeFromContext: Boolean(command.excludeFromContext),
			});
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "abort_bash") {
			this.assertController(runtime, command.clientId);
			runtime.session.abortBash();
			return;
		}

		if (command.type === "prompt") {
			this.assertController(runtime, command.clientId);
			const text = typeof command.text === "string" ? command.text.trim() : "";
			const images = Array.isArray(command.images)
				? command.images
					.filter((img) => img && typeof img === "object")
					.map((img) => ({
						type: "image" as const,
						data: typeof (img as { data?: unknown }).data === "string" ? (img as { data: string }).data : "",
						mimeType: typeof (img as { mimeType?: unknown }).mimeType === "string" ? (img as { mimeType: string }).mimeType : "",
					}))
					.filter((img) => img.data.length > 0 && img.mimeType.startsWith("image/"))
					.slice(0, 4)
				: [];
			const totalImageChars = images.reduce((sum, img) => sum + img.data.length, 0);
			if (images.some((img) => img.data.length > 6_000_000) || totalImageChars > 12_000_000) {
				throw new Error("image_too_large");
			}
			if (text.length === 0 && images.length === 0) return;

			// Intercept TUI-only built-in commands that would fall through to the LLM
			const TUI_ONLY_COMMANDS = new Set(["model", "login", "logout", "new", "resume", "tree", "fork", "name", "session", "share", "export", "import", "copy", "debug", "reload", "hotkeys", "changelog"]);
			const cmdMatch = text.match(/^\/([a-zA-Z_-]+)/);
			if (cmdMatch && TUI_ONLY_COMMANDS.has(cmdMatch[1].toLowerCase())) {
				// Check if it's actually a registered extension command (takes priority)
				const runner = (runtime.session as any)._extensionRunner;
				const isExtCmd = runner && typeof runner.getCommand === "function" && runner.getCommand(cmdMatch[1].toLowerCase());
				if (!isExtCmd) {
					this.broadcast(sessionId, { type: "ui_notify", message: `/${cmdMatch[1]} is not available in pi-mobile. Use the UI controls instead.`, level: "warning" });
					return;
				}
			}

			const promptOptions = images.length > 0 ? { images } : undefined;
			const wasStreaming = runtime.session.isStreaming;
			await runtime.session.prompt(
				text,
				wasStreaming
					? { ...(promptOptions ?? {}), streamingBehavior: command.deliverAs ?? "steer" }
					: promptOptions,
			);
			// If prompt returned without starting an agent run (e.g. extension
			// commands), broadcast a state patch so the frontend can update.
			if (!runtime.session.isStreaming) {
				this.broadcast(runtime.session.sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			}
			return;
		}

		if (command.type === "set_model") {
			this.assertController(runtime, command.clientId);
			const provider = command.provider.trim();
			const modelId = command.modelId.trim();
			if (!provider || !modelId) throw new Error("invalid_model");

			// Use the session's registry — it has extension-registered providers
			const registry = runtime.session.modelRegistry ?? this.modelRegistry;
			try { this.authStorage.reload(); } catch {}
			try { registry.refresh(); } catch {}

			const available = registry.getAvailable();
			const model = available.find((m) => m.provider === provider && m.id === modelId);
			if (!model) throw new Error(`model_not_available: ${provider}/${modelId}`);
			await runtime.session.setModel(model);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
			if (!allowed.includes(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level as (typeof allowed)[number]);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_steering_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_steering_mode: ${String(mode)}`);
			runtime.session.setSteeringMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_follow_up_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_follow_up_mode: ${String(mode)}`);
			runtime.session.setFollowUpMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		if (command.type === "set_session_name") {
			this.assertController(runtime, command.clientId);
			const name = command.name.trim();
			if (!name) throw new Error("invalid_session_name");
			runtime.session.setSessionName(name);
			this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(runtime.session) });
			return;
		}

		throw new Error(`unknown_command: ${String((command as { type?: unknown }).type)}`);
	}

	takeover(sessionId: string, request: { clientId: string }): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.controllerClientId = request.clientId;
		this.broadcast(sessionId, { type: "controller_changed", controllerClientId: request.clientId });
		this.replayPendingDialogsToController(sessionId);
	}

	async release(sessionId: string, request: { clientId: string }): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.assertController(runtime, request.clientId);

		this.broadcast(sessionId, { type: "released", byClientId: request.clientId });
		this.cancelPendingDialogsForSession(sessionId);

		for (const client of runtime.clients.values()) {
			client.close();
		}

		try {
			await runtime.session.abort();
		} catch {
			// best effort
		}
		try {
			runtime.session.dispose();
		} catch {
			// best effort
		}

		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;

		this.broadcast(sessionId, { type: "released", byClientId: "system" });
		this.cancelPendingDialogsForSession(sessionId);

		for (const client of runtime.clients.values()) {
			client.close();
		}

		try { await runtime.session.abort(); } catch {}
		try { runtime.session.dispose(); } catch {}

		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
	}

	async deleteSession(sessionPath: string): Promise<void> {
		// Stop if running
		const runningId = this.runningByPath.get(sessionPath);
		if (runningId) {
			await this.stopSession(runningId);
		}

		// Delete session file from disk
		const { unlink } = await import("node:fs/promises");
		try {
			await unlink(sessionPath);
		} catch {
			// file might not exist
		}
	}

	private registerSession(session: AgentSession, cwd: string, controllerClientId: string): RunningSession {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile ?? null;

		if (sessionFile) {
			const existingId = this.runningByPath.get(sessionFile);
			if (existingId) {
				throw new Error("session_already_running");
			}
		}

		const createdAtMs = Date.now();
		const runtime: RunningSession = {
			session,
			cwd,
			sessionFile,
			createdAtMs,
			modifiedAtMs: createdAtMs,
			controllerClientId,
			clients: new Map(),
			unsubscribe: null,
			lastAssistantMessageText: "",
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			runtime.modifiedAtMs = Date.now();
			this.broadcast(sessionId, { type: "agent_event", event });

			if (event.type === "agent_start") {
				runtime.lastAssistantMessageText = "";
			}

			if (event.type === "message_end" && (event as any)?.message?.role === "assistant") {
				const messageText = extractTextContent((event as any)?.message?.content).trim();
				if (messageText) {
					runtime.lastAssistantMessageText = messageText;
				}
			}

			if (event.type === "agent_end") {
				const messageText = runtime.lastAssistantMessageText || extractLastAssistantText((event as any)?.messages);
				runtime.lastAssistantMessageText = "";
				if (messageText && this.onMessageNotification) {
					void this.onMessageNotification({
						sessionId,
						sessionName: session.sessionName,
						cwd,
						messageRole: "assistant",
						messageText,
					});
				}
			}

			if (event.type === "agent_end" || event.type === "compaction_end") {
				this.broadcast(sessionId, { type: "state_patch", patch: buildPatch(session) });
			}
		});
		runtime.unsubscribe = unsubscribe;

		this.runningById.set(sessionId, runtime);
		if (sessionFile) {
			this.runningByPath.set(sessionFile, sessionId);
		}

		return runtime;
	}

	private assertController(runtime: RunningSession, clientId: string): void {
		if (runtime.controllerClientId !== clientId) {
			throw new Error("not_controller");
		}
	}

	private broadcast(sessionId: string, event: SseEvent): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		for (const client of runtime.clients.values()) {
			try {
				client.send(event);
			} catch {
				// ignore broken clients
			}
		}
	}

	// ── Worktree management ────────────────────────────────────────

	private async gitExec(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile("git", args, { cwd, timeout: 15_000 }, (err, stdout) => {
				const code = err && typeof (err as any).code === "number" ? (err as any).code : (err ? 1 : 0);
				resolve({ stdout: (stdout || "").trim(), exitCode: code });
			});
		});
	}

	private async getRepoRoot(cwd: string): Promise<string | null> {
		const { stdout: toplevel, exitCode } = await this.gitExec(cwd, ["rev-parse", "--show-toplevel"]);
		if (exitCode !== 0 || !toplevel) return null;
		// --git-common-dir returns the shared .git dir; for worktrees it points to the main repo's .git
		const { stdout: commonDir } = await this.gitExec(toplevel, ["rev-parse", "--git-common-dir"]);
		if (commonDir && commonDir !== ".git") {
			// Resolve to absolute path
			const absCommon = resolve(toplevel, commonDir);
			const mainRoot = resolve(absCommon, "..");
			if (mainRoot !== toplevel && existsSync(mainRoot)) return mainRoot;
		}
		return toplevel;
	}

	private async getCurrentBranch(repoRoot: string): Promise<string> {
		const { stdout } = await this.gitExec(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
		return stdout || "HEAD";
	}

	async listWorktrees(): Promise<Array<{ name: string; path: string; branch: string; repoRoot: string; repoName: string; hasChanges: boolean; aheadCount: number; isRunning: boolean }>> {
		const repos = await this.listRepos();
		const results: Array<{ name: string; path: string; branch: string; repoRoot: string; repoName: string; hasChanges: boolean; aheadCount: number; isRunning: boolean }> = [];

		// Also include cwds from running sessions to catch repos not in the saved list
		const allPaths = new Set(repos);
		for (const runtime of this.runningById.values()) {
			if (runtime.cwd) allPaths.add(runtime.cwd);
		}

		const scannedRoots = new Set<string>();
		for (const repo of allPaths) {
			const repoRoot = await this.getRepoRoot(repo);
			if (!repoRoot || scannedRoots.has(repoRoot)) continue;
			scannedRoots.add(repoRoot);
			const wtDir = join(repoRoot, ".worktrees");
			if (!existsSync(wtDir)) continue;

			const { readdir } = await import("node:fs/promises");
			let entries: string[];
			try { entries = await readdir(wtDir); } catch { continue; }

			for (const entry of entries) {
				if (!entry.startsWith("worktree-")) continue;
				const wtPath = join(wtDir, entry);
				if (!existsSync(join(wtPath, ".git"))) continue;

				const name = entry.replace(/^worktree-/, "");
				const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
				const hasChanges = Boolean(statusOut);

				const baseBranch = await this.getCurrentBranch(repoRoot);
				const { stdout: aheadStr } = await this.gitExec(wtPath, ["rev-list", "HEAD", "--not", baseBranch, "--count"]);
				const aheadCount = parseInt(aheadStr, 10) || 0;

				let isRunning = false;
				for (const runtime of this.runningById.values()) {
					if (runtime.cwd === wtPath) { isRunning = true; break; }
				}

				results.push({ name, path: wtPath, branch: entry, repoRoot, repoName: basename(repoRoot), hasChanges, aheadCount, isRunning });
			}
		}
		return results;
	}

	async createWorktree(request: { repoPath: string; name: string; baseBranch?: string; clientId: string }): Promise<{ sessionId: string; worktreePath: string }> {
		const repoRoot = await this.getRepoRoot(request.repoPath);
		if (!repoRoot) throw new Error("not_a_git_repo");

		const name = request.name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
		if (!name) throw new Error("invalid_worktree_name");

		const branch = `worktree-${name}`;
		const wtDir = join(repoRoot, ".worktrees");
		const wtPath = join(wtDir, branch);

		if (existsSync(wtPath)) throw new Error("worktree_already_exists");

		const { mkdirSync } = await import("node:fs");
		mkdirSync(wtDir, { recursive: true });

		const base = request.baseBranch?.trim() || "HEAD";
		const { stdout: branchCheck } = await this.gitExec(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
		if (!branchCheck) {
			const { exitCode } = await this.gitExec(repoRoot, ["branch", branch, base]);
			if (exitCode !== 0) throw new Error("failed_to_create_branch");
		}

		const { exitCode: wtResult } = await this.gitExec(repoRoot, ["worktree", "add", wtPath, branch]);
		if (wtResult !== 0 && !existsSync(join(wtPath, ".git"))) {
			await this.gitExec(repoRoot, ["worktree", "prune"]);
			const { exitCode: retry } = await this.gitExec(repoRoot, ["worktree", "add", wtPath, branch]);
			if (retry !== 0 && !existsSync(join(wtPath, ".git"))) throw new Error("failed_to_create_worktree");
		}

		const result = await this.startSession({ clientId: request.clientId, cwd: wtPath });
		return { sessionId: result.sessionId, worktreePath: wtPath };
	}

	async mergeWorktree(request: { worktreePath: string; targetBranch?: string }): Promise<{ merged: boolean; message: string }> {
		const wtPath = request.worktreePath;
		if (!existsSync(join(wtPath, ".git"))) throw new Error("not_a_worktree");

		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) throw new Error("cannot_resolve_repo");

		const { stdout: wtBranch } = await this.gitExec(wtPath, ["symbolic-ref", "--short", "HEAD"]);
		if (!wtBranch) throw new Error("cannot_resolve_branch");

		const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
		if (statusOut) {
			await this.gitExec(wtPath, ["add", "-A"]);
			await this.gitExec(wtPath, ["commit", "-m", `worktree ${wtBranch}: auto-commit before merge`]);
		}

		const target = request.targetBranch?.trim() || await this.getCurrentBranch(repoRoot);
		const { exitCode, stdout: mergeOut } = await this.gitExec(repoRoot, ["merge", wtBranch, "-m", `Merge worktree ${wtBranch} into ${target}`]);
		if (exitCode !== 0) {
			return { merged: false, message: `Merge conflict or failure. Resolve manually in ${repoRoot}.` };
		}
		return { merged: true, message: mergeOut || "Merge successful." };
	}

	async deleteWorktree(wtPath: string): Promise<void> {
		if (!existsSync(wtPath)) return;
		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) return;

		for (const [sessionId, runtime] of this.runningById.entries()) {
			if (runtime.cwd === wtPath) { await this.stopSession(sessionId); break; }
		}

		const { stdout: wtBranch } = await this.gitExec(wtPath, ["symbolic-ref", "--short", "HEAD"]);
		await this.gitExec(repoRoot, ["worktree", "remove", wtPath, "--force"]);
		if (wtBranch) await this.gitExec(repoRoot, ["branch", "-D", wtBranch]);
	}

	async autoCleanupWorktree(wtPath: string): Promise<boolean> {
		if (!existsSync(wtPath)) return false;
		const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
		if (statusOut) return false;
		const { stdout: untrackedOut } = await this.gitExec(wtPath, ["ls-files", "--others", "--exclude-standard"]);
		if (untrackedOut) return false;
		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) return false;
		const baseBranch = await this.getCurrentBranch(repoRoot);
		const { stdout: aheadStr } = await this.gitExec(wtPath, ["rev-list", "HEAD", "--not", baseBranch, "--count"]);
		if ((parseInt(aheadStr, 10) || 0) > 0) return false;
		await this.deleteWorktree(wtPath);
		return true;
	}

	async getWorktreeBranches(repoPath: string): Promise<string[]> {
		const repoRoot = await this.getRepoRoot(repoPath);
		if (!repoRoot) return [];
		const { stdout } = await this.gitExec(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
		if (!stdout) return [];
		return stdout.split("\n").filter(Boolean);
	}

	async isGitRepo(path: string): Promise<boolean> {
		return (await this.getRepoRoot(path)) !== null;
	}
}
