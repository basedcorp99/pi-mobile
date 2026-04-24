// Copied by setup.sh into ~/.pi/agent/extensions/review.ts.
// This extension runs inside the system-installed Pi environment, not pi-mobile's local node_modules.
import { complete, StringEnum, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { askSingleQuestionWithInlineNote } from "pi-ask-tool-extension/src/ask-inline-ui.ts";
import { askQuestionsWithTabs } from "pi-ask-tool-extension/src/ask-tabs-ui.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const execFile = promisify(execFileCb);

const GIT_MAX_BUFFER_BYTES = 80 * 1024 * 1024;
const SNAPSHOT_SECTION_MAX_CHARS = 12_000;
const SNAPSHOT_UNTRACKED_CHARS = 24_000;
const REVIEW_SETTINGS_FILE = join(homedir(), ".pi", "agent", "review-settings.json");

interface ReviewSettingsFile {
	defaultModel?: string | null;
}

function formatModelValue(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function normalizeModelValue(value: string | undefined | null): string | undefined {
	const trimmed = String(value ?? "").trim();
	return trimmed || undefined;
}

function parseModelValue(value: string | undefined | null): { provider: string; id: string } | null {
	const normalized = normalizeModelValue(value);
	if (!normalized) return null;
	const slashIndex = normalized.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return null;
	return {
		provider: normalized.slice(0, slashIndex),
		id: normalized.slice(slashIndex + 1),
	};
}

function formatModelOptionLabel(model: { provider: string; id: string; name?: string }): string {
	const value = formatModelValue(model);
	const label = String(model.name || model.id || "").trim();
	return label && label !== value ? `${label} · ${value}` : value;
}

async function readReviewSettings(): Promise<ReviewSettingsFile> {
	try {
		const raw = await readFile(REVIEW_SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw) as ReviewSettingsFile;
		return { defaultModel: normalizeModelValue(parsed?.defaultModel ?? undefined) ?? null };
	} catch {
		return { defaultModel: null };
	}
}

async function writeReviewSettings(settings: ReviewSettingsFile): Promise<void> {
	await mkdir(dirname(REVIEW_SETTINGS_FILE), { recursive: true });
	await writeFile(REVIEW_SETTINGS_FILE, `${JSON.stringify({ defaultModel: normalizeModelValue(settings.defaultModel ?? undefined) ?? null }, null, 2)}\n`, "utf8");
}

async function getStoredReviewModelValue(): Promise<string | undefined> {
	return normalizeModelValue((await readReviewSettings()).defaultModel ?? undefined);
}

async function setStoredReviewModelValue(value: string | undefined): Promise<void> {
	await writeReviewSettings({ defaultModel: normalizeModelValue(value) ?? null });
}

function splitReviewArgs(rawArgs: string): string[] {
	const args = String(rawArgs ?? "").trim();
	if (!args) return [];
	const tokens: string[] = [];
	let current = "";
	let quote: "" | "'" | '"' = "";
	let escaped = false;

	for (let i = 0; i < args.length; i += 1) {
		const char = args[i];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = "";
				continue;
			}
			current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function stripOuterQuotes(value: string): string {
	const trimmed = String(value == null ? "" : value).trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

type ReviewMode = "working-tree" | "commit" | "branch" | "custom";

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer.

Review the provided change snapshot as if it were a PR review.
Focus on:
- correctness and edge cases
- security issues
- performance regressions
- error handling gaps
- missing or weak tests
- dependency additions and supply-chain risk
- maintainability problems that could bite later

Be direct and actionable. Prefer concrete findings over praise.
If you see newly added dependencies, call them out explicitly.

Return markdown with this structure:
1. A short verdict
2. A findings section with bullets, ranked by severity
3. A suggested fixes section
4. A short final note if there are no major issues

When possible, mention file paths and specific code locations.`;

const ReviewRunSchema = Type.Object({
	mode: StringEnum(["working-tree", "commit", "branch", "custom"] as const),
	commitRef: Type.Optional(Type.String({ description: "Commit ref when mode=commit" })),
	baseRef: Type.Optional(Type.String({ description: "Base branch/ref when mode=branch" })),
	instructions: Type.Optional(Type.String({ description: "Extra review focus or custom review instructions" })),
	model: Type.Optional(Type.String({ description: "Model override for this review. Use provider/id or 'session'." })),
});

type ReviewRunParams = Static<typeof ReviewRunSchema>;

type ParsedReviewCommand =
	| { kind: "run"; params: ReviewRunParams | null; modelOverride?: string }
	| { kind: "model"; arg?: string };

function trimText(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return {
		text: `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} characters]`,
		truncated: true,
	};
}

function trimForSnapshot(value: string, maxChars = SNAPSHOT_SECTION_MAX_CHARS): string {
	const normalized = normalizeLines(value);
	return trimText(normalized, maxChars).text;
}

function normalizeLines(value: string): string {
	return value
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function formatSection(title: string, body: string): string {
	const normalized = normalizeLines(body);
	return `${title}\n${normalized ? normalized : "(none)"}`;
}

function stringifyFocus(instructions?: string): string {
	const normalized = normalizeLines(instructions ?? "");
	return normalized || "general review";
}

function buildDisplayReport(options: {
	mode: ReviewMode;
	targetLabel: string;
	branch: string;
	instructions?: string;
	modelLabel: string;
	reviewText: string;
}): string {
	return [
		`## Review: ${options.targetLabel}`,
		`- Mode: ${options.mode}`,
		`- Model: ${options.modelLabel}`,
		`- Branch: ${options.branch}`,
		`- Extra focus: ${stringifyFocus(options.instructions)}`,
		"",
		options.reviewText.trim(),
	].join("\n");
}

