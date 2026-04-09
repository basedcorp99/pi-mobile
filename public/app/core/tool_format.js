import { safeStringify } from "./stringify.js";

export function toolPreviewLines(toolName) {
	if (toolName === "bash") return 5;
	if (toolName === "read" || toolName === "write") return 10;
	if (toolName === "grep") return 15;
	return 20;
}

export function toolCallToText(toolName, args) {
	if (!args || typeof args !== "object") return safeStringify(args);
	if (toolName === "bash") {
		const cmd = typeof args.command === "string" ? args.command : safeStringify(args);
		return `$ ${cmd}`;
	}
	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : null;
		const p = typeof args.path === "string" ? args.path : ".";
		if (pattern) return `grep /${pattern}/ in ${p}`;
		return "grep";
	}
	if (toolName === "find") {
		const pattern = typeof args.pattern === "string" ? args.pattern : null;
		const p = typeof args.path === "string" ? args.path : ".";
		if (pattern) return `find ${pattern} in ${p}`;
		return "find";
	}
	if (toolName === "ls") {
		const p = typeof args.path === "string" ? args.path : ".";
		return `ls ${p}`;
	}
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
		if (p) return `${toolName} ${p}`;
	}
	return toolName;
}

export function toolResultExtractImages(result) {
	if (typeof result === "string" || !result || typeof result !== "object") return [];
	const content = Array.isArray(result.content) ? result.content : null;
	if (!content) return [];
	const images = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string") {
			images.push({ mimeType: block.mimeType, data: block.data });
		}
	}
	return images;
}

export function toolResultToText(result) {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return safeStringify(result);

	const content = Array.isArray(result.content) ? result.content : null;
	if (!content) return safeStringify(result);

	const out = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			out.push(block.text);
		} else if (block.type === "image" && typeof block.mimeType === "string") {
			// Images are rendered separately via toolResultExtractImages
		}
	}
	return out.join("\n").trimEnd();
}

