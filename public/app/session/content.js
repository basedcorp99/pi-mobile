export function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

export function parseAssistantContent(content) {
	const result = { thinking: "", text: "", toolCalls: [] };

	if (typeof content === "string") {
		result.text = content;
		return result;
	}
	if (!Array.isArray(content)) {
		return result;
	}

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "thinking" && typeof block.thinking === "string") {
			result.thinking += block.thinking;
		} else if (block.type === "text" && typeof block.text === "string") {
			result.text += block.text;
		} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
			result.toolCalls.push({
				id: block.id,
				name: block.name,
				arguments: block.arguments,
			});
		}
	}
	return result;
}

export function getAssistantTerminalNotice(message) {
	if (!message || typeof message !== "object") return null;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
	if (stopReason !== "aborted" && stopReason !== "error") return null;

	const content = Array.isArray(message.content) ? message.content : [];
	const hasToolCalls = content.some((block) => block && typeof block === "object" && block.type === "toolCall");
	if (hasToolCalls) return null;

	if (stopReason === "aborted") {
		const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
		return {
			kind: "error",
			text: raw && raw !== "Request was aborted" ? raw : "Operation aborted",
		};
	}

	const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	return {
		kind: "error",
		text: raw ? `Error: ${raw}` : "Error",
	};
}