function buildReviewPrompt(options: {
	mode: ReviewMode;
	repoRoot: string;
	branch: string;
	targetLabel: string;
	instructions?: string;
	snapshot: string;
}): string {
	return [
		`Review mode: ${options.mode}`,
		`Repository root: ${options.repoRoot}`,
		`Current branch: ${options.branch}`,
		`Target: ${options.targetLabel}`,
		`Extra focus: ${stringifyFocus(options.instructions)}`,
		"",
		"Use the snapshot below as the source of truth. If it looks incomplete, say what is missing rather than guessing.",
		"",
		"<snapshot>",
		options.snapshot,
		"</snapshot>",
		"",
		"Return a concise markdown review with a verdict, findings, and suggested fixes.",
	].join("\n");
}

function extractTextMessage(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n");
}

async function ensureRefExists(cwd: string, ref: string): Promise<void> {
	await runGit(cwd, ["cat-file", "-e", `${ref}^{commit}`]);
}

async function chooseReviewModelSelector(ctx: Pick<ExtensionCommandContext, "model" | "modelRegistry" | "ui">): Promise<string | undefined | null> {
	const available = await ctx.modelRegistry.getAvailable();
	const optionMap = new Map<string, string | undefined>();
	const options: string[] = [];
	const storedDefault = await getStoredReviewModelValue();

	if (storedDefault) {
		const label = `Saved review default · ${storedDefault}`;
		optionMap.set(label, undefined);
		options.push(label);
	}

	if (ctx.model) {
		const sessionValue = formatModelValue(ctx.model);
		const label = `Current session model · ${sessionValue}`;
		optionMap.set(label, "session");
		options.push(label);
	}

	const seenValues = new Set(options.map((label) => optionMap.get(label)).filter(Boolean));
	const sortedModels = [...available].sort((a, b) => formatModelOptionLabel(a).localeCompare(formatModelOptionLabel(b)));
	for (const model of sortedModels) {
		const value = formatModelValue(model);
		if (seenValues.has(value)) continue;
		const label = formatModelOptionLabel(model);
		optionMap.set(label, value);
		options.push(label);
		seenValues.add(value);
	}

	if (options.length === 0) return undefined;
	const selected = await ctx.ui.select("Which model should I use for this review?", options);
	if (selected === undefined) return null;
	return optionMap.get(selected);
}

