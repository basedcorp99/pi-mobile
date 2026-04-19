import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
	type AgentSession,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { type Model, type Api } from "@mariozechner/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SessionTerminalManager, type TerminalClient } from "./session-terminal.ts";
import type {
	ApiAskQuestion,
	ApiCommandRequest,
	ApiCreateSessionRequest,
	ApiForkSessionRequest,
	ApiForkSessionResponse,
	ApiModelInfo,
	ApiNavigateTreeRequest,
	ApiNavigateTreeResponse,
	ApiSessionCommand,
	ApiSessionState,
	ApiSessionSummary,
	ApiSessionTreeEntry,
	ApiSessionTreeResponse,
	ClientRole,
	ApiSessionPatch,
	DialogCloseReason,
	SseEvent,
	ApiTerminalClientMessage,
	ApiTerminalServerMessage,
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

let cachedNpmRoot: string | null | undefined;
let subagentManagementModulePromise: Promise<any | null> | null = null;
let subagentSkillsModulePromise: Promise<any | null> | null = null;

interface ResolvedStartAgentConfig {
	name: string;
	systemPrompt?: string;
	tools?: unknown[];
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	extensions?: string[];
}

function getGlobalNpmRoot(): string | null {
	if (cachedNpmRoot === undefined) {
		try {
			cachedNpmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 3000 }).trim();
		} catch {
			cachedNpmRoot = null;
		}
	}
	return cachedNpmRoot;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)
		? (normalized as ThinkingLevel)
		: undefined;
}

function resolveModelById(modelIdOrScope: string, modelRegistry: ModelRegistry): { model?: Model<Api>; thinkingLevel?: ThinkingLevel } {
	const trimmed = modelIdOrScope.trim();
	if (!trimmed) return {};

	if (trimmed.includes("/") || trimmed.includes(":")) {
		const separator = trimmed.includes("/") ? "/" : ":";
		const [provider, modelId] = trimmed.split(separator, 2);
		if (!provider || !modelId) return {};
		const match = modelRegistry.find(provider, modelId);
		if (!match) return {};
		const typedMatch = match as Model<Api> & { thinkingLevel?: ThinkingLevel };
		return { model: match, thinkingLevel: typedMatch.thinkingLevel };
	}

	const exact = modelRegistry.getAvailable().find((m) => m.id === trimmed);
	if (exact) {
		const typedExact = exact as Model<Api> & { thinkingLevel?: ThinkingLevel };
		return { model: exact, thinkingLevel: typedExact.thinkingLevel };
	}
	return {};
}

async function loadSubagentManagementModule() {
	if (subagentManagementModulePromise !== null) return subagentManagementModulePromise;
	const root = getGlobalNpmRoot();
	if (!root) {
		subagentManagementModulePromise = Promise.resolve(null);
		return subagentManagementModulePromise;
	}
	subagentManagementModulePromise = import(join(root, "pi-subagents", "agent-management.ts")).then(
		(mod) => (typeof mod.findAgents === "function" ? mod : null),
		() => null,
	);
	return subagentManagementModulePromise;
}

async function loadSubagentSkillsModule() {
	if (subagentSkillsModulePromise !== null) return subagentSkillsModulePromise;
	const root = getGlobalNpmRoot();
	if (!root) {
		subagentSkillsModulePromise = Promise.resolve(null);
		return subagentSkillsModulePromise;
	}
	subagentSkillsModulePromise = import(join(root, "pi-subagents", "skills.ts")).then(
		(mod) =>
			typeof mod.resolveSkills === "function" && typeof mod.buildSkillInjection === "function"
				? mod
				: null,
		() => null,
	);
	return subagentSkillsModulePromise;
}

