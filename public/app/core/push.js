function base64ToUint8Array(base64String) {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
	return output;
}

function canUsePush() {
	return (
		typeof window !== "undefined" &&
		window.isSecureContext &&
		navigator.serviceWorker &&
		typeof Notification !== "undefined" &&
		"PushManager" in window
	);
}

export function installPushNotifications({ api, btnNotify, lblNotify, onNotice }) {
	let registration = null;
	let subscribed = false;
	let supported = canUsePush();

	function setButtonState() {
		if (!btnNotify) return;
		const blocked = supported && Notification.permission === "denied";
		btnNotify.disabled = !supported || blocked;
		btnNotify.classList.toggle("active", subscribed);
		btnNotify.setAttribute("aria-pressed", subscribed ? "true" : "false");
		if (lblNotify) {
			if (!supported) lblNotify.textContent = "off";
			else if (blocked) lblNotify.textContent = "blocked";
			else lblNotify.textContent = subscribed ? "on" : "off";
		}
		btnNotify.title = blocked ? "Notifications blocked in browser settings" : subscribed ? "Push notifications on" : "Push notifications off";
	}

	async function ensureRegistration() {
		if (!supported) return null;
		if (registration) return registration;
		registration = await navigator.serviceWorker.register("/sw.js?v=20260401b", { scope: "/" });
		return registration;
	}

	async function syncSubscriptionWithServer() {
		if (!registration) return false;
		const existing = await registration.pushManager.getSubscription();
		if (!existing) {
			subscribed = false;
			setButtonState();
			return false;
		}

		// Check if the subscription's applicationServerKey matches the current server key
		try {
			const { publicKey } = await api.getJson("/api/push/public-key");
			const currentKey = existing.options?.applicationServerKey;
			if (currentKey) {
				const keyBytes = new Uint8Array(currentKey);
				const expectedBytes = base64ToUint8Array(publicKey);
				if (keyBytes.length !== expectedBytes.length || !keyBytes.every((b, i) => b === expectedBytes[i])) {
					// VAPID key mismatch — unsubscribe and resubscribe
					await existing.unsubscribe().catch(() => {});
					const newSub = await registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: expectedBytes,
					});
					await api.postJson("/api/push/subscribe", { subscription: newSub.toJSON() });
					subscribed = true;
					setButtonState();
					return true;
				}
			}
		} catch {
			// If key check fails, proceed with normal sync
		}

		await api.postJson("/api/push/subscribe", { subscription: existing.toJSON() });
		subscribed = true;
		setButtonState();
		return true;
	}

	async function subscribe() {
		if (!supported) {
			onNotice?.("Push notifications aren't supported here.", "error");
			return false;
		}
		if (Notification.permission === "denied") {
			onNotice?.("Notifications are blocked. Enable them in browser settings.", "error");
			setButtonState();
			return false;
		}
		const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
		if (permission !== "granted") {
			setButtonState();
			return false;
		}

		const reg = await ensureRegistration();
		if (!reg) return false;

		const { publicKey } = await api.getJson("/api/push/public-key");
		const serverKey = base64ToUint8Array(publicKey);

		let sub = await reg.pushManager.getSubscription();
		if (sub) {
			// Check for VAPID key mismatch
			const currentKey = sub.options?.applicationServerKey;
			if (currentKey) {
				const keyBytes = new Uint8Array(currentKey);
				if (keyBytes.length !== serverKey.length || !keyBytes.every((b, i) => b === serverKey[i])) {
					await sub.unsubscribe().catch(() => {});
					sub = null;
				}
			}
		}
		if (!sub) {
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: serverKey,
			});
		}

		await api.postJson("/api/push/subscribe", { subscription: sub.toJSON() });
		subscribed = true;
		setButtonState();
		onNotice?.("Push notifications enabled.", "info");
		return true;
	}

	async function unsubscribe() {
		if (!supported || !registration) {
			subscribed = false;
			setButtonState();
			return false;
		}
		const sub = await registration.pushManager.getSubscription();
		if (sub) {
			await api.postJson("/api/push/unsubscribe", { endpoint: sub.endpoint });
			await sub.unsubscribe().catch(() => {});
		}
		subscribed = false;
		setButtonState();
		onNotice?.("Push notifications disabled.", "info");
		return true;
	}

	async function toggle() {
		if (subscribed) return unsubscribe();
		return subscribe();
	}

	async function start() {
		supported = canUsePush();
		setButtonState();
		if (!supported) return;
		try {
			await ensureRegistration();
			if (Notification.permission === "granted") {
				const synced = await syncSubscriptionWithServer();
				if (!synced) {
					// Permission granted but no subscription — auto-subscribe
					await subscribe();
				}
			} else {
				setButtonState();
			}
		} catch (error) {
			supported = false;
			setButtonState();
			onNotice?.(error instanceof Error ? error.message : String(error), "error");
		}
	}

	if (btnNotify) {
		btnNotify.addEventListener("click", () => { void toggle(); });
	}

	return {
		start,
		toggle,
		subscribe,
		disable: unsubscribe,
		isSupported: () => supported,
		isSubscribed: () => subscribed,
	};
}