async function resolveSpecificReviewModel(ctx: Pick<ExtensionContext, "modelRegistry">, value: string): Promise<{ model: any; modelValue: string }> {
	const parsed = parseModelValue(value);
	if (!parsed) {
		throw new Error(`Invalid model "${value}". Use provider/id.`);
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		throw new Error(`Review model not found: ${value}`);
	}
	return { model, modelValue: formatModelValue(model) };
}

async function resolveReviewModelForRun(ctx: Pick<ExtensionContext, "model" | "modelRegistry"> & { hasUI?: boolean; ui?: { notify(message: string, level?: "info" | "warning" | "error" | "success"): void } }, selector?: string): Promise<{ model: any; modelValue: string; source: "explicit" | "stored-default" | "session" }> {
	const normalizedSelector = normalizeModelValue(selector);
	if (normalizedSelector === "session") {
		if (!ctx.model) throw new Error("No current session model is selected");
		return { model: ctx.model, modelValue: formatModelValue(ctx.model), source: "session" };
	}
	if (normalizedSelector) {
		const resolved = await resolveSpecificReviewModel(ctx, normalizedSelector);
		return { ...resolved, source: "explicit" };
	}

	const storedDefault = await getStoredReviewModelValue();
	if (storedDefault) {
		try {
			const resolved = await resolveSpecificReviewModel(ctx, storedDefault);
			return { ...resolved, source: "stored-default" };
		} catch (error) {
			if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(`Saved review model ${storedDefault} is unavailable; falling back to the current session model.`, "warning");
			}
		}
	}

	if (ctx.model) {
		return { model: ctx.model, modelValue: formatModelValue(ctx.model), source: "session" };
	}

	throw new Error("No review model available. Set one with /review model <provider/id> or pick a session model.");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFile("git", args, { cwd, maxBuffer: GIT_MAX_BUFFER_BYTES });
		return String(result.stdout ?? "");
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string };
		const message = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim();
		throw new Error(message || `git ${args.join(" ")} failed`);
	}
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
	try {
		return await runGit(cwd, args);
	} catch {
		return "";
	}
}

async function detectRepoRoot(cwd: string): Promise<string> {
	const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
	if (!root) throw new Error("Not inside a git repository");
	return root;
}

async function readSnippetForFile(cwd: string, relPath: string, maxChars = 8000): Promise<string> {
	const abs = resolve(cwd, relPath);
	try {
		const data = await readFile(abs, "utf8");
		const { text, truncated } = trimText(data, maxChars);
		return [`=== ${relPath} ===`, text, truncated ? "[truncated]" : ""].filter(Boolean).join("\n");
	} catch {
		return `=== ${relPath} ===\n[unable to read file]`;
	}
}

async function collectUntrackedSnippets(cwd: string, maxFiles = 5, totalCharBudget = SNAPSHOT_UNTRACKED_CHARS): Promise<string> {
	const untracked = normalizeLines(await tryGit(cwd, ["ls-files", "--others", "--exclude-standard"]));
	if (!untracked) return "";

	const files = untracked.split("\n").filter(Boolean).slice(0, maxFiles);
	const snippets: string[] = [];
	let remaining = totalCharBudget;
	for (const file of files) {
		if (remaining <= 0) break;
		const snippet = await readSnippetForFile(cwd, file, Math.min(8_000, remaining));
		remaining -= snippet.length;
		snippets.push(snippet);
	}

	return snippets.join("\n\n");
}

