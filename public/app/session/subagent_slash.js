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

export function parseSubagentSlashMessage(message) {
	if (!message || message.customType !== SUBAGENT_SLASH_RESULT_TYPE) return null;

	const details = message.details;
	const requestId = typeof details?.requestId === "string" ? details.requestId : "";
	const result = details?.result;
	const resultDetails = result?.details;
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
	};
}
