import { describe, expect, test } from "bun:test";
import { applyReviewSummaryUpdate, parseReviewSummaryMessage } from "../../public/app/session/review_summary.js";

describe("review summary state", () => {
	test("parses review summary details", () => {
		const parsed = parseReviewSummaryMessage({
			customType: "review-summary",
			content: "## Review\n- finding",
			details: {
				requestId: "req-1",
				mode: "commit",
				targetLabel: "commit abc123",
				branch: "main",
				extraFocus: "tests",
			},
		});

		expect(parsed).toMatchObject({
			requestId: "req-1",
			title: "Review summary",
			summary: "commit · commit abc123 · main · focus: tests",
			body: "## Review\n- finding",
		});
	});

	test("upserts when requestId is present", () => {
		const entries = [];
		applyReviewSummaryUpdate(entries, {
			customType: "review-summary",
			content: "first",
			details: { requestId: "req-1", mode: "working-tree", targetLabel: "changes" },
		});
		applyReviewSummaryUpdate(entries, {
			customType: "review-summary",
			content: "second",
			details: { requestId: "req-1", mode: "working-tree", targetLabel: "changes" },
		});

		expect(entries).toHaveLength(1);
		expect(entries[0].body).toBe("second");
	});

	test("treats missing requestId as append-only", () => {
		const entries = [];
		applyReviewSummaryUpdate(entries, {
			customType: "review-summary",
			content: "first",
			details: { mode: "working-tree", targetLabel: "changes" },
		});
		applyReviewSummaryUpdate(entries, {
			customType: "review-summary",
			content: "second",
			details: { mode: "working-tree", targetLabel: "changes" },
		});

		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.body)).toEqual(["first", "second"]);
	});
});
