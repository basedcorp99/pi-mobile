export function isPhoneLike() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return (
		window.matchMedia("(hover: none) and (pointer: coarse) and (max-width: 740px)").matches ||
		window.matchMedia("(hover: none) and (pointer: coarse) and (max-height: 740px)").matches
	);
}

export function isStandalonePwa() {
	if (typeof window === "undefined") return false;
	try {
		if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
	} catch {
		// ignore
	}
	try {
		if (window.navigator?.standalone === true) return true;
	} catch {
		// ignore
	}
	return false;
}

