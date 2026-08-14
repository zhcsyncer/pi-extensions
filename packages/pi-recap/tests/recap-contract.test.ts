import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import recapExtension, {
	DEFAULT_CONFIG,
	createRecapState,
	restoreRecapState,
	runRecap,
	shouldApplyTitleForPolicy,
	type RecapConfig,
	type RecapEntryData,
	type RunRecapOptions,
} from "../extensions/recap.ts";
import {
	RECAP_FALLBACK_WARNING,
	recapOutputWarning,
	resolveRecapOutput,
	type ResolveRecapOutputOptions,
} from "../extensions/recap-output.ts";

const DEFAULT_OUTPUT_OPTIONS: ResolveRecapOutputOptions = {
	stopReason: "stop",
	generateTitle: true,
	titleMaxLength: 50,
};

function resolve(raw: string, options: Partial<ResolveRecapOutputOptions> = {}) {
	return resolveRecapOutput(raw, { ...DEFAULT_OUTPUT_OPTIONS, ...options });
}

test("whole-response and fenced JSON keep the model title", () => {
	const expected = {
		ok: true as const,
		recap: "Fixed the parser.",
		title: "Parser fix",
		titleSource: "model" as const,
	};
	assert.deepEqual(resolve('{"recap":"Fixed the parser.","title":"Parser fix"}'), expected);
	assert.deepEqual(resolve('```json\n{"recap":"Fixed the parser.","title":"Parser fix"}\n```'), expected);
});

test("JSON strings may contain triple backticks without ending a structural fence", () => {
	const payload = '{"recap":"Documented ```json and ``` fences","title":"Fence docs"}';
	const expected = {
		ok: true as const,
		recap: "Documented and fences",
		title: "Fence docs",
		titleSource: "model" as const,
	};
	assert.deepEqual(resolve(payload), expected);
	assert.deepEqual(resolve(`\`\`\`json\n${payload}\n\`\`\``), expected);
});

test("missing, blank, and non-string JSON titles use a strictly bounded recap fallback", () => {
	for (const title of [undefined, "   ", 42]) {
		const payload = JSON.stringify({ recap: "  Fixed\n parser   and tests.  ", ...(title === undefined ? {} : { title }) });
		const result = resolve(payload, { titleMaxLength: 10 });
		assert.deepEqual(result, {
			ok: true,
			recap: "Fixed parser and tests.",
			title: "Fixed par…",
			titleSource: "recap-fallback",
		});
		assert.ok(result.ok && result.title.length <= 10);
	}

	assert.deepEqual(resolve('{"recap":"A longer recap"}', { titleMaxLength: 1 }), {
		ok: true,
		recap: "A longer recap",
		title: "A",
		titleSource: "recap-fallback",
	});
});

test("plain text and ordinary bullets remain valid recap input and use fallback titles", () => {
	assert.deepEqual(resolve("- Fixed parser\n- Added tests", { titleMaxLength: 14 }), {
		ok: true,
		recap: "- Fixed parser - Added tests",
		title: "- Fixed parse…",
		titleSource: "recap-fallback",
	});
	for (const recap of [
		"- Updated src/{parser,title}.ts",
		"[Issue #73] Fixed fallback handling",
		"{parser,title}.ts updated",
		"Here is the result: fixed fallback handling",
		"Here is the JSON parser fix: replaced regex with structural parsing.",
		"Here is the JSON: parser fix uses structural parsing.",
	]) {
		assert.deepEqual(resolve(recap, { titleMaxLength: 100 }), {
			ok: true,
			recap,
			title: recap,
			titleSource: "recap-fallback",
		});
	}

	assert.deepEqual(resolve("Improved handling of ```json fences in recap output", { titleMaxLength: 50 }), {
		ok: true,
		recap: "Improved handling of fences in recap output",
		title: "Improved handling of fences in recap output",
		titleSource: "recap-fallback",
	});
});

test("fallback truncation is Unicode-safe", () => {
	assert.deepEqual(resolve("🚀 launch parser fallback", { titleMaxLength: 2 }), {
		ok: true,
		recap: "🚀 launch parser fallback",
		title: "🚀…",
		titleSource: "recap-fallback",
	});
	assert.deepEqual(resolve("🚀 launch parser fallback", { titleMaxLength: 1 }), {
		ok: true,
		recap: "🚀 launch parser fallback",
		title: "🚀",
		titleSource: "recap-fallback",
	});
});

test("generate=false never derives or persists a title", () => {
	assert.deepEqual(resolve('{"recap":"Fixed the parser.","title":"Ignored"}', { generateTitle: false }), {
		ok: true,
		recap: "Fixed the parser.",
	});
	assert.deepEqual(resolve("Plain recap", { generateTitle: false }), {
		ok: true,
		recap: "Plain recap",
	});
});