async function buildWorkingTreeSnapshot(cwd: string): Promise<string> {
	const status = trimForSnapshot(await tryGit(cwd, ["status", "--short", "--untracked-files=normal"]));
	const branch = trimForSnapshot(await tryGit(cwd, ["branch", "--show-current"])) || "(detached HEAD)";
	const stagedStat = trimForSnapshot(await tryGit(cwd, ["diff", "--cached", "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const unstagedStat = trimForSnapshot(await tryGit(cwd, ["diff", "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const stagedPatch = trimForSnapshot(await tryGit(cwd, ["diff", "--cached", "--unified=3", "--find-renames=30%", "--no-color"]));
	const unstagedPatch = trimForSnapshot(await tryGit(cwd, ["diff", "--unified=3", "--find-renames=30%", "--no-color"]));
	const untrackedSnippets = trimForSnapshot(await collectUntrackedSnippets(cwd));

	return [
		formatSection("[branch]", branch),
		formatSection("[status]", status),
		formatSection("[staged stat]", stagedStat),
		formatSection("[unstaged stat]", unstagedStat),
		formatSection("[staged diff]", stagedPatch),
		formatSection("[unstaged diff]", unstagedPatch),
		formatSection("[untracked files]", untrackedSnippets),
	].join("\n\n");
}

async function buildCommitSnapshot(cwd: string, commitRef: string): Promise<string> {
	const show = trimForSnapshot(await runGit(cwd, ["show", "--stat", "--summary", "--find-renames=30%", "--unified=3", "--no-color", commitRef]));
	return formatSection(`[git show ${commitRef}]`, show);
}

async function buildBranchSnapshot(cwd: string, baseRef: string): Promise<string> {
	const currentBranch = trimForSnapshot(await tryGit(cwd, ["branch", "--show-current"]) || "") || "(detached HEAD)";
	const log = trimForSnapshot(await tryGit(cwd, ["log", "--oneline", "--decorate", `${baseRef}..HEAD`, "--max-count=20"]));
	const stat = trimForSnapshot(await runGit(cwd, ["diff", `${baseRef}...HEAD`, "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const patch = trimForSnapshot(await runGit(cwd, ["diff", `${baseRef}...HEAD`, "--unified=3", "--find-renames=30%", "--no-color"]));

	return [
		formatSection("[branch]", currentBranch),
		formatSection(`[log ${baseRef}..HEAD]`, log),
		formatSection(`[diff ${baseRef}...HEAD stat]`, stat),
		formatSection(`[diff ${baseRef}...HEAD patch]`, patch),
	].join("\n\n");
}

async function buildReviewSnapshot(cwd: string, params: ReviewRunParams): Promise<{ repoRoot: string; branch: string; targetLabel: string; snapshot: string }> {
	const repoRoot = await detectRepoRoot(cwd);
	const branch = normalizeLines(await tryGit(repoRoot, ["branch", "--show-current"])) || "(detached HEAD)";

	if (params.mode === "working-tree") {
		return {
			repoRoot,
			branch,
			targetLabel: "current uncommitted changes",
			snapshot: await buildWorkingTreeSnapshot(repoRoot),
		};
	}

	if (params.mode === "commit") {
		const commitRef = normalizeLines(params.commitRef ?? "");
		if (!commitRef) throw new Error("commitRef is required when mode=commit");
		return {
			repoRoot,
			branch,
			targetLabel: `commit ${commitRef}`,
			snapshot: await buildCommitSnapshot(repoRoot, commitRef),
		};
	}

	if (params.mode === "branch") {
		const baseRef = normalizeLines(params.baseRef ?? "");
		if (!baseRef) throw new Error("baseRef is required when mode=branch");
		try {
			await ensureRefExists(repoRoot, baseRef);
		} catch {
			throw new Error(`Could not resolve base ref "${baseRef}". Please check the name and make sure it exists.`);
		}
		return {
			repoRoot,
			branch,
			targetLabel: `${branch} vs ${baseRef}`,
			snapshot: await buildBranchSnapshot(repoRoot, baseRef),
		};
	}

	return {
		repoRoot,
		branch,
		targetLabel: "custom review of current uncommitted changes",
		snapshot: await buildWorkingTreeSnapshot(repoRoot),
	};
}

async function performReview(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry"> & { hasUI?: boolean; ui?: { notify(message: string, level?: "info" | "warning" | "error" | "success"): void } }, params: ReviewRunParams): Promise<{ requestId: string; report: string; targetLabel: string; branch: string; repoRoot: string }> {
	const resolvedModel = await resolveReviewModelForRun(ctx, params.model);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolvedModel.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${resolvedModel.model.provider}` : auth.error);
	}

	const { repoRoot, branch, targetLabel, snapshot } = await buildReviewSnapshot(ctx.cwd, params);
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildReviewPrompt({ mode: params.mode, repoRoot, branch, targetLabel, instructions: params.instructions, snapshot }) }],
			timestamp: Date.now(),
		},
	];

	const result = await complete(
		resolvedModel.model,
		{ systemPrompt: REVIEW_SYSTEM_PROMPT, messages },
		{ apiKey: auth.apiKey, headers: auth.headers },
	);

	const reviewText = extractTextMessage(result.content).trim();
	if (!reviewText) {
		throw new Error("Review returned no text");
	}

	const requestId = randomUUID();
	const report = buildDisplayReport({
		mode: params.mode,
		targetLabel,
		branch,
		instructions: params.instructions,
		modelLabel: resolvedModel.modelValue,
		reviewText,
	});

	pi.sendMessage(
		{
			customType: "review-summary",
			content: report,
			display: true,
			details: {
				requestId,
				mode: params.mode,
				targetLabel,
				branch,
				extraFocus: params.instructions ?? "",
				repoRoot,
				model: resolvedModel.modelValue,
			},
		},
		{ triggerTurn: false },
	);

	return { requestId, report, targetLabel, branch, repoRoot };
}

function parseReviewFlags(tokens: string[]): { tokens: string[]; modelOverride?: string } {
	const remaining: string[] = [];
	let modelOverride: string | undefined;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--model" || token === "-m") {
			const next = tokens[index + 1];
			if (next) {
				modelOverride = stripOuterQuotes(next);
				index += 1;
			}
			continue;
		}
		if (token.startsWith("--model=")) {
			modelOverride = stripOuterQuotes(token.slice("--model=".length));
			continue;
		}
		remaining.push(token);
	}

	return { tokens: remaining, modelOverride: normalizeModelValue(modelOverride) };
}

function parseReviewRunArgsFromTokens(tokens: string[], modelOverride?: string): ReviewRunParams | null {
	if (!tokens.length) return null;

	const [modeToken, ...restTokens] = tokens;
	const mode = modeToken.toLowerCase();
	const normalizeToken = (value: string) => stripOuterQuotes(value);

	if (mode === "working-tree" || mode === "wt" || mode === "uncommitted") {
		return {
			mode: "working-tree",
			instructions: restTokens.join(" ").trim() || undefined,
			model: modelOverride,
		};
	}

	if (mode === "commit") {
		const [commitRefRaw, ...focusTokens] = restTokens;
		const commitRef = normalizeToken(commitRefRaw || "");
		if (!commitRef) return { mode: "commit", commitRef: "", model: modelOverride };
		return {
			mode: "commit",
			commitRef,
			instructions: focusTokens.join(" ").trim() || undefined,
			model: modelOverride,
		};
	}

	if (mode === "branch") {
		const [baseRefRaw, ...focusTokens] = restTokens;
		const baseRef = normalizeToken(baseRefRaw || "");
		if (!baseRef) return { mode: "branch", baseRef: "", model: modelOverride };
		return {
			mode: "branch",
			baseRef,
			instructions: focusTokens.join(" ").trim() || undefined,
			model: modelOverride,
		};
	}

	if (mode === "custom") {
		return {
			mode: "custom",
			instructions: restTokens.join(" ").trim() || undefined,
			model: modelOverride,
		};
	}

	return {
		mode: "custom",
		instructions: tokens.slice(1).join(" ").trim() || normalizeToken(modeToken),
		model: modelOverride,
	};
}

function parseReviewCommandInput(rawArgs: string): ParsedReviewCommand | null {
	const tokens = splitReviewArgs(rawArgs);
	if (!tokens.length) return null;
	if (tokens[0]?.toLowerCase() === "model") {
		return { kind: "model", arg: tokens.slice(1).join(" ").trim() || undefined };
	}
	const { tokens: remainingTokens, modelOverride } = parseReviewFlags(tokens);
	return { kind: "run", params: parseReviewRunArgsFromTokens(remainingTokens, modelOverride), modelOverride };
}

function selectionToText(selection: { selectedOptions: string[]; customInput?: string } | undefined): string {
	if (!selection) return "";
	const parts = [...(selection.selectedOptions || []).map((item) => String(item || "").trim()).filter(Boolean)];
	const custom = String(selection.customInput || "").trim();
	if (custom) parts.push(custom);
	return parts.join(", ").trim();
}

async function collectReviewParamsViaAsk(ctx: ExtensionCommandContext, modelOverride?: string): Promise<ReviewRunParams | null> {
	if (!ctx.hasUI) return null;

	const preset = await askSingleQuestionWithInlineNote(ctx.ui, {
		question: "Select a review preset",
		options: [
			{ label: "Uncommitted changes" },
			{ label: "A commit" },
			{ label: "A local branch vs a base branch" },
			{ label: "Custom review instructions" },
		],
		recommended: 0,
	});
	const presetValue = selectionToText(preset);
	if (!presetValue) return null;

	let mode: ReviewMode = "working-tree";
	let commitRef: string | undefined;
	let baseRef: string | undefined;
	let instructions: string | undefined;

	if (presetValue === "A commit") {
		mode = "commit";
		const commit = await askSingleQuestionWithInlineNote(ctx.ui, {
			question: "Which commit should I review?",
			options: [{ label: "HEAD" }, { label: "HEAD~1" }, { label: "HEAD~2" }],
			recommended: 1,
		});
		commitRef = selectionToText(commit);
		if (!commitRef) return null;
	} else if (presetValue === "A local branch vs a base branch") {
		mode = "branch";
		const base = await askSingleQuestionWithInlineNote(ctx.ui, {
			question: "Which base ref should I compare against?",
			options: [{ label: "main" }, { label: "master" }, { label: "develop" }, { label: "origin/main" }],
			recommended: 0,
		});
		baseRef = selectionToText(base);
		if (!baseRef) return null;
	} else if (presetValue === "Custom review instructions") {
		mode = "custom";
		const custom = await askSingleQuestionWithInlineNote(ctx.ui, {
			question: "What kind of custom review should I run?",
			options: [
				{ label: "Risky changes" },
				{ label: "Subtle bugs" },
				{ label: "Missing tests" },
				{ label: "Dependency review" },
			],
			recommended: 0,
		});
		instructions = selectionToText(custom);
		if (!instructions) return null;
	}

	const focusResult = await askQuestionsWithTabs(ctx.ui, [{
		id: "focus",
		question: mode === "custom" ? "Anything else to focus on?" : "What should I focus on?",
		options: [
			{ label: "Bugs" },
			{ label: "Security" },
			{ label: "Performance" },
			{ label: "Tests" },
			{ label: "Error handling" },
			{ label: "New dependencies" },
		],
		multi: true,
	}]);
	if (focusResult.cancelled) return null;
	const focus = selectionToText(focusResult.selections?.[0]);
	if (focus) {
		instructions = instructions ? `${instructions}, ${focus}` : focus;
	}

	let model = normalizeModelValue(modelOverride);
	if (!model) {
		const selectedModel = await chooseReviewModelSelector(ctx);
		if (selectedModel === null) return null;
		model = normalizeModelValue(selectedModel);
	}

	return { mode, commitRef, baseRef, instructions, model };
}

const CLEAR_STORED_REVIEW_MODEL = "__clear_review_model__";

async function promptForStoredReviewModel(ctx: ExtensionCommandContext): Promise<string | undefined | null> {
	if (!ctx.hasUI) return undefined;
	const available = await ctx.modelRegistry.getAvailable();
	const options: string[] = [];
	const optionMap = new Map<string, string | undefined>();
	const currentStored = await getStoredReviewModelValue();
	const seenValues = new Set<string>();

	if (ctx.model) {
		const sessionValue = formatModelValue(ctx.model);
		const label = `Current session model · ${sessionValue}`;
		optionMap.set(label, sessionValue);
		options.push(label);
		seenValues.add(sessionValue);
	}

	const sortedModels = [...available].sort((a, b) => formatModelOptionLabel(a).localeCompare(formatModelOptionLabel(b)));
	for (const model of sortedModels) {
		const value = formatModelValue(model);
		if (seenValues.has(value)) continue;
		const label = formatModelOptionLabel(model);
		optionMap.set(label, value);
		options.push(label);
		seenValues.add(value);
	}

	if (currentStored) {
		const clearLabel = `Clear saved review default (currently ${currentStored})`;
		optionMap.set(clearLabel, CLEAR_STORED_REVIEW_MODEL);
		options.push(clearLabel);
	}

	if (options.length === 0) return undefined;
	const selected = await ctx.ui.select("Set the default model for /review", options);
	if (selected === undefined) return null;
	return optionMap.get(selected);
}

async function handleReviewModelCommand(ctx: ExtensionCommandContext, rawArg?: string): Promise<void> {
	const normalizedArg = normalizeModelValue(rawArg);
	if (!normalizedArg) {
		const picked = await promptForStoredReviewModel(ctx);
		if (picked === null) {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (picked === undefined) {
			const current = await getStoredReviewModelValue();
			if (ctx.hasUI) ctx.ui.notify(current ? `Default review model: ${current}` : "No saved review model. /review falls back to the current session model.", "info");
			return;
		}
		if (picked === CLEAR_STORED_REVIEW_MODEL) {
			await setStoredReviewModelValue(undefined);
			if (ctx.hasUI) ctx.ui.notify("Cleared the saved review model. /review will use the current session model unless you override it.", "info");
			return;
		}
		await setStoredReviewModelValue(picked);
		if (ctx.hasUI) ctx.ui.notify(`Saved ${picked} as the default model for /review.`, "info");
		return;
	}

	const lowered = normalizedArg.toLowerCase();
	if (lowered === "show" || lowered === "status") {
		const current = await getStoredReviewModelValue();
		if (ctx.hasUI) ctx.ui.notify(current ? `Default review model: ${current}` : "No saved review model. /review falls back to the current session model.", "info");
		return;
	}
	if (lowered === "clear" || lowered === "none" || lowered === "session" || lowered === "current") {
		await setStoredReviewModelValue(undefined);
		if (ctx.hasUI) ctx.ui.notify("Cleared the saved review model. /review will use the current session model unless you override it.", "info");
		return;
	}

	const resolved = await resolveSpecificReviewModel(ctx, normalizedArg);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${resolved.model.provider}` : auth.error);
	}
	await setStoredReviewModelValue(resolved.modelValue);
	if (ctx.hasUI) ctx.ui.notify(`Saved ${resolved.modelValue} as the default model for /review.`, "info");
}

function reviewUsage(): string {
	return [
		"Usage:",
		"/review",
		"/review [--model <provider/id>|session] working-tree [extra focus]",
		"/review [--model <provider/id>|session] commit <ref> [extra focus]",
		"/review [--model <provider/id>|session] branch <base-ref> [extra focus]",
		"/review [--model <provider/id>|session] custom <instructions>",
		"/review model",
		"/review model <provider/id>",
		"/review model clear",
	].join("\n");
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Review uncommitted changes, a commit, or a branch diff. Supports a separate default review model and per-run model overrides.",
		executeImmediately: true,
		handler: async (args, ctx) => {
			const parsedCommand = parseReviewCommandInput(args);
			if (parsedCommand?.kind === "model") {
				try {
					await handleReviewModelCommand(ctx, parsedCommand.arg);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			let parsed = parsedCommand?.params ?? null;
			if (!parsed) {
				parsed = await collectReviewParamsViaAsk(ctx, parsedCommand?.kind === "run" ? parsedCommand.modelOverride : undefined);
				if (!parsed) {
					if (ctx.hasUI) ctx.ui.notify("Cancelled", "info");
					return;
				}
			}

			if ((parsed.mode === "commit" && !normalizeLines(parsed.commitRef ?? "")) || (parsed.mode === "branch" && !normalizeLines(parsed.baseRef ?? "")) || (parsed.mode === "custom" && !normalizeLines(parsed.instructions ?? ""))) {
				if (ctx.hasUI) ctx.ui.notify(reviewUsage(), "warning");
				return;
			}

			try {
				await performReview(pi, ctx, parsed);
				if (ctx.hasUI) ctx.ui.notify("Review summary posted back into the session.", "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	} as any);
}
