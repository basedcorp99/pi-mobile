import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import webpush from "web-push";

interface StoredPushData {
	version: 1;
	vapid: {
		publicKey: string;
		privateKey: string;
		subject: string;
	};
	subscriptions: Array<PushSubscriptionJSON & { createdAt: string; updatedAt: string }>;
}

export interface PushNotificationPayload {
	title: string;
	body: string;
	url?: string;
	sessionId?: string;
	sessionName?: string;
	icon?: string;
	badge?: string;
	tag?: string;
}

export const DEFAULT_PUSH_SUBJECT = "mailto:root@localhost";

function safeParse<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function isLoopbackHost(host: string | null | undefined): boolean {
	const normalized = (host || "").trim().toLowerCase();
	if (!normalized) return false;
	return (
		normalized === "localhost" ||
		normalized === "localhost.localdomain" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized.startsWith("127.")
	);
}

function subjectNeedsUpgrade(subject: string | null | undefined): boolean {
	const normalized = typeof subject === "string" ? subject.trim() : "";
	if (!normalized) return true;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "mailto:") {
			const mailbox = decodeURIComponent(parsed.pathname || "");
			const atIndex = mailbox.lastIndexOf("@");
			const domain = atIndex >= 0 ? mailbox.slice(atIndex + 1) : "";
			return isLoopbackHost(domain);
		}
		return isLoopbackHost(parsed.hostname);
	} catch {
		return true;
	}
}

export function resolvePushSubject(currentSubject: string | null | undefined, preferredSubject: string | null | undefined): string {
	const current = typeof currentSubject === "string" ? currentSubject.trim() : "";
	const preferred = typeof preferredSubject === "string" ? preferredSubject.trim() : "";
	if (preferred && subjectNeedsUpgrade(current)) return preferred;
	if (current) return current;
	if (preferred) return preferred;
	return DEFAULT_PUSH_SUBJECT;
}

function normalizeSubscription(sub: unknown): PushSubscriptionJSON | null {
	if (!sub || typeof sub !== "object") return null;
	const value = sub as {
		endpoint?: unknown;
		expirationTime?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
	};
	if (typeof value.endpoint !== "string" || !value.endpoint) return null;
	if (!value.keys || typeof value.keys !== "object") return null;
	if (typeof value.keys.p256dh !== "string" || typeof value.keys.auth !== "string") return null;
	return {
		endpoint: value.endpoint,
		expirationTime: typeof value.expirationTime === "number" ? value.expirationTime : null,
		keys: {
			p256dh: value.keys.p256dh,
			auth: value.keys.auth,
		},
	};
}

export class PushService {
	private storePath: string;
	private data: StoredPushData | null = null;

	constructor(storePath = join(homedir(), ".pi", "agent", "pi-web", "push.json")) {
		this.storePath = storePath;
	}

	async init(preferredSubject?: string | null): Promise<void> {
		const { data, changed } = await this.load(preferredSubject);
		this.data = data;
		webpush.setVapidDetails(this.data.vapid.subject, this.data.vapid.publicKey, this.data.vapid.privateKey);
		if (changed) {
			await this.save();
		}
	}

	getPublicKey(): string {
		if (!this.data) throw new Error("push_not_initialized");
		return this.data.vapid.publicKey;
	}

	async subscribe(subscription: unknown): Promise<{ ok: true; count: number }> {
		if (!this.data) throw new Error("push_not_initialized");
		const normalized = normalizeSubscription(subscription);
		if (!normalized) throw new Error("invalid_subscription");

		const now = new Date().toISOString();
		const existingIdx = this.data.subscriptions.findIndex((sub) => sub.endpoint === normalized.endpoint);
		const entry = { ...normalized, createdAt: now, updatedAt: now };
		if (existingIdx >= 0) {
			const prev = this.data.subscriptions[existingIdx]!;
			this.data.subscriptions[existingIdx] = { ...prev, ...entry, createdAt: prev.createdAt, updatedAt: now };
		} else {
			this.data.subscriptions.push(entry);
		}
		await this.save();
		return { ok: true, count: this.data.subscriptions.length };
	}

	async unsubscribe(endpoint: string): Promise<{ ok: true; count: number }> {
		if (!this.data) throw new Error("push_not_initialized");
		const before = this.data.subscriptions.length;
		this.data.subscriptions = this.data.subscriptions.filter((sub) => sub.endpoint !== endpoint);
		if (this.data.subscriptions.length !== before) {
			await this.save();
		}
		return { ok: true, count: this.data.subscriptions.length };
	}

	async send(payload: PushNotificationPayload): Promise<{ ok: true; sent: number; failed: number }> {
		if (!this.data) throw new Error("push_not_initialized");
		if (this.data.subscriptions.length === 0) return { ok: true, sent: 0, failed: 0 };

		const notif = {
			title: payload.title,
			body: payload.body,
			url: payload.url || (payload.sessionId ? `/?session=${encodeURIComponent(payload.sessionId)}` : "/"),
			sessionId: payload.sessionId,
			sessionName: payload.sessionName,
			icon: payload.icon || "/icon-192.png",
			badge: payload.badge || "/apple-touch-icon.png",
			tag: payload.tag || payload.sessionId || "pi-session",
		};

		let sent = 0;
		let failed = 0;
		const subscriptions = [...this.data.subscriptions];
		for (const sub of subscriptions) {
			try {
				await webpush.sendNotification(sub as PushSubscriptionJSON, JSON.stringify(notif));
				sent += 1;
			} catch (error: any) {
				const statusCode = Number(error?.statusCode || error?.status || 0);
				const reason = typeof error?.body === "string" ? error.body.slice(0, 100) : error?.message?.slice(0, 100) || "";
				console.error(`[push] send failed: ${statusCode} ${reason}`);
				if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
					this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
				}
				failed += 1;
			}
		}

		if (sent > 0 || failed > 0) {
			await this.save();
		}
		return { ok: true, sent, failed };
	}

	private async load(preferredSubject?: string | null): Promise<{ data: StoredPushData; changed: boolean }> {
		try {
			const raw = await readFile(this.storePath, "utf8");
			const parsed = safeParse<StoredPushData>(raw);
			if (parsed && parsed.version === 1 && parsed.vapid?.publicKey && parsed.vapid?.privateKey) {
				const subject = resolvePushSubject(parsed.vapid.subject, preferredSubject);
				return {
					data: {
						version: 1,
						vapid: {
							publicKey: parsed.vapid.publicKey,
							privateKey: parsed.vapid.privateKey,
							subject,
						},
						subscriptions: Array.isArray(parsed.subscriptions)
							? parsed.subscriptions.map((sub) => normalizeSubscription(sub)).filter((sub): sub is PushSubscriptionJSON => Boolean(sub)).map((sub) => ({
								...sub,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							}))
							: [],
					},
					changed: subject !== parsed.vapid.subject,
				};
			}
		} catch {
			// ignore
		}

		const vapid = webpush.generateVAPIDKeys();
		return {
			data: {
				version: 1,
				vapid: {
					publicKey: vapid.publicKey,
					privateKey: vapid.privateKey,
					subject: resolvePushSubject(null, preferredSubject),
				},
				subscriptions: [],
			},
			changed: false,
		};
	}

	private async save(): Promise<void> {
		if (!this.data) return;
		mkdirSync(dirname(this.storePath), { recursive: true });
		await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf8");
	}
}