async function resolveStartAgentConfig(
	cwd: string,
	startAgent: string | undefined,
	modelRegistry: ModelRegistry,
): Promise<ResolvedStartAgentConfig | null> {
	const trimmed = typeof startAgent === "string" ? startAgent.trim() : "";
	if (!trimmed) return null;

	const management = await loadSubagentManagementModule();
	if (!management) throw new Error("start agent support is unavailable");

	const candidates = management.findAgents(trimmed, cwd, "both");
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new Error(`Unknown start agent: ${trimmed}`);
	}

	const selected = candidates[0]!;
	const promptParts: string[] = [];
	if (typeof selected.systemPrompt === "string" && selected.systemPrompt.trim()) {
		promptParts.push(selected.systemPrompt.trim());
	}
	if (Array.isArray(selected.skills) && selected.skills.length > 0) {
		const skillsModule = await loadSubagentSkillsModule();
		if (!skillsModule) throw new Error(`Unable to resolve skills for start agent: ${selected.name}`);
		const result = skillsModule.resolveSkills(selected.skills, cwd);
		if (result.missing.length > 0) {
			throw new Error(`Unknown skills for start agent '${selected.name}': ${result.missing.join(", ")}`);
		}
		if (result.resolved.length > 0) {
			const injected = skillsModule.buildSkillInjection(result.resolved);
			if (injected) promptParts.push(injected);
		}
	}

	let tools: unknown[] | undefined;
	if (Array.isArray(selected.tools) && selected.tools.length > 0) {
		const availableTools: Record<string, unknown> = {
				read: readTool,
				bash: bashTool,
				edit: editTool,
				write: writeTool,
				grep: grepTool,
				find: findTool,
				ls: lsTool,
		};
		const mapped = selected.tools
			.map((name: string) => availableTools[name])
			.filter(Boolean);
		if (mapped.length > 0) {
			tools = mapped;
		}
	}

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	if (typeof selected.model === "string" && selected.model.trim()) {
		const resolvedModel = resolveModelById(selected.model, modelRegistry);
		if (!resolvedModel.model) {
			throw new Error(`Unknown model for start agent '${selected.name}': ${selected.model}`);
		}
		model = resolvedModel.model;
		thinkingLevel = resolvedModel.thinkingLevel;
	}

	const overrideThinking = normalizeThinkingLevel(selected.thinking);
	if (overrideThinking) thinkingLevel = overrideThinking;

	const extensions = Array.isArray(selected.extensions)
		? selected.extensions.map((value: string) => value.trim()).filter(Boolean)
		: undefined;

	const systemPrompt = promptParts.length > 0 ? promptParts.join("\n\n") : undefined;
	return {
		name: selected.name,
		systemPrompt: systemPrompt?.trim(),
		tools,
		model,
		thinkingLevel,
		extensions,
	};
}

function buildSessionResourceLoader(cwd: string, startAgentConfig: ResolvedStartAgentConfig | null): DefaultResourceLoader {
	const info = parseWorktreeInfo(cwd);
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const systemPromptOverride =
		typeof startAgentConfig?.systemPrompt === "string" && startAgentConfig.systemPrompt.trim()
			? (base: string | undefined) => {
				const basePrompt = typeof base === "string" ? base.trim() : "";
				return basePrompt ? `${basePrompt}\n\n${startAgentConfig.systemPrompt}` : startAgentConfig.systemPrompt;
			}
			: undefined;

	const appendSystemPromptOverride = info
		? (base: string[]) => [
			...base,
			`You are on branch \`${info.branch}\` in worktree \`${info.name}\` (repo root: \`${info.repoRoot}\`).\n\n${WORKTREE_GUARDRAILS}`,
		]
		: undefined;

	return new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		...(systemPromptOverride ? { systemPromptOverride } : {}),
		...(appendSystemPromptOverride ? { appendSystemPromptOverride } : {}),
		...(startAgentConfig?.extensions && startAgentConfig.extensions.length > 0
			? { additionalExtensionPaths: startAgentConfig.extensions }
			: {}),
	});
}

async function createSessionWithWorktreeGuard(opts: {
	cwd: string;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	startAgent?: string;
}): Promise<{ session: AgentSession; startAgentConfig: ResolvedStartAgentConfig | null }> {
	const startAgentConfig = await resolveStartAgentConfig(opts.cwd, opts.startAgent, opts.modelRegistry);
	const loader = buildSessionResourceLoader(opts.cwd, startAgentConfig);
	if (loader) await loader.reload();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		authStorage: opts.authStorage,
		modelRegistry: opts.modelRegistry,
		sessionManager: opts.sessionManager,
		settingsManager: SettingsManager.create(opts.cwd, getAgentDir()),
		resourceLoader: loader,
		...(startAgentConfig?.tools ? ({ tools: startAgentConfig.tools } as { tools: any[] }) : {}),
		...(startAgentConfig?.model ? { model: startAgentConfig.model } : {}),
		...(startAgentConfig?.thinkingLevel ? { thinkingLevel: startAgentConfig.thinkingLevel } : {}),
	});
	return { session, startAgentConfig };
}