test("malformed JSON-like output, invalid recap JSON, and empty recap fail instead of becoming recap text", () => {
	for (const raw of [
		'{"recap":"unfinished',
		'```json\n{"recap":"unfinished',
		'Sure, here is the JSON:\n{"recap":"unfinished',
		'Certainly, here\'s your requested recap JSON response:\n{"recap":"unfinished',
		'Here is the JSON:\n```json\n{"recap":"unfinished',
		'"recap":"missing object braces"',
		'{"recap":"   ","title":"Title"}',
		'{"title":"Title"}',
		'["bullet-looking JSON"]',
	]) {
		const result = resolve(raw);
		assert.equal(result.ok, false, raw);
	}
	assert.deepEqual(resolve("   \n\t"), {
		ok: false,
		error: "Recap model returned empty output",
	});
});

test("length and error stop reasons reject even otherwise valid partial content", () => {
	assert.deepEqual(resolve('{"recap":"Looks valid","title":"Title"}', { stopReason: "length" }), {
		ok: false,
		error: "Recap model output was truncated by the token limit",
	});
	assert.deepEqual(
		resolve('{"recap":"Looks valid","title":"Title"}', {
			stopReason: "error",
			errorMessage: "provider stream failed",
		}),
		{
			ok: false,
			error: "Recap model failed: provider stream failed",
		},
	);
});

test("title policies keep their existing behavior for fallback titles", () => {
	const fallbackTitle = "Fallback title";
	const base = {
		title: fallbackTitle,
		applyToSessionName: true,
		currentSessionName: "User title",
		lastAppliedSessionName: false,
	};

	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "never" }), false);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "always" }), true);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "if-empty" }), false);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "if-empty", currentSessionName: undefined }), true);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "if-empty-or-auto" }), false);
	assert.equal(
		shouldApplyTitleForPolicy({
			...base,
			policy: "if-empty-or-auto",
			currentSessionName: "Previous automatic title",
			lastAppliedSessionName: true,
			lastAppliedTitle: "Previous automatic title",
		}),
		true,
	);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "always", title: undefined }), false);
	assert.equal(shouldApplyTitleForPolicy({ ...base, policy: "always", applyToSessionName: false }), false);
});

type CompletionSpec = {
	text: string;
	stopReason: "stop" | "length" | "error";
	errorMessage?: string;
};

function renderWidget(value: unknown): string {
	const renderer = value as (
		tui: unknown,
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
	) => { render: (width: number) => string[] };
	const widget = renderer(undefined, {
		fg: (_color, text) => text,
		bold: (text) => text,
	});
	return widget.render(200).join("\n");
}

function createRunHarness(spec: CompletionSpec) {
	const appended: Array<{ customType: string; data: RecapEntryData }> = [];
	const sessionNames: string[] = [];
	const widgets: unknown[] = [];
	let currentSessionName = "Existing session";
	const entries = [
		{
			id: "source-entry",
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix the recap title behavior" }],
				timestamp: 1,
			},
		},
	] as unknown as SessionEntry[];
	const pi = {
		appendEntry(customType: string, data: RecapEntryData) {
			appended.push({ customType, data });
		},
		getSessionName() {
			return currentSessionName;
		},
		setSessionName(title: string) {
			currentSessionName = title;
			sessionNames.push(title);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		hasUI: true,
		signal: new AbortController().signal,
		model: { provider: "test", id: "recap-model" },
		modelRegistry: {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
		},
		sessionManager: {
			getBranch() {
				return entries;
			},
			getSessionName() {
				return currentSessionName;
			},
		},
		ui: {
			setStatus() {},
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
			notify() {},
		},
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	config.title.applyToSessionName = true;
	config.title.applyPolicy = "always";
	config.title.maxLength = 18;
	const state = createRecapState(config);
	const completeModel: NonNullable<RunRecapOptions["completeModel"]> = async () =>
		({
			role: "assistant",
			content: spec.text ? [{ type: "text", text: spec.text }] : [],
			stopReason: spec.stopReason,
			errorMessage: spec.errorMessage,
		}) as never;

	return { pi, ctx, config, state, completeModel, appended, sessionNames, widgets };
}

test("always applies and persists a recap-derived fallback title", async () => {
	const harness = createRunHarness({ text: "Implemented fallback title behavior", stopReason: "stop" });
	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		showProgress: false,
		completeModel: harness.completeModel,
	});

	assert.equal(result?.title, "Implemented fallb…");
	assert.equal(result?.titleSource, "recap-fallback");
	assert.equal(result?.appliedSessionName, true);
	assert.deepEqual(harness.sessionNames, ["Implemented fallb…"]);
	assert.equal(harness.appended.length, 1);
	assert.equal(harness.appended[0]?.data.titleSource, "recap-fallback");
	assert.equal(harness.state.lastRecapSourceToEntryId, "source-entry");

	assert.match(renderWidget(harness.widgets.at(-1)), new RegExp(`WARNING  ${RECAP_FALLBACK_WARNING}`));
});

