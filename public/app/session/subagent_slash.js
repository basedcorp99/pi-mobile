import { extractTextContent } from "./content.js";

export const SUBAGENT_SLASH_RESULT_TYPE = "subagent-slash-result";

function isRunningResult(result) {
	return result && result.progress && result.progress.status === "running";
}

function isFailedResult(result) {
	return Boolean(result) && Number(result.exitCode || 0) !== 0 && !isRunningResult(result);
}

function isCompletedResult(result) {
	return Boolean(result) && Number(result.exitCode || 0) === 0 && !isRunningResult(result);
}

/** Get live AgentProgress for a single result index. Top-level progress array
 *  is used during streaming; the per-result .progress field is used in final messages. */
function getProgress(resultDetails, results, index) {
	const topLevel = Array.isArray(resultDetails?.progress) ? resultDetails.progress[index] : null;
	const perResult = results[index]?.progress ?? null;
	return topLevel || perResult || null;
}

/** Extract final text output from a SingleResult (finalOutput field or last assistant message). */
function extractAgentOutput(result) {
	if (result?.finalOutput) return result.finalOutput;
	const messages = Array.isArray(result?.messages) ? result.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part?.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

export function parseSubagentSlashMessage(message) {
	const isCustomSubagent = Boolean(message && message.customType === SUBAGENT_SLASH_RESULT_TYPE);
	const isToolSubagent = Boolean(message && message.role === "toolResult" && message.toolName === "subagent");
	if (!isCustomSubagent && !isToolSubagent) return null;

	const details = message?.details;
	const requestId = typeof details?.requestId === "string"
		? details.requestId
		: typeof message?.toolCallId === "string"
			? message.toolCallId
			: "";
	const result = details?.result
		|| (isToolSubagent ? { content: message.content, details: message.details } : null);
	const resultDetails = result?.details
		|| details?.details
		|| (Array.isArray(details?.results) ? details : null);
	const results = Array.isArray(resultDetails?.results) ? resultDetails.results : null;
	if (!requestId || !results) return null;

	const progress = Array.isArray(resultDetails?.progress) ? resultDetails.progress : [];
	const hasRunning =
		progress.some((entry) => entry && entry.status === "running") ||
		results.some((entry) => isRunningResult(entry));
	const failed = results.filter((entry) => isFailedResult(entry)).length;
	const completed = results.filter((entry) => isCompletedResult(entry)).length;
	const total = results.length;

	const status = hasRunning ? "pending" : failed > 0 ? "error" : "success";
	const mode = typeof resultDetails?.mode === "string" ? resultDetails.mode : "single";
	const firstAgent = typeof results[0]?.agent === "string" ? results[0].agent : "subagent";
	const title = mode === "chain"
		? `subagent chain (${resultDetails?.totalSteps ?? total})`
		: mode === "parallel"
			? `subagent parallel (${total})`
			: `subagent ${firstAgent}`;

	const summaryParts = [];
	if (resultDetails?.context === "fork") summaryParts.push("[fork]");
	if (hasRunning) {
		const step = typeof resultDetails?.currentStepIndex === "number" ? resultDetails.currentStepIndex + 1 : undefined;
		const stepTotal = typeof resultDetails?.totalSteps === "number" ? resultDetails.totalSteps : total;
		if (step && stepTotal > 1) summaryParts.push(`${step}/${stepTotal}`);
		summaryParts.push("running");
	} else if (total > 1) {
		summaryParts.push(`${completed}/${total} ok`);
	} else if (failed > 0) {
		summaryParts.push("failed");
	} else {
		summaryParts.push("done");
	}

	const body = extractTextContent(result?.content)
		|| extractTextContent(message.content)
		|| (typeof message.content === "string" ? message.content : "");

	// --- Rich per-agent data ---
	const agents = results.map((r, i) => {
		const p = getProgress(resultDetails, results, i);
		const pStatus = p?.status ?? null;
		const isRunning = pStatus === "running" || isRunningResult(r);
		// exitCode -1 = still running/queued placeholder
		const isPending = r.exitCode === -1 && !isRunning;
		const agentStatus = isRunning
			? "running"
			: isPending
				? "pending"
				: isFailedResult(r)
					? "failed"
					: "completed";

		return {
			name: typeof r.agent === "string" ? r.agent : "agent",
			status: agentStatus,
			currentTool: p?.currentTool ?? null,
			currentToolArgs: p?.currentToolArgs ?? null,
			recentTools: Array.isArray(p?.recentTools) ? p.recentTools.slice(-3) : [],
			toolCount: p?.toolCount ?? 0,
			tokens: p?.tokens ?? 0,
			durationMs: p?.durationMs ?? 0,
			// Only include output for completed/failed agents
			output: (agentStatus === "completed" || agentStatus === "failed") ? extractAgentOutput(r) : "",
		};
	});

	// Convenience top-level stats for single-agent mode (first agent)
	const a0 = agents[0] ?? {};

	return {
		requestId,
		status,
		title,
		summary: summaryParts.join(" · "),
		body,
		mode,
		total,
		completed,
		failed,
		hasRunning,
		// Rich data
		agents,
		// Single-agent shortcuts (same as agents[0] fields)
		currentTool: a0.currentTool ?? null,
		currentToolArgs: a0.currentToolArgs ?? null,
		recentTools: a0.recentTools ?? [],
		toolCount: a0.toolCount ?? 0,
		tokens: a0.tokens ?? 0,
		durationMs: a0.durationMs ?? 0,
	};
}
