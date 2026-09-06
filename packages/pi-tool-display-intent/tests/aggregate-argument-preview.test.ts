import assert from "node:assert/strict";
import test from "node:test";
import { formatAggregateArgumentPreview } from "../src/aggregate-argument-preview.ts";

const preview = formatAggregateArgumentPreview;

test("aggregate previews show at most two identifying values without argument keys", () => {
	assert.equal(preview({
		description: "Find the call renderer",
		query: "renderCall",
		path: "src/tools.ts",
		name: "renderer",
		action: "inspect",
	}), "Find the call renderer · renderCall");
});

test("recognized purposes and targets take priority regardless of insertion order", () => {
	const entries = [
		["custom", "unrelated"],
		["action", "inspect"],
		["title", "Renderer"],
		["file_path", "src/tools.ts"],
		["why", "Locate rendering logic"],
	];
	const expected = "Locate rendering logic · src/tools.ts";
	assert.equal(preview(Object.fromEntries(entries)), expected);
	assert.equal(preview(Object.fromEntries(entries.toReversed())), expected);
	assert.equal(preview({ name: "Documentation", url: "https://example.com/docs" }), "example.com/docs · Documentation");
});

test("duplicate values do not consume the second identifying slot", () => {
	assert.equal(preview({
		query: "src/tools.ts",
		path: "src/tools.ts",
		file_path: "src/tools.ts",
		name: "Renderer",
	}), "src/tools.ts · Renderer");
	assert.equal(preview({
		url: "https://example.com/docs?first=1",
		uri: "https://example.com/docs?second=2",
		title: "Documentation",
	}), "example.com/docs · Documentation");
});

test("flags, paging, timeouts, payloads and nested shapes are not identifying values", () => {
	assert.equal(preview({
		displaySummary: "Hidden summary",
		display_summary: "Hidden legacy summary",
		prompt: "Write a full report",
		system_prompt: "Long instructions",
		content: "Payload content",
		body: "Request body",
		requestBody: "Another request body",
		oldText: "Old source text",
		new_text: "New source text",
		edits: "Serialized edits",
		data: "Serialized data",
		payload: "Serialized payload",
		limit: "20",
		offset: "10",
		page_size: "50",
		cursor: "next-page",
		timeoutMs: "1000",
		count: "2",
		verbose: "true",
		active: true,
		optional: false,
		operations: [{ description: "Do not traverse" }],
		metadata: { target: "Do not traverse" },
	}), "");
});

test("unknown custom arguments fall back to useful strings in deterministic key order", () => {
	const args = {
		zebra: "third value",
		beta: "second value",
		alpha: "first value",
		arbitraryNumber: 27,
		arbitraryBoolean: true,
		aBlank: " \t ",
		aFlag: "false",
	};
	assert.equal(preview(args), "first value · second value");
	assert.equal(preview(Object.fromEntries(Object.entries(args).toReversed())), "first value · second value");
});

test("only identifying numeric IDs are shown, not arbitrary numeric scalars", () => {
	assert.equal(preview({ id: 42, task_id: 42, action: "get", count: 7 }), "42 · get");
	assert.equal(preview({ taskId: 0, action: "get", limit: 10 }), "0 · get");
	assert.equal(preview({ ID: 12 }), "12");
	assert.equal(preview({ ratio: 0.5, count: 5, action: 3, valid: 17 }), "");
	for (const id of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(preview({ id }), "");
	}
});

test("empty and non-record inputs have no placeholder preview", () => {
	for (const args of [undefined, null, 1, true, "query", [], ["query"], {}, () => "query"]) {
		assert.equal(preview(args), "");
	}
});

test("sensitive keys are omitted rather than replaced by redaction placeholders", () => {
	assert.equal(preview({
		apiKey: "not-a-recognizable-token",
		accessKey: "not-a-recognizable-token",
		client_key: "not-a-recognizable-token",
		auth: "not-a-recognizable-token",
		authHeader: "not-a-recognizable-token",
		access_token: "not-a-recognizable-token",
		password: "not-a-recognizable-token",
		authorization: "not-a-recognizable-token",
		cookie: "not-a-recognizable-token",
		credential: "not-a-recognizable-token",
		privateKey: "not-a-recognizable-token",
		clientSecret: "not-a-recognizable-token",
		path: "src/safe.ts",
	}), "src/safe.ts");
});

test("obvious credential-like values are omitted even under innocuous keys", () => {
	const credentials = [
		"sk-proj-abcdefghijklmnopqrstuvwxyz",
		"ghp_abcdefghijklmnopqrstuvwxyz",
		"github_pat_abcdefghijklmnopqrstuvwxyz",
		"xoxb-12345678901234567890",
		"AKIA1234567890123456",
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghi.abcdefghijklmnop",
		"Bearer abcdefghijklmnopqrstuvwxyz",
		"Basic dXNlcjpwYXNzd29yZA==",
		"-----BEGIN PRIVATE KEY-----",
		"curl --header 'Authorization: abcdefg'",
		"token=plain-secret",
		`${"x".repeat(46)} ghp_abcdefghijklmnopqrstuvwxyz`,
	];
	for (const credential of credentials) {
		assert.equal(preview({ query: credential, path: "src/safe.ts" }), "src/safe.ts");
		assert.equal(preview({ custom: credential }), "");
	}
});

