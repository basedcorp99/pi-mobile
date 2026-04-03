self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

function resolveNotificationTarget(data) {
	const sessionId = typeof data?.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : null;
	let url = typeof data?.url === 'string' && data.url.trim() ? data.url.trim() : '/';

	try {
		const parsed = new URL(url, self.location.origin);
		if (sessionId && !parsed.searchParams.get('session')) {
			parsed.searchParams.set('session', sessionId);
		}
		url = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		url = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
	}

	return { url, sessionId };
}

function clientMatchesTarget(client, target) {
	try {
		const parsed = new URL(client.url);
		if (target.sessionId) return parsed.searchParams.get('session') === target.sessionId;
		return `${parsed.pathname}${parsed.search}${parsed.hash}` === target.url;
	} catch {
		return false;
	}
}

function pickClient(clients, target) {
	if (!Array.isArray(clients) || clients.length === 0) return null;
	return clients.find((client) => clientMatchesTarget(client, target)) || clients[0];
}

async function postOpenSessionMessage(client, target) {
	try {
		client.postMessage({
			type: 'open_notification_session',
			sessionId: target.sessionId,
			url: target.url,
		});
	} catch {
		// ignore
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

self.addEventListener('push', (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { body: event.data ? event.data.text() : '' };
	}

	const target = resolveNotificationTarget(data);
	const title = data.title || 'pi';
	const body = data.body || 'New message';

	const options = {
		body,
		icon: data.icon || '/icon-192.png',
		badge: data.badge || '/apple-touch-icon.png',
		tag: data.tag || 'pi-session',
		data: target,
		renotify: true,
		silent: false,
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = resolveNotificationTarget(event.notification?.data || {});

	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		const existingClient = pickClient(windows, target);
		if (existingClient) {
			try {
				await existingClient.focus();
			} catch {
				// ignore
			}
			if (!clientMatchesTarget(existingClient, target) && 'navigate' in existingClient && target.url) {
				try {
					await existingClient.navigate(target.url);
				} catch {
					// ignore
				}
			}
			await postOpenSessionMessage(existingClient, target);
			return;
		}

		const opened = await self.clients.openWindow(target.url);
		if (opened) {
			try {
				await opened.focus();
			} catch {
				// ignore
			}
			await postOpenSessionMessage(opened, target);
			return;
		}

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await delay(300);
			const retryClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const retryClient = pickClient(retryClients, target);
			if (!retryClient) continue;
			await postOpenSessionMessage(retryClient, target);
			break;
		}
	})());
});
