const MAX_SIDE = 1600;
const MAX_BYTES_HINT = 4_000_000;

function bytesToBase64(dataUrl) {
	const comma = dataUrl.indexOf(",");
	return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function formatBytes(bytes) {
	const n = Number(bytes || 0);
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${Math.round(n / 1024)} KB`;
	return `${n} B`;
}

function supportedOutputMime(mimeType) {
	if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") return mimeType;
	return "image/jpeg";
}

async function readAsDataURL(blob) {
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
		reader.onload = () => resolve(String(reader.result || ""));
		reader.readAsDataURL(blob);
	});
}

async function loadImage(file) {
	return await new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to decode image"));
		};
		img.src = url;
	});
}

async function canvasToBlob(canvas, mimeType, quality) {
	return await new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), mimeType, quality);
	});
}

async function downscaleImage(file) {
	const img = await loadImage(file);
	const width = img.naturalWidth || img.width || 0;
	const height = img.naturalHeight || img.height || 0;
	if (!width || !height) {
		throw new Error("Image has invalid dimensions");
	}

	const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height);
	if (scale >= 1 && file.size <= MAX_BYTES_HINT) {
		return { blob: file, width, height, resized: false };
	}

	const outWidth = Math.max(1, Math.round(width * scale));
	const outHeight = Math.max(1, Math.round(height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = outWidth;
	canvas.height = outHeight;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return { blob: file, width, height, resized: false };
	}

	ctx.drawImage(img, 0, 0, outWidth, outHeight);
	const mimeType = supportedOutputMime(file.type || "image/jpeg");
	let quality = mimeType === "image/jpeg" || mimeType === "image/webp" ? 0.86 : undefined;
	let blob = await canvasToBlob(canvas, mimeType, quality);
	if (!blob && mimeType !== "image/jpeg") {
		blob = await canvasToBlob(canvas, "image/jpeg", 0.86);
	}
	if (!blob) {
		return { blob: file, width, height, resized: false };
	}

	// If the output is still large, try one smaller quality pass for JPEG/WebP.
	if (blob.size > MAX_BYTES_HINT && (blob.type === "image/jpeg" || blob.type === "image/webp")) {
		const secondPass = await canvasToBlob(canvas, blob.type, 0.72);
		if (secondPass && secondPass.size < blob.size) {
			blob = secondPass;
		}
	}

	return { blob, width: outWidth, height: outHeight, resized: true };
}

export async function fileToImageContent(file) {
	if (!(file instanceof File)) {
		throw new Error("Invalid file");
	}
	if (!String(file.type || "").startsWith("image/")) {
		throw new Error("Only image files are supported");
	}

	let blob;
	let width = null;
	let height = null;
	try {
		const result = await downscaleImage(file);
		blob = result.blob;
		width = result.width;
		height = result.height;
	} catch {
		blob = file;
	}

	const dataUrl = await readAsDataURL(blob);
	const base64 = bytesToBase64(dataUrl);
	const mimeType = blob.type || file.type || "image/jpeg";
	const labelParts = [];
	labelParts.push(file.name || "image");
	if (width && height) labelParts.push(`${width}×${height}`);
	labelParts.push(formatBytes(blob.size));
	if (blob !== file) labelParts.push("resized");

	return {
		content: {
			type: "image",
			data: base64,
			mimeType,
		},
		label: labelParts.join(" • "),
	};
}
