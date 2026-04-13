import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type {
	ApiTerminalClientMessage,
	ApiTerminalServerMessage,
	ApiTerminalTabState,
} from "./types.ts";

export interface TerminalClient {
	connectionId: string;
	clientId: string;
	connectedAtMs: number;
	send: (event: ApiTerminalServerMessage) => void;
	close: (code?: number, reason?: string) => void;
}

interface RunningTerminalTab {
	id: string;
	label: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	status: "running" | "exited";
	startedAt: number;
	exitCode: number | null;
	signal: string | number | null;
	historyChunks: string[];
	historyBytes: number;
	historyTruncated: boolean;
	decoder: TextDecoder;
	terminal: any | null;
	process: any | null;
}

interface SessionTerminalManagerOptions {
	sessionId: string;
	cwd: string;
	canWrite: (clientId: string) => boolean;
}

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;
const MIN_COLS = 20;
const MIN_ROWS = 6;
const MAX_HISTORY_BYTES = 512 * 1024;

function textByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeTerminalSize(cols?: number, rows?: number): { cols: number; rows: number } {
	const safeCols = Number.isFinite(cols)
		? Math.max(MIN_COLS, Math.min(320, Math.floor(Number(cols))))
		: DEFAULT_COLS;
	const safeRows = Number.isFinite(rows)
		? Math.max(MIN_ROWS, Math.min(120, Math.floor(Number(rows))))
		: DEFAULT_ROWS;
	return { cols: safeCols, rows: safeRows };
}

function normalizeCwd(input: string | undefined, fallback: string): string {
	const raw = typeof input === "string" && input.trim() ? input.trim() : fallback;
	const resolved = resolve(raw);
	return existsSync(resolved) ? resolved : fallback;
}

function resolveShellCommand(): { shell: string; args: string[] } {
	const shell = process.env.SHELL?.trim() || "/bin/bash";
	const name = basename(shell).toLowerCase();
	if (name === "fish") return { shell, args: ["-il"] };
	if (name === "bash" || name === "zsh" || name === "sh" || name === "ksh") return { shell, args: ["-il"] };
	return { shell, args: ["-i"] };
}

function toTerminalSnapshot(tab: RunningTerminalTab, includeHistory = false): ApiTerminalTabState {
	return {
		id: tab.id,
		label: tab.label,
		cwd: tab.cwd,
		shell: tab.shell,
		cols: tab.cols,
		rows: tab.rows,
		status: tab.status,
		startedAt: tab.startedAt,
		exitCode: tab.exitCode,
		signal: tab.signal,
		...(includeHistory
			? {
				history: tab.historyChunks.join(""),
				historyTruncated: tab.historyTruncated,
			}
			: {}),
	};
}

export class SessionTerminalManager {
	private readonly clients = new Map<string, TerminalClient>();
	private readonly tabs = new Map<string, RunningTerminalTab>();
	private sessionCwd: string;
	private nextOrdinal = 1;

	constructor(private readonly options: SessionTerminalManagerOptions) {
		this.sessionCwd = resolve(options.cwd);
	}

	setCwd(cwd: string): void {
		this.sessionCwd = resolve(cwd);
	}

	addClient(client: TerminalClient): ApiTerminalServerMessage {
		this.clients.set(client.connectionId, client);
		return {
			type: "init",
			tabs: [...this.tabs.values()].map((tab) => toTerminalSnapshot(tab, true)),
		};
	}

	removeClient(connectionId: string): void {
		this.clients.delete(connectionId);
	}

	dispose(): void {
		for (const tabId of [...this.tabs.keys()]) {
			this.disposeTab(tabId, { notify: false });
		}
		for (const client of [...this.clients.values()]) {
			try {
				client.close(1000, "session_closed");
			} catch {
				// ignore broken sockets
			}
		}
		this.clients.clear();
	}

