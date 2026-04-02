self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { body: event.data ? event.data.text() : '' };
	}

	const title = data.title || 'pi';
	const body = data.body || 'New message';
	const url = data.url || '/';

	const options = {
		body,
		icon: data.icon || '/icon-192.png',
		badge: data.badge || '/apple-touch-icon.png',
		tag: data.tag || 'pi-session',
		data: { url, sessionId: data.sessionId || null },
		renotify: true,
		silent: false,
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = event.notification?.data?.url || '/';
	event.waitUntil((async () => {
		const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		for (const client of clients) {
			if ('focus' in client) {
				await client.focus();
				if ('navigate' in client && url) {
					try { await client.navigate(url); } catch {}
				}
				return;
			}
		}
		await self.clients.openWindow(url);
	})());
});
