import { complete, StringEnum, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { askSingleQuestionWithInlineNote } from "pi-ask-tool-extension/src/ask-inline-ui.ts";
import { askQuestionsWithTabs } from "pi-ask-tool-extension/src/ask-tabs-ui.ts";
import { readFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const execFile = promisify(execFileCb);

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
});

type ReviewRunParams = Static<typeof ReviewRunSchema>;

function trimText(value: string, maxChars: number): { text: string; truncated: boolean } {
	if (value.length <= maxChars) return { text: value, truncated: false };
	return {
		text: `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} characters]`,
		truncated: true,
	};
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
	reviewText: string;
}): string {
	return [
		`## Review: ${options.targetLabel}`,
		`- Mode: ${options.mode}`,
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

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
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

async function collectUntrackedSnippets(cwd: string, maxFiles = 5, totalCharBudget = 24_000): Promise<string> {
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
	const status = normalizeLines(await tryGit(cwd, ["status", "--short", "--untracked-files=normal"]));
	const branch = normalizeLines(await tryGit(cwd, ["branch", "--show-current"])) || "(detached HEAD)";
	const stagedStat = normalizeLines(await tryGit(cwd, ["diff", "--cached", "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const unstagedStat = normalizeLines(await tryGit(cwd, ["diff", "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const stagedPatch = normalizeLines(await tryGit(cwd, ["diff", "--cached", "--unified=3", "--find-renames=30%", "--no-color"]));
	const unstagedPatch = normalizeLines(await tryGit(cwd, ["diff", "--unified=3", "--find-renames=30%", "--no-color"]));
	const untrackedSnippets = await collectUntrackedSnippets(cwd);

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
	const show = normalizeLines(await runGit(cwd, ["show", "--stat", "--summary", "--find-renames=30%", "--unified=3", "--no-color", commitRef]));
	return formatSection(`[git show ${commitRef}]`, show);
}

async function buildBranchSnapshot(cwd: string, baseRef: string): Promise<string> {
	const currentBranch = normalizeLines(await tryGit(cwd, ["branch", "--show-current"])) || "(detached HEAD)";
	const log = normalizeLines(await tryGit(cwd, ["log", "--oneline", "--decorate", `${baseRef}..HEAD`, "--max-count=20"]));
	const stat = normalizeLines(await runGit(cwd, ["diff", `${baseRef}...HEAD`, "--stat", "--summary", "--find-renames=30%", "--no-color"]));
	const patch = normalizeLines(await runGit(cwd, ["diff", `${baseRef}...HEAD`, "--unified=3", "--find-renames=30%", "--no-color"]));

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

async function performReview(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">, params: ReviewRunParams): Promise<{ requestId: string; report: string; targetLabel: string; branch: string; repoRoot: string }> {
	if (!ctx.model) {
		throw new Error("No model selected");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
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
		ctx.model,
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
			},
		},
		{ triggerTurn: false },
	);

	return { requestId, report, targetLabel, branch, repoRoot };
}

function parseInlineReviewArgs(rawArgs: string): ReviewRunParams | null {
	const args = normalizeLines(rawArgs);
	if (!args) return null;

	const [modeToken, ...restTokens] = args.split(/\s+/);
	const mode = modeToken.toLowerCase();

	if (mode === "working-tree" || mode === "wt" || mode === "uncommitted") {
		return {
			mode: "working-tree",
			instructions: restTokens.join(" ").trim() || undefined,
		};
	}

	if (mode === "commit") {
		const [commitRef, ...focusTokens] = restTokens;
		if (!commitRef) return { mode: "commit", commitRef: "" };
		return {
			mode: "commit",
			commitRef,
			instructions: focusTokens.join(" ").trim() || undefined,
		};
	}

	if (mode === "branch") {
		const [baseRef, ...focusTokens] = restTokens;
		if (!baseRef) return { mode: "branch", baseRef: "" };
		return {
			mode: "branch",
			baseRef,
			instructions: focusTokens.join(" ").trim() || undefined,
		};
	}

	if (mode === "custom") {
		return {
			mode: "custom",
			instructions: restTokens.join(" ").trim() || undefined,
		};
	}

	return { mode: "custom", instructions: args };
}

function selectionToText(selection: { selectedOptions: string[]; customInput?: string } | undefined): string {
	if (!selection) return "";
	const parts = [...(selection.selectedOptions || []).map((item) => String(item || "").trim()).filter(Boolean)];
	const custom = String(selection.customInput || "").trim();
	if (custom) parts.push(custom);
	return parts.join(", ").trim();
}

async function collectReviewParamsViaAsk(ctx: ExtensionCommandContext): Promise<ReviewRunParams | null> {
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

	return { mode, commitRef, baseRef, instructions };
}

function reviewUsage(): string {
	return [
		"Usage:",
		"/review",
		"/review working-tree [extra focus]",
		"/review commit <ref> [extra focus]",
		"/review branch <base-ref> [extra focus]",
		"/review custom <instructions>",
	].join("\n");
}

export default function reviewExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "review_run",
		label: "Review Run",
		description: "Run a fresh-context review of the current working tree, a commit, or a branch diff and post a summary back into the session",
		parameters: ReviewRunSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { requestId, targetLabel } = await performReview(pi, ctx, params);
				return {
					content: [{ type: "text", text: `Posted review summary for ${targetLabel}. requestId=${requestId}` }],
					details: { requestId, mode: params.mode, targetLabel },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { mode: params.mode },
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("review", {
		description: "Review uncommitted changes, a commit, or a branch diff. With no args it uses the ask tool for setup.",
		executeImmediately: true,
		handler: async (args, ctx) => {
			let parsed = parseInlineReviewArgs(args);
			if (!parsed) {
				parsed = await collectReviewParamsViaAsk(ctx);
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