	handleMessage(connectionId: string, message: ApiTerminalClientMessage): void {
		const client = this.clients.get(connectionId);
		if (!client) return;
		if (!message || typeof message !== "object" || typeof message.type !== "string") {
			this.sendError(connectionId, "Invalid terminal message", "invalid_message");
			return;
		}

		switch (message.type) {
			case "create_tab": {
				if (!this.assertWritable(connectionId, client.clientId)) return;
				this.createTab(connectionId, message.cwd, message.cols, message.rows);
				return;
			}
			case "input": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.writeToTab(connectionId, message.tabId, message.data);
				return;
			}
			case "resize": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.resizeTab(connectionId, message.tabId, message.cols, message.rows);
				return;
			}
			case "close_tab": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.disposeTab(message.tabId, { notify: true });
				return;
			}
			case "ping":
				return;
			default:
				this.sendError(connectionId, `Unknown terminal message: ${String((message as { type?: unknown }).type)}`, "unknown_message");
		}
	}

	private assertWritable(connectionId: string, clientId: string, tabId?: string): boolean {
		if (this.options.canWrite(clientId)) return true;
		this.sendError(connectionId, "Take over the session to use the terminal", "not_controller", tabId);
		return false;
	}

	private sendToClient(connectionId: string, event: ApiTerminalServerMessage): void {
		const client = this.clients.get(connectionId);
		if (!client) return;
		try {
			client.send(event);
		} catch {
			// ignore broken sockets
		}
	}

	private broadcast(event: ApiTerminalServerMessage): void {
		for (const client of this.clients.values()) {
			try {
				client.send(event);
			} catch {
				// ignore broken sockets
			}
		}
	}

	private sendError(connectionId: string, message: string, code = "terminal_error", tabId?: string): void {
		this.sendToClient(connectionId, {
			type: "error",
			message,
			code,
			...(tabId ? { tabId } : {}),
		});
	}

	private createTab(connectionId: string, requestedCwd?: string, cols?: number, rows?: number): void {
		if (typeof (Bun as any)?.Terminal !== "function") {
			this.sendError(connectionId, "Terminal PTY support is not available in this Bun runtime", "terminal_unavailable");
			return;
		}

		const cwd = normalizeCwd(requestedCwd, this.sessionCwd);
		const size = normalizeTerminalSize(cols, rows);
		const { shell, args } = resolveShellCommand();
		const id = randomUUID();
		const label = `${basename(shell) || "term"} ${this.nextOrdinal++}`;

		const tab: RunningTerminalTab = {
			id,
			label,
			cwd,
			shell,
			cols: size.cols,
			rows: size.rows,
			status: "running",
			startedAt: Date.now(),
			exitCode: null,
			signal: null,
			historyChunks: [],
			historyBytes: 0,
			historyTruncated: false,
			decoder: new TextDecoder(),
			terminal: null,
			process: null,
		};

		try {
			const terminal = new Bun.Terminal({
				cols: size.cols,
				rows: size.rows,
				data: (_terminal: unknown, data: Uint8Array) => {
					this.handleTabOutput(id, data);
				},
				exit: (_terminal: unknown, exitCode: number, signal: string | number | null) => {
					this.handleTabExit(id, exitCode, signal);
				},
			});

			const proc = Bun.spawn([shell, ...args], {
				cwd,
				env: {
					...process.env,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					PWD: cwd,
					PI_WEB_TERMINAL: "1",
					PI_WEB_SESSION_ID: this.options.sessionId,
				},
				terminal,
			});

			tab.terminal = terminal;
			tab.process = proc;
			this.tabs.set(id, tab);
			this.broadcast({ type: "tab_opened", tab: toTerminalSnapshot(tab, false) });
		} catch (error) {
			try {
				tab.terminal?.close?.();
			} catch {
				// ignore cleanup failure
			}
			const message = error instanceof Error ? error.message : String(error);
			this.sendError(connectionId, `Failed to start terminal: ${message}`, "spawn_failed");
		}
	}

	private writeToTab(connectionId: string, tabId: string, data: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			this.sendError(connectionId, "Terminal tab not found", "tab_not_found", tabId);
			return;
		}
		if (tab.status !== "running" || !tab.terminal) {
			this.sendError(connectionId, "Terminal tab has already exited", "tab_not_running", tabId);
			return;
		}
		if (typeof data !== "string" || data.length === 0) return;
		try {
			tab.terminal.write(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendError(connectionId, `Failed to write to terminal: ${message}`, "write_failed", tabId);
		}
	}

	private resizeTab(connectionId: string, tabId: string, cols?: number, rows?: number): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			this.sendError(connectionId, "Terminal tab not found", "tab_not_found", tabId);
			return;
		}
		const size = normalizeTerminalSize(cols, rows);
		tab.cols = size.cols;
		tab.rows = size.rows;
		if (tab.status === "running" && tab.terminal) {
			try {
				tab.terminal.resize(size.cols, size.rows);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.sendError(connectionId, `Failed to resize terminal: ${message}`, "resize_failed", tabId);
				return;
			}
		}
		this.broadcast({ type: "tab_updated", tab: toTerminalSnapshot(tab, false) });
	}

	private disposeTab(tabId: string, options: { notify: boolean }): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.tabs.delete(tabId);
		const proc = tab.process;
		const terminal = tab.terminal;
		tab.process = null;
		tab.terminal = null;
		try {
			proc?.kill?.();
		} catch {
			// ignore process cleanup failure
		}
		try {
			terminal?.close?.();
		} catch {
			// ignore pty cleanup failure
		}
		if (options.notify) {
			this.broadcast({ type: "tab_closed", tabId });
		}
	}

	private appendHistory(tab: RunningTerminalTab, chunk: string): void {
		if (!chunk) return;
		tab.historyChunks.push(chunk);
		tab.historyBytes += textByteLength(chunk);
		while (tab.historyBytes > MAX_HISTORY_BYTES && tab.historyChunks.length > 1) {
			const removed = tab.historyChunks.shift() || "";
			tab.historyBytes -= textByteLength(removed);
			tab.historyTruncated = true;
		}
		if (tab.historyBytes > MAX_HISTORY_BYTES && tab.historyChunks.length === 1) {
			const current = tab.historyChunks[0] || "";
			const sliceStart = Math.max(0, current.length - Math.floor(MAX_HISTORY_BYTES / 2));
			tab.historyChunks[0] = current.slice(sliceStart);
			tab.historyBytes = textByteLength(tab.historyChunks[0]);
			tab.historyTruncated = true;
		}
	}

	private handleTabOutput(tabId: string, data: Uint8Array): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const text = tab.decoder.decode(data, { stream: true });
		if (!text) return;
		this.appendHistory(tab, text);
		this.broadcast({ type: "tab_output", tabId, data: text });
	}

	private handleTabExit(tabId: string, exitCode: number, signal: string | number | null): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const flushed = tab.decoder.decode();
		if (flushed) {
			this.appendHistory(tab, flushed);
			this.broadcast({ type: "tab_output", tabId, data: flushed });
		}
		tab.status = "exited";
		tab.exitCode = Number.isFinite(exitCode) ? exitCode : null;
		tab.signal = signal ?? null;
		try {
			tab.terminal?.close?.();
		} catch {
			// ignore
		}
		tab.process = null;
		tab.terminal = null;
		this.broadcast({ type: "tab_updated", tab: toTerminalSnapshot(tab, false) });
	}
}
