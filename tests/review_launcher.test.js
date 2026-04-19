import { describe, expect, test } from "bun:test";
import { buildReviewCommand } from "../public/app/ui/review_launcher.js";

describe("review launcher command builder", () => {
	test("builds command with explicit model override", () => {
		expect(buildReviewCommand({
			mode: "working-tree",
			focuses: ["Bugs", "Tests"],
			customFocus: "",
			modelChoice: "anthropic/claude-sonnet-4",
		})).toBe('/review --model "anthropic/claude-sonnet-4" working-tree "Bugs, Tests"');
	});

	test("omits model flag when using saved default", () => {
		expect(buildReviewCommand({
			mode: "commit",
			commitRef: "HEAD~1",
			focuses: [],
			customFocus: "",
			modelChoice: "default",
			defaultModelValue: "google/gemini-2.5-pro",
		})).toBe("/review commit HEAD~1");
	});

	test("supports current session model override", () => {
		expect(buildReviewCommand({
			mode: "custom",
			customInstructions: "risky changes",
			focuses: [],
			customFocus: "",
			modelChoice: "session",
		})).toBe('/review --model "session" custom "risky changes"');
	});
});
