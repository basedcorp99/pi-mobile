import { describe, expect, test } from "bun:test";
import { DEFAULT_PUSH_SUBJECT, resolvePushSubject } from "../src/push.ts";

describe("resolvePushSubject", () => {
	test("replaces localhost mailto subjects when a public subject is available", () => {
		expect(resolvePushSubject("mailto:root@localhost", "https://tt-suite-1.tailbb7473.ts.net")).toBe("https://tt-suite-1.tailbb7473.ts.net");
	});

	test("keeps existing non-local subjects", () => {
		expect(resolvePushSubject("mailto:ops@example.com", "https://tt-suite-1.tailbb7473.ts.net")).toBe("mailto:ops@example.com");
	});

	test("falls back to the legacy default when nothing usable is configured", () => {
		expect(resolvePushSubject("", null)).toBe(DEFAULT_PUSH_SUBJECT);
	});
});
