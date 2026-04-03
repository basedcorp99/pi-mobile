import { extractTextContent } from "./content.js";

export function parseReviewSummaryMessage(message) {
	if (!message || message.customType !== "review-summary") return null;
	const details = message.details && typeof message.details === "object" ? message.details : {};
	const requestId = typeof details.requestId === "string" && details.requestId.trim() ? details.requestId.trim() : undefined;
	const mode = typeof details.mode === "string" ? details.mode : "review";
	const target = typeof details.targetLabel === "string" ? details.targetLabel : "code review";
	const branch = typeof details.branch === "string" ? details.branch : "";
	const focus = typeof details.extraFocus === "string" ? details.extraFocus.trim() : "";
	const summaryParts = [mode, target];
	if (branch) summaryParts.push(branch);
	if (focus) summaryParts.push(`focus: ${focus}`);
	return {
		requestId,
		title: "Review summary",
		summary: summaryParts.filter(Boolean).join(" · "),
		body: extractTextContent(message.content) || (typeof message.content === "string" ? message.content : ""),
	};
}

export function applyReviewSummaryUpdate(entries, message) {
	const data = parseReviewSummaryMessage(message);
	if (!data) return { applied: false, updated: false, index: -1 };

	if (!Array.isArray(entries)) return { applied: true, updated: false, index: -1, entry: data };

	if (!data.requestId) {
		entries.push(data);
		return { applied: true, updated: false, index: entries.length - 1, entry: data };
	}

	const index = entries.findIndex((entry) => entry && entry.requestId === data.requestId);
	if (index >= 0) {
		entries[index] = data;
		return { applied: true, updated: true, index, entry: data };
	}

	entries.push(data);
	return { applied: true, updated: false, index: entries.length - 1, entry: data };
}
