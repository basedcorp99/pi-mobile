import { describe, expect, test } from "bun:test";
import { getCommandMenuEntries, handleCommandMenuAction } from "../../public/app/ui/menu.js";

describe("command menu behavior", () => {
	test("returns only agents and review entries", () => {
		const entries = getCommandMenuEntries([
			{ name: "review", description: "Run review", source: "extension", executeImmediately: true },
			{ name: "compact", description: "Compact", source: "extension" },
		]);

		expect(entries.map((entry) => entry.key)).toEqual(["agents", "review"]);
		expect(entries[1].command.name).toBe("review");
	});

	test("executes immediate commands instead of inserting them", async () => {
		const state = { executingCommand: null };
		const calls = [];
		const entry = getCommandMenuEntries([
			{ name: "review", description: "Run review", source: "extension", executeImmediately: true },
		])[1];

		const result = await handleCommandMenuAction({
			entry,
			state,
			onExecuteCommand: async (value) => calls.push(["execute", value]),
			onInsertCommand: (value) => calls.push(["insert", value]),
		});

		expect(result).toMatchObject({ ok: true, action: "execute", command: "review" });
		expect(calls).toEqual([["execute", "/review"]]);
		expect(state.executingCommand).toBe(null);
	});

	test("inserts non-immediate commands", async () => {
		const state = { executingCommand: null };
		const calls = [];
		const entry = {
			key: "compact",
			title: "/compact",
			description: "Compact",
			kind: "command",
			command: { name: "compact", description: "Compact", source: "extension", executeImmediately: false },
			disabled: false,
		};

		const result = await handleCommandMenuAction({
			entry,
			state,
			onExecuteCommand: async (value) => calls.push(["execute", value]),
			onInsertCommand: (value) => calls.push(["insert", value]),
		});

		expect(result).toMatchObject({ ok: true, action: "insert", command: "compact" });
		expect(calls).toEqual([["insert", "/compact "]]);
	});

	test("prevents duplicate immediate execution while busy", async () => {
		const state = { executingCommand: "review" };
		const calls = [];
		const entry = getCommandMenuEntries([
			{ name: "review", description: "Run review", source: "extension", executeImmediately: true },
		])[1];

		const result = await handleCommandMenuAction({
			entry,
			state,
			onExecuteCommand: async (value) => calls.push(["execute", value]),
		});

		expect(result).toMatchObject({ ok: false, reason: "busy", command: "review" });
		expect(calls).toEqual([]);
	});

	test("surfaces execution errors via notice handler", async () => {
		const state = { executingCommand: null };
		const notices = [];
		const entry = getCommandMenuEntries([
			{ name: "review", description: "Run review", source: "extension", executeImmediately: true },
		])[1];

		const result = await handleCommandMenuAction({
			entry,
			state,
			onExecuteCommand: async () => {
				throw new Error("boom");
			},
			onNotice: (message, level) => notices.push({ message, level }),
		});

		expect(result).toMatchObject({ ok: false, reason: "error", message: "boom" });
		expect(notices).toEqual([{ message: "boom", level: "error" }]);
		expect(state.executingCommand).toBe(null);
	});
});