// ---------------------------------------------------------------------------

export interface SessionClient {
	connectionId: string;
	clientId: string;
	connectedAtMs: number;
	send(event: SseEvent): void;
	close(): void;
}

export interface SessionTerminalClient extends TerminalClient {}

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
	terminalManager: SessionTerminalManager;
	unsubscribe: (() => void) | null;
	lastAssistantMessageText: string;
	startAgent?: string;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("");
}

function compactPreview(text: string, max = 140): string {
	const normalized = String(text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…` : normalized;
}

const FAST_SESSION_PREVIEW_MAX_CHARS = 4_000;
const FAST_SESSION_PREVIEW_MAX_LINES = 80;

function truncateFastPreviewText(input: string, maxChars = FAST_SESSION_PREVIEW_MAX_CHARS, maxLines = FAST_SESSION_PREVIEW_MAX_LINES): string {
	const text = String(input ?? "");
	if (!text) return "";
	const lines = text.split("\n");
	const limitedLines = lines.slice(0, maxLines);
	let output = limitedLines.join("\n");
	const truncatedByLines = limitedLines.length < lines.length;
	let truncatedByChars = false;
	if (output.length > maxChars) {
		output = output.slice(0, maxChars);
		truncatedByChars = true;
	}
	if (truncatedByLines || truncatedByChars) {
		output = `${output.trimEnd()}\n\n[truncated for fast session loading]`;
	}
	return output;
}

function summarizeContentForFastSessionPreview(content: unknown): string {
	if (typeof content === "string") {
		const preview = truncateFastPreviewText(content);
		return preview || "(content omitted for fast session loading)";
	}
	if (!Array.isArray(content)) return "(content omitted for fast session loading)";

	const textParts: string[] = [];
	let imageCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typedBlock = block as {
			type?: unknown;
			text?: unknown;
			data?: unknown;
		};
		if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
			textParts.push(typedBlock.text);
			continue;
		}
		if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
			imageCount += 1;
		}
	}

	let text = textParts.join("\n").trim();
	if (imageCount > 0) {
		text += `${text ? "\n\n" : ""}[${imageCount} image${imageCount === 1 ? "" : "s"} omitted for fast session loading]`;
	}
	if (!text) {
		text = "(content omitted for fast session loading)";
	}
	return truncateFastPreviewText(text);
}

function summarizeAssistantContentForFastSessionPreview(content: unknown): unknown {
	if (typeof content === "string") {
		const preview = truncateFastPreviewText(content);
		return preview || "(content omitted for fast session loading)";
	}
	if (!Array.isArray(content)) return "(content omitted for fast session loading)";

	const previewBlocks: Record<string, unknown>[] = [];
	let imageCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typedBlock = block as {
			type?: unknown;
			text?: unknown;
			data?: unknown;
			thinking?: unknown;
			reasoning?: unknown;
		};
		if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
			const previewText = truncateFastPreviewText(typedBlock.text);
			if (previewText) previewBlocks.push({ ...(block as Record<string, unknown>), text: previewText });
			continue;
		}
		if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
			const previewThinking = truncateFastPreviewText(typedBlock.thinking);
			if (previewThinking) previewBlocks.push({ ...(block as Record<string, unknown>), thinking: previewThinking });
			continue;
		}
		if (typedBlock.type === "reasoning" && typeof typedBlock.reasoning === "string") {
			const previewReasoning = truncateFastPreviewText(typedBlock.reasoning);
			if (previewReasoning) previewBlocks.push({ ...(block as Record<string, unknown>), reasoning: previewReasoning });
			continue;
		}
		if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
			imageCount += 1;
			continue;
		}
		previewBlocks.push({ ...(block as Record<string, unknown>) });
	}

	if (imageCount > 0) {
		previewBlocks.push({
			type: "text",
			text: `[${imageCount} image${imageCount === 1 ? "" : "s"} omitted for fast session loading]`,
		});
	}

	return previewBlocks.length > 0 ? previewBlocks : "(content omitted for fast session loading)";
}

function makeFastSessionPreviewMessage(message: AgentMessage): AgentMessage {
	if (!message || typeof message !== "object") return message;
	const role = (message as { role?: unknown }).role;
	const preview: Record<string, unknown> = { ...(message as unknown as Record<string, unknown>) };
	if (Object.prototype.hasOwnProperty.call(preview, "content")) {
		preview.content = role === "assistant"
			? summarizeAssistantContentForFastSessionPreview(preview.content)
			: summarizeContentForFastSessionPreview(preview.content);
	}
	if (role === "toolResult") {
		preview.details = undefined;
	}
	return preview as unknown as AgentMessage;
}

function makeFastSessionPreviewMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => makeFastSessionPreviewMessage(message));
}

function describeSessionTreeEntry(entry: any): Pick<ApiSessionTreeEntry, "type" | "role" | "title" | "preview" | "isUserMessage" | "canFork"> {
	if (!entry || typeof entry !== "object") {
		return { type: "unknown", title: "Entry", preview: "", isUserMessage: false, canFork: false };
	}

	if (entry.type === "message") {
		const role = typeof entry.message?.role === "string" ? entry.message.role : undefined;
		if (role === "user") {
			return {
				type: "message",
				role,
				title: "User",
				preview: compactPreview(extractTextContent(entry.message?.content) || "(empty user message)"),
				isUserMessage: true,
				canFork: true,
			};
		}
		if (role === "assistant") {
			const preview = compactPreview(extractTextContent(entry.message?.content));
			return {
				type: "message",
				role,
				title: "Assistant",
				preview: preview || "Assistant response",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "toolResult") {
			const toolName = typeof entry.message?.toolName === "string" ? entry.message.toolName : "tool";
			const preview = compactPreview(extractTextContent(entry.message?.content));
			return {
				type: "message",
				role,
				title: `Tool: ${toolName}`,
				preview: preview || "Tool result",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "bashExecution") {
			const command = typeof entry.message?.command === "string" ? entry.message.command : "bash command";
			return {
				type: "message",
				role,
				title: "Bash",
				preview: compactPreview(command) || "Bash command",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "custom") {
			const customType = typeof entry.message?.customType === "string" ? entry.message.customType : "custom";
			const preview = compactPreview(extractTextContent(entry.message?.content) || String(entry.message?.content || ""));
			return {
				type: "message",
				role,
				title: `Custom: ${customType}`,
				preview: preview || "Custom message",
				isUserMessage: false,
				canFork: false,
			};
		}
		return {
			type: "message",
			role,
			title: role ? role[0]!.toUpperCase() + role.slice(1) : "Message",
			preview: compactPreview(extractTextContent(entry.message?.content) || "Message"),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "branch_summary") {
		return {
			type: entry.type,
			role: "branchSummary",
			title: "Branch summary",
			preview: compactPreview(typeof entry.summary === "string" ? entry.summary : "") || "Branch summary",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "compaction") {
		return {
			type: entry.type,
			role: "compactionSummary",
			title: "Compaction",
			preview: compactPreview(typeof entry.summary === "string" ? entry.summary : "") || "Compaction summary",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "model_change") {
		return {
			type: entry.type,
			title: "Model change",
			preview: compactPreview(`${entry.provider || "provider"}/${entry.modelId || "model"}`),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "thinking_level_change") {
		return {
			type: entry.type,
			title: "Thinking",
			preview: compactPreview(String(entry.thinkingLevel || "")) || "Thinking level change",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "custom") {
		return {
			type: entry.type,
			title: `Custom: ${entry.customType || "entry"}`,
			preview: compactPreview(typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {})) || "Custom entry",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "custom_message") {
		return {
			type: entry.type,
			role: "custom",
			title: `Custom: ${entry.customType || "message"}`,
			preview: compactPreview(extractTextContent(entry.content) || String(entry.content || "")) || "Custom message",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "label") {
		return {
			type: entry.type,
			title: "Label",
			preview: compactPreview(typeof entry.label === "string" ? entry.label : "(cleared label)"),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "session_info") {
		return {
			type: entry.type,
			title: "Session info",
			preview: compactPreview(typeof entry.name === "string" ? entry.name : "Session metadata") || "Session metadata",
			isUserMessage: false,
			canFork: false,
		};
	}

	return {
		type: typeof entry.type === "string" ? entry.type : "entry",
		title: "Entry",
		preview: "",
		isUserMessage: false,
		canFork: false,
	};
}

function flattenSessionTree(
	nodes: Array<any>,
	depth: number,
	leafId: string | null,
	activePathIds: Set<string>,
	out: ApiSessionTreeEntry[],
): void {
	for (const node of nodes || []) {
		const entry = node?.entry;
		if (!entry || typeof entry !== "object") continue;
		const described = describeSessionTreeEntry(entry);
		out.push({
			id: String(entry.id || ""),
			parentId: entry.parentId ?? null,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
			depth,
			type: described.type,
			role: described.role,
			title: described.title,
			preview: described.preview,
			label: typeof node?.label === "string" ? node.label : undefined,
			labelTimestamp: typeof node?.labelTimestamp === "string" ? node.labelTimestamp : undefined,
			isUserMessage: described.isUserMessage,
			canFork: described.canFork,
			isActiveLeaf: leafId === entry.id,
			isActivePath: activePathIds.has(entry.id),
		});
		flattenSessionTree(Array.isArray(node?.children) ? node.children : [], depth + 1, leafId, activePathIds, out);
	}
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

// Only include built-in commands that actually work as plain slash commands in pi-mobile.
// Commands with dedicated mobile UI (for example tree/fork launchers) are surfaced elsewhere
// instead of being sent through the prompt pipeline.
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

function toMessageTimestamp(timestamp: unknown): number {
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp !== "string") return Date.now();
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildMessagesFromSessionBranch(session: AgentSession): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of session.sessionManager.getBranch()) {
		switch (entry.type) {
			case "message":
				messages.push(entry.message);
				break;
			case "custom_message": {
				messages.push({
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					details: entry.details,
					timestamp: toMessageTimestamp(entry.timestamp),
				});
				break;
			}
			case "branch_summary": {
				messages.push({
					role: "branchSummary",
					summary: entry.summary,
					fromId: entry.fromId,
					timestamp: toMessageTimestamp(entry.timestamp),
				} as AgentMessage);
				break;
			}
			case "compaction": {
				messages.push({
					role: "compactionSummary",
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					timestamp: toMessageTimestamp(entry.timestamp),
				} as AgentMessage);
				break;
			}
			default:
				break;
		}
	}
	return messages;
}

function buildState(session: AgentSession, cwd: string, includeFullHistory = false, startAgent?: string, messageLimit = 0): ApiSessionState {
	let messages = includeFullHistory ? buildMessagesFromSessionBranch(session) : session.messages;
	if (messageLimit > 0 && messages.length > messageLimit) {
		// `tailMessages` is only meant to bound how many messages we send on
		// initial session load. Never rewrite message content into preview text,
		// or placeholders like `[truncated for fast session loading]` can leak
		// into the actual chat transcript shown to the user.
		messages = messages.slice(-messageLimit);
	}
	return {
		sessionId: session.sessionId,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		startAgent,
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		messages,
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

function readSessionHeaderCwd(path: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const chunk = Buffer.alloc(4096);
		let text = "";
		let position = 0;
		while (!text.includes("\n") && position < 64 * 1024) {
			const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
			if (bytesRead <= 0) break;
			text += chunk.subarray(0, bytesRead).toString("utf8");
			position += bytesRead;
		}
		const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine) return null;
		const header = JSON.parse(firstLine);
		return header && header.type === "session" && typeof header.cwd === "string"
			? header.cwd
			: null;
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try { closeSync(fd); } catch {}
		}
	}
}

function openSessionManagerFast(path: string, sessionDir?: string): SessionManager {
	const resolvedPath = resolve(path);
	const dir = sessionDir ?? dirname(resolvedPath);
	const cwd = readSessionHeaderCwd(resolvedPath) ?? process.cwd();
	const SessionManagerCtor = SessionManager as unknown as new (cwd: string, sessionDir: string, sessionFile: string, persist: boolean) => SessionManager;
	return new SessionManagerCtor(cwd, dir, resolvedPath, true);
}

function serializeSessionSummary(entry: {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	startAgent?: string;
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
		startAgent: entry.startAgent,
		firstMessage: entry.firstMessage ?? "(no messages)",
		created: entry.created.toISOString(),
		modified: entry.modified.toISOString(),
		messageCount: entry.messageCount,
		isRunning: false,
	};
}

interface PendingAsk {
	resolve: (value: { cancelled?: boolean; selections: Array<{ selectedOptions: string[]; customInput?: string }> }) => boolean;
	close: (reason: DialogCloseReason) => boolean;
	sessionId: string;
	questions: ApiAskQuestion[];
}

type PendingUiPromptEvent = Extract<SseEvent, { type: "ui_select" | "ui_input" | "ui_confirm" }>;

interface PendingUiPrompt {
	resolve: (value: string | undefined) => boolean;
	close: (reason: DialogCloseReason) => boolean;
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
						const finish = (value: { cancelled?: boolean; selections: Array<{ selectedOptions: string[]; customInput?: string }> }) => {
							if (done) return false;
							done = true;
							self.pendingAsks.delete(askId);
							if (signal && typeof signal.removeEventListener === "function") {
								signal.removeEventListener("abort", onAbort);
							}
							resolve(value);
							return true;
						};
						const close = (reason: DialogCloseReason) => {
							const closed = finish({ cancelled: true, selections: [] });
							if (closed) self.sendToController(sessionId, { type: "ask_closed", askId, reason });
							return closed;
						};
						const onAbort = () => close("aborted");
						self.pendingAsks.set(askId, { resolve: finish, close, sessionId, questions });
						self.sendToController(sessionId, { type: "ask_request", askId, questions });
						if (signal?.aborted) close("aborted");
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

	resolveAsk(sessionId: string, askId: string, cancelled: boolean, selections: Array<{ selectedOptions: string[]; customInput?: string }>): boolean {
		const pending = this.pendingAsks.get(askId);
		if (!pending || pending.sessionId !== sessionId) return false;
		return pending.resolve({ cancelled, selections });
	}

	resolveUiPrompt(sessionId: string, uiId: string, cancelled: boolean, value?: string): boolean {
		const pending = this.pendingUiPrompts.get(uiId);
		if (!pending || pending.sessionId !== sessionId) return false;
		return pending.resolve(cancelled ? undefined : value);
	}

	private cancelPendingDialogsForSession(sessionId: string, reason: DialogCloseReason = "aborted"): void {
		for (const pending of this.pendingAsks.values()) {
			if (pending.sessionId !== sessionId) continue;
			pending.close(reason);
		}
		for (const pending of this.pendingUiPrompts.values()) {
			if (pending.sessionId !== sessionId) continue;
			pending.close(reason);
		}
	}

	private createWebUIContext(sessionId: string): any {
		const self = this;
		const waitForUiPrompt = (event: PendingUiPromptEvent): Promise<string | undefined> => {
			const uiId = event.uiId;
			return new Promise<string | undefined>((resolve) => {
				let done = false;
				const finish = (value: string | undefined) => {
					if (done) return false;
					done = true;
					self.pendingUiPrompts.delete(uiId);
					resolve(value);
					return true;
				};
				const close = (reason: DialogCloseReason) => {
					const closed = finish(undefined);
					if (closed) self.sendToController(sessionId, { type: "ui_prompt_closed", uiId, reason });
					return closed;
				};
				self.pendingUiPrompts.set(uiId, { resolve: finish, close, sessionId, event });
				self.sendToController(sessionId, event);
			});
		};
		return {
			async select(title: string, options: string[]): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_select", uiId, title, options };
				return waitForUiPrompt(event);
			},
			async confirm(title: string, message: string): Promise<boolean> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_confirm", uiId, title, message };
				const result = await waitForUiPrompt(event);
				return result === "true";
			},
			async input(title: string, placeholder?: string): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_input", uiId, title, placeholder };
				return waitForUiPrompt(event);
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
				return waitForUiPrompt(event);
			},
			async custom(title: string, options: Array<{ label: string; value: unknown } | string>) {
				// Fallback for clarify dialogs and other custom UIs — use the working select UI
				if (!options?.length) return undefined;
				const labels = options.map((o) => (typeof o === "string" ? o : o.label));
				const selected = await this.select(title || "Choose", labels);
				if (selected === undefined) return undefined;
				// Map back to original option object (pi-subagents clarify expects the option, not just the value)
				const idx = labels.indexOf(selected);
				return options[idx];
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText: () => "",
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
				startAgent: runtime.startAgent,
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
			if (summary.isRunning) {
				const runtimeId = this.runningByPath.get(entry.path);
				const runtime = runtimeId ? this.runningById.get(runtimeId) : null;
				summary.startAgent = runtime?.startAgent;
			}
			byId.set(summary.id, summary);
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
			// If the saved list already contains this session id, just mark it running and move on.
			const existing = byId.get(sessionId);
			if (existing) {
				existing.isRunning = true;
				existing.modified = toIso(runtime.modifiedAtMs);
				existing.messageCount = runtime.session.messages.length;
				existing.startAgent = runtime.startAgent;
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
				startAgent: runtime.startAgent,
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

	getSessionState(sessionId: string, includeFullHistory = false, messageLimit = 0): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const state = buildState(runtime.session, runtime.cwd, includeFullHistory, runtime.startAgent, messageLimit);
		state.pendingAskIds = [...this.pendingAsks.entries()]
			.filter(([, pending]) => pending.sessionId === sessionId)
			.map(([askId]) => askId);
		state.pendingUiPromptIds = [...this.pendingUiPrompts.entries()]
			.filter(([, pending]) => pending.sessionId === sessionId)
			.map(([uiId]) => uiId);
		return state;
	}

	getSessionTree(sessionId: string): ApiSessionTreeResponse {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		const leafId = runtime.session.sessionManager.getLeafId();
		const activePathIds = new Set<string>();
		for (const entry of runtime.session.sessionManager.getBranch()) {
			if (entry?.id) activePathIds.add(entry.id);
		}

		const entries: ApiSessionTreeEntry[] = [];
		flattenSessionTree(runtime.session.sessionManager.getTree() as Array<any>, 0, leafId, activePathIds, entries);
		return { leafId, entries };
	}

	async navigateTree(sessionId: string, request: ApiNavigateTreeRequest): Promise<ApiNavigateTreeResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) throw new Error("session_not_running");
		const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
		if (!clientId) throw new Error("missing_client_id");
		this.assertController(runtime, clientId);
		if (runtime.session.isStreaming) throw new Error("cannot_tree_while_streaming");

		const targetId = typeof request.targetId === "string" ? request.targetId.trim() : "";
		if (!targetId) throw new Error("missing_target_id");

		const result = await runtime.session.navigateTree(targetId, {
			summarize: Boolean(request.summarize),
			customInstructions:
				typeof request.customInstructions === "string" && request.customInstructions.trim().length > 0
					? request.customInstructions.trim()
					: undefined,
			replaceInstructions: Boolean(request.replaceInstructions),
			label: typeof request.label === "string" && request.label.trim().length > 0 ? request.label.trim() : undefined,
		});
		runtime.modifiedAtMs = Date.now();
		return {
			cancelled: Boolean(result.cancelled),
			aborted: Boolean(result.aborted),
			editorText: typeof result.editorText === "string" ? result.editorText : undefined,
		};
	}

	async forkSession(sessionId: string, request: ApiForkSessionRequest): Promise<ApiForkSessionResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) throw new Error("session_not_running");
		const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
		if (!clientId) throw new Error("missing_client_id");
		this.assertController(runtime, clientId);
		if (runtime.session.isStreaming) throw new Error("cannot_fork_while_streaming");

		const entryId = typeof request.entryId === "string" ? request.entryId.trim() : "";
		if (!entryId) throw new Error("missing_entry_id");

		const runner = runtime.session.extensionRunner;
		if (runner?.hasHandlers("session_before_fork")) {
			const before = await runner.emit({ type: "session_before_fork", entryId });
			if (before?.cancel) return { cancelled: true };
		}

		const selectedEntry = runtime.session.sessionManager.getEntry(entryId) as any;
		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message?.role !== "user") {
			throw new Error("invalid_fork_entry");
		}

		if (!runtime.session.sessionManager.isPersisted()) {
			throw new Error("fork_requires_persisted_session");
		}

		const currentSessionFile = runtime.session.sessionFile;
		if (!currentSessionFile) {
			throw new Error("missing_session_file");
		}

		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const selectedText = extractTextContent(selectedEntry.message?.content);
		let forkedSessionPath: string | undefined;

		if (!selectedEntry.parentId) {
			const sessionManager = SessionManager.create(runtime.cwd, sessionDir);
			sessionManager.newSession({ parentSession: currentSessionFile });
			forkedSessionPath = sessionManager.getSessionFile();
		} else {
			const sourceManager = openSessionManagerFast(currentSessionFile, sessionDir);
			forkedSessionPath = sourceManager.createBranchedSession(selectedEntry.parentId);
		}

		if (!forkedSessionPath) {
			throw new Error("failed_to_create_forked_session");
		}

		const started = await this.startSession({ clientId, resumeSessionPath: forkedSessionPath });
		return {
			cancelled: false,
			sessionId: started.sessionId,
			selectedText: selectedText || undefined,
		};
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

	addTerminalClient(sessionId: string, client: SessionTerminalClient): ApiTerminalServerMessage {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return runtime.terminalManager.addClient(client);
	}

	removeTerminalClient(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.terminalManager.removeClient(connectionId);
	}

	handleTerminalClientMessage(sessionId: string, connectionId: string, message: ApiTerminalClientMessage): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.terminalManager.handleMessage(connectionId, message);
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

			const sessionManager = openSessionManagerFast(path);
			const cwd = sessionManager.getCwd();
			const { session, startAgentConfig } = await createSessionWithWorktreeGuard({
				cwd,
				sessionManager,
				authStorage: this.authStorage,
				modelRegistry: this.modelRegistry,
				startAgent: request.startAgent,
			});
			const runtime = this.registerSession(session, cwd, clientId, startAgentConfig);
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
		const { session, startAgentConfig } = await createSessionWithWorktreeGuard({
			cwd,
			sessionManager,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			startAgent: request.startAgent,
		});
		const runtime = this.registerSession(session, cwd, clientId, startAgentConfig);
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
			this.cancelPendingDialogsForSession(sessionId, "aborted");
			await runtime.session.abort();
			return;
		}

		if (command.type === "ask_response") {
			this.assertController(runtime, command.clientId);
			const askId = typeof command.askId === "string" ? command.askId.trim() : "";
			if (!askId) throw new Error("missing_ask_id");
			const selections = Array.isArray(command.selections) ? command.selections : [];
			if (!this.resolveAsk(sessionId, askId, Boolean(command.cancelled), selections)) {
				throw new Error("ask_not_pending");
			}
			return;
		}

		if (command.type === "ui_response") {
			this.assertController(runtime, command.clientId);
			const uiId = typeof command.uiId === "string" ? command.uiId.trim() : "";
			if (!uiId) throw new Error("missing_ui_id");
			if (!this.resolveUiPrompt(sessionId, uiId, Boolean(command.cancelled), command.value)) {
				throw new Error("ui_prompt_not_pending");
			}
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
			// Keep directory handling in-session (via sessionManager cwd) rather than injecting
			// a textual `cd` prefix, which can break shell syntax/quoting.
			await runtime.session.executeBash(bashCommand, undefined, {
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
				const commandName = cmdMatch[1].toLowerCase();
				const isExtCmd = runner && typeof runner.getCommand === "function" && runner.getCommand(commandName);
				if (!isExtCmd) {
					const message = commandName === "tree" || commandName === "fork"
						? `/${commandName} is available in pi-mobile via the Commands menu.`
						: `/${cmdMatch[1]} is not available in pi-mobile. Use the UI controls instead.`;
					this.broadcast(sessionId, { type: "ui_notify", message, level: "warning" });
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
			runtime.session.setThinkingLevel(level as ThinkingLevel);
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
		this.cancelPendingDialogsForSession(sessionId, "released");

		for (const client of runtime.clients.values()) {
			client.close();
		}
		runtime.terminalManager.dispose();

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
		this.cancelPendingDialogsForSession(sessionId, "released");

		for (const client of runtime.clients.values()) {
			client.close();
		}
		runtime.terminalManager.dispose();

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

	private registerSession(session: AgentSession, cwd: string, controllerClientId: string, startAgentConfig: ResolvedStartAgentConfig | null): RunningSession {
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
			terminalManager: new SessionTerminalManager({
				sessionId,
				cwd,
				canWrite: (clientId) => runtime.controllerClientId === clientId,
			}),
			unsubscribe: null,
			lastAssistantMessageText: "",
			startAgent: startAgentConfig?.name,
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

	async createWorktree(request: { repoPath: string; name: string; baseBranch?: string; clientId: string; startAgent?: string }): Promise<{ sessionId: string; worktreePath: string }> {
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

		const result = await this.startSession({ clientId: request.clientId, cwd: wtPath, startAgent: request.startAgent });
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