test("plain recap text containing a json fence marker still persists", async () => {
	const harness = createRunHarness({ text: "Improved handling of ```json fences", stopReason: "stop" });
	const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
		force: true,
		showProgress: false,
		completeModel: harness.completeModel,
	});

	assert.equal(result?.recap, "Improved handling of fences");
	assert.equal(result?.titleSource, "recap-fallback");
	assert.equal(harness.appended.length, 1);
	assert.deepEqual(harness.sessionNames, [result?.title]);
	assert.equal(harness.state.lastRecapSourceToEntryId, "source-entry");
});

test("malformed JSON and length/error completions cannot save, rename, or advance recap source", async (t) => {
	const cases: Array<[string, CompletionSpec]> = [
		["malformed JSON", { text: '{"recap":"truncated', stopReason: "stop" }],
		["prefaced truncated JSON fence", { text: 'Here is the JSON:\n```json\n{"recap":"truncated', stopReason: "stop" }],
		["empty output", { text: "", stopReason: "stop" }],
		["structured empty recap", { text: '{"recap":"   ","title":"Title"}', stopReason: "stop" }],
		["length", { text: '{"recap":"partial', stopReason: "length" }],
		["error", { text: '{"recap":"partial', stopReason: "error", errorMessage: "provider failed" }],
	];

	for (const [name, spec] of cases) {
		await t.test(name, async () => {
			const harness = createRunHarness(spec);
			harness.state.lastRecapSourceToEntryId = "previous-source";
			const result = await runRecap(harness.pi, harness.ctx, harness.config, harness.state, "manual", {
				force: true,
				showProgress: false,
				completeModel: harness.completeModel,
			});

			assert.equal(result, undefined);
			assert.deepEqual(harness.appended, []);
			assert.deepEqual(harness.sessionNames, []);
			assert.equal(harness.state.lastRecap, undefined);
			assert.equal(harness.state.lastRecapSourceToEntryId, "previous-source");
			assert.equal(harness.state.lastAppliedSessionName, false);
			assert.equal(typeof harness.widgets.at(-1), "function");
		});
	}
});

test("persisted title source restores warning while old entries remain compatible", () => {
	const oldData: RecapEntryData = {
		recap: "Old recap",
		title: "Old title",
		reason: "manual",
		source: { toEntryId: "old-source" },
		generatedAt: 10,
		appliedSessionName: true,
		sessionNamePolicy: "always",
	};
	const oldEntry = { id: "old-recap", type: "custom", customType: "recap", data: oldData } as unknown as SessionEntry;
	const oldState = restoreRecapState([oldEntry], "Old title");
	assert.equal(oldState.lastRecap, oldData);
	assert.equal(oldState.lastRecapSourceToEntryId, "old-source");
	assert.equal(oldState.lastAppliedSessionName, true);
	assert.equal(recapOutputWarning(oldState.lastRecap?.titleSource), undefined);

	const fallbackData: RecapEntryData = { ...oldData, titleSource: "recap-fallback" };
	const fallbackEntry = { ...oldEntry, data: fallbackData } as unknown as SessionEntry;
	const fallbackState = restoreRecapState([fallbackEntry], "Old title");
	assert.equal(recapOutputWarning(fallbackState.lastRecap?.titleSource), RECAP_FALLBACK_WARNING);
});

test("session_start restores a persisted fallback warning into the widget", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-recap-reload-"));
	const agentDir = path.join(root, "agent");
	const configPath = path.join(agentDir, "extension-data", "pi-recap", "config.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(configPath, `${JSON.stringify({ multiplexer: { enabled: false } })}\n`, "utf8");

		const fallbackData: RecapEntryData = {
			recap: "Reloaded recap",
			title: "Reloaded fallback",
			titleSource: "recap-fallback",
			reason: "manual",
			source: { toEntryId: "source-before-reload" },
			generatedAt: 10,
			appliedSessionName: true,
			sessionNamePolicy: "always",
		};
		const entry = {
			id: "persisted-recap",
			type: "custom",
			customType: "recap",
			data: fallbackData,
		} as unknown as SessionEntry;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const widgets: unknown[] = [];
		const pi = {
			on(event: string, handler: unknown) {
				handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => Promise<void>);
			},
			registerCommand() {},
			getSessionName() {
				return fallbackData.title;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: root,
			mode: "tui",
			isProjectTrusted: () => false,
			sessionManager: {
				getBranch: () => [entry],
				getSessionName: () => fallbackData.title,
				getSessionId: () => "session-id",
			},
			ui: {
				setStatus() {},
				setWidget(_key: string, value: unknown) {
					widgets.push(value);
				},
				notify() {},
			},
		} as unknown as ExtensionContext;

		recapExtension(pi);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart({}, ctx);
		assert.match(renderWidget(widgets.at(-1)), new RegExp(`WARNING  ${RECAP_FALLBACK_WARNING}`));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
