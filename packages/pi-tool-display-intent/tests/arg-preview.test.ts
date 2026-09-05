import assert from "node:assert/strict";
import test from "node:test";
import {
	CUSTOM_ARGUMENT_PREVIEW_MAX_LENGTH,
	formatFlatArgumentPreview,
} from "../src/arg-preview.ts";

test("flat argument previews expose top-level scalars and summarize nested shapes", () => {
	assert.equal(
		formatFlatArgumentPreview({
			action: "batch",
			count: 2,
			active: true,
			operations: [{ action: "create" }, { action: "update" }],
			metadata: { owner: "agent" },
		}),
		"action=batch · count=2 · active=true · operations[2] · metadata{…}",
	);
});

test("flat argument previews strip displaySummary and redact sensitive keys and values", () => {
	const preview = formatFlatArgumentPreview({
		displaySummary: "must stay hidden",
		apiKey: "plain-secret-value",
		query: "ghp_abcdefghijklmnopqrstuvwxyz",
		reason: "first line\nsecond line",
	});
	assert.equal(preview, "apiKey=••• · query=••• · reason=\"first line…\"");
	assert.doesNotMatch(preview, /displaySummary|plain-secret|abcdefghijklmnopqrstuvwxyz|second line/);
});

test("flat argument previews remove credentials and query strings from URL-like fields", () => {
	assert.equal(
		formatFlatArgumentPreview({
			url: "https://user:password@example.com/private/path/?token=secret#fragment",
			endpointUrl: "https://api.example.com/v1/?api_key=secret",
		}),
		"url=example.com/private/path · endpointUrl=api.example.com/v1",
	);
});

test("flat argument previews enforce the shared 120-character budget", () => {
	const preview = formatFlatArgumentPreview({
		alpha: "a".repeat(80),
		beta: "b".repeat(80),
		gamma: "c".repeat(80),
	});
	assert.equal(Array.from(preview).length, CUSTOM_ARGUMENT_PREVIEW_MAX_LENGTH);
	assert.match(preview, /…$/);
});

test("flat argument previews handle empty and non-object arguments", () => {
	assert.equal(formatFlatArgumentPreview({ displaySummary: "hidden" }), "no args");
	assert.equal(formatFlatArgumentPreview(undefined), "no args");
	assert.equal(formatFlatArgumentPreview(["not", "tool", "args"]), "no args");
});
