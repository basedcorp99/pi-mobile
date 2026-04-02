import { safeRandomUUID } from "./uuid.js";

function safeLocalStorageGet(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalStorageSet(key, value) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// ignore (private mode / restricted storage)
	}
}

export function getOrCreateClientId() {
	const key = "piWebClientId";
	let id = safeLocalStorageGet(key);
	if (!id) {
		id = safeRandomUUID();
		safeLocalStorageSet(key, id);
	}
	return id;
}

export function getToken() {
	const key = "piWebToken";
	const url = new URL(window.location.href);
	const qp = url.searchParams.get("token");
	if (qp && qp.trim().length > 0) {
		const trimmed = qp.trim();
		safeLocalStorageSet(key, trimmed);
		// Only strip the token from the URL once we know it persisted.
		// Some mobile/in-app browsers restrict storage; keeping the token in the URL is
		// better than silently breaking reloads.
		if (safeLocalStorageGet(key) === trimmed) {
			url.searchParams.delete("token");
			window.history.replaceState(null, "", url.toString());
		}
		return trimmed;
	}
	return safeLocalStorageGet(key);
}

export function getFaceIdEnabled() {
	const key = "piWebFaceIdEnabled";
	const url = new URL(window.location.href);
	const qp = url.searchParams.get("faceid");
	if (qp === "1" || qp === "true") {
		safeLocalStorageSet(key, "1");
		url.searchParams.delete("faceid");
		window.history.replaceState(null, "", url.toString());
		return true;
	}
	if (qp === "0" || qp === "false") {
		safeLocalStorageSet(key, "0");
		url.searchParams.delete("faceid");
		window.history.replaceState(null, "", url.toString());
		return false;
	}
	return safeLocalStorageGet(key) === "1";
}

export function getThemePreference() {
	return safeLocalStorageGet("pi-web-theme") === "light" ? "light" : "dark";
}

export function setThemePreference(theme) {
	safeLocalStorageSet("pi-web-theme", theme === "light" ? "light" : "dark");
}

export function getSendOnEnterEnabled() {
	const stored = safeLocalStorageGet("piWebSendOnEnter");
	if (stored === "0") return false;
	return true;
}

export function setSendOnEnterEnabled(enabled) {
	safeLocalStorageSet("piWebSendOnEnter", enabled ? "1" : "0");
}

export function getFontScalePreference() {
	const raw = Number(safeLocalStorageGet("piWebFontScale"));
	if (!Number.isFinite(raw)) return 1;
	return Math.max(0.85, Math.min(1.35, Math.round(raw * 100) / 100));
}

export function setFontScalePreference(scale) {
	const normalized = Math.max(0.85, Math.min(1.35, Math.round(Number(scale || 1) * 100) / 100));
	safeLocalStorageSet("piWebFontScale", String(normalized));
}