test("URL fields keep only host and path, removing credentials, query and fragment", () => {
	assert.equal(preview({
		url: "https://user:password@example.com/private/path/?token=secret#fragment",
		endpointUrl: "https://api.example.com/v1/?api_key=secret",
	}), "example.com/private/path · api.example.com/v1");
	assert.equal(preview({ uri: "user:password@example.com/docs?secret=value#fragment" }), "example.com/docs");
	assert.equal(preview({ url: "//user:password@example.com/docs?secret=value#fragment" }), "example.com/docs");
	assert.equal(preview({ url: "https://user:password@", name: "safe" }), "safe");
	assert.equal(preview({ url: "https://example.com/ghp_abcdefghijklmnopqrstuvwxyz" }), "");
});

test("embedded and unknown-key URLs receive the same inline sanitization", () => {
	assert.equal(preview({
		description: "Open https://user:password@example.com/docs?token=secret#fragment",
	}), "Open example.com/docs");
	assert.equal(preview({
		custom: "ssh://user:password@code.example.com/repo?token=secret#fragment",
	}), "code.example.com/repo");
	assert.equal(preview({ path: "src//tools.ts" }), "src//tools.ts");
});

test("terminal controls are stripped and multiline strings use only the first line", () => {
	assert.equal(preview({
		description: "\x1b[31mInspect\x1b[0m\t\x1b]8;;https://secret.example\x07safe\x1b]8;;\x07\r\nDo not display this line",
	}), "Inspect safe…");
	assert.equal(preview({
		query: "\x9b31mVisible\x9b0m\x1bPdo not display\x1b\\\u202ee\x00nd",
	}), "Visibleend");
	assert.equal(preview({ query: "sk_\x1b[31mabcdefghijklmnopqrstuvwxyz\x1b[0m" }), "");
	assert.equal(preview({ query: "x".repeat(48) + "\nmore" }), "x".repeat(47) + "…");
});

test("per-value and total budgets are Unicode-safe and can be tightened", () => {
	const args = { description: "界".repeat(60), path: "😀".repeat(60) };
	const expected = `${"界".repeat(47)}… · ${"😀".repeat(47)}…`;
	assert.equal(preview(args), expected);
	assert.equal(Array.from(preview(args)).length, 99);
	assert.equal(preview(args, 12), "界".repeat(11) + "…");
	assert.equal(preview({ query: "😀😀😀" }, 2), "😀…");
	assert.equal(preview(args, 1), "…");
	assert.equal(preview(args, 0), "");
	assert.equal(preview(args, -1), "");
	assert.equal(preview(args, 2.9), "界…");
	for (const budget of [NaN, Infinity, 1_000_000]) assert.equal(preview(args, budget), expected);
});

test("oversized strings are skipped rather than scanned or partially exposing a URL authority", () => {
	const huge = "x".repeat(2_000_000);
	assert.equal(preview({ description: huge, path: "src/safe.ts", prompt: huge }), "src/safe.ts");
	assert.equal(preview({ url: `https://${huge}:password@example.com/path?token=secret` }), "");
	assert.equal(preview({ [huge]: "not useful", target: "safe" }), "safe");
	assert.equal(preview({ query: `${"x".repeat(4000)}\nsecond line` }), "x".repeat(47) + "…");
});

test("getters and serialization hooks remain inert, including inherited properties", () => {
	let calls = 0;
	const args = Object.create({ get description() { calls++; throw new Error("inherited getter"); } });
	Object.defineProperties(args, {
		why: { enumerable: true, get() { calls++; throw new Error("own getter"); } },
		query: { enumerable: true, value: { toString() { calls++; throw new Error("toString"); } } },
		path: { enumerable: true, value: "src/safe.ts" },
		name: { enumerable: false, value: "hidden" },
		toJSON: { enumerable: true, value() { calls++; throw new Error("toJSON"); } },
	});
	Object.freeze(args);
	const before = Object.getOwnPropertyDescriptors(args);
	assert.equal(preview(args), "src/safe.ts");
	assert.equal(calls, 0);
	assert.deepEqual(Object.getOwnPropertyDescriptors(args), before);
});

test("uninspectable arguments fail closed instead of breaking the aggregate row", () => {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();
	assert.equal(preview(proxy), "");
	assert.equal(preview(new Proxy({}, { ownKeys() { throw new Error("uninspectable"); } })), "");
});
