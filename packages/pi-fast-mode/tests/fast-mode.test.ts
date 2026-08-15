import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import {
	applyXaiPriorityPayload,
	buildStreamOptions,
	loadDefaultEnabled,
	resolveServiceTier,
	resolveSettingsPath,
	SERVICE_TIER,
	shouldReloadEnabledFromSettings,
	supportsApi,
	writeDefaultEnabled,
	type FastModeModel,
} from "../extensions/fast-mode.ts";

function model(provider: string, api: string): FastModeModel {
	return { provider, api };
}

async function withSettingsDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-fast-mode-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test("supportsApi accepts only the hardcoded OpenAI and xAI surfaces", () => {
	assert.equal(supportsApi(undefined), false);
	assert.equal(supportsApi(model("openai", "openai-responses")), true);
	assert.equal(supportsApi(model("openai-codex", "openai-codex-responses")), true);
	assert.equal(supportsApi(model("xai", "openai-responses")), true);
	assert.equal(supportsApi(model("xai", "openai-completions")), true);
	assert.equal(supportsApi(model("openai", "openai-completions")), false);
	assert.equal(supportsApi(model("openai-codex", "openai-responses")), true);
	assert.equal(supportsApi(model("anthropic", "openai-responses")), false);
	assert.equal(supportsApi(model("google", "google-generative-ai")), false);
});

test("resolveServiceTier injects priority only when the in-memory switch is on", () => {
	const gpt = model("openai", "openai-responses");
	assert.equal(resolveServiceTier(false, gpt), undefined);
	assert.equal(resolveServiceTier(true, undefined), undefined);
	assert.equal(resolveServiceTier(true, model("anthropic", "anthropic-messages")), undefined);
	assert.equal(resolveServiceTier(true, gpt), SERVICE_TIER);
	assert.equal(resolveServiceTier(true, model("xai", "openai-completions")), SERVICE_TIER);
});

function openaiModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "openai",
		id: "gpt-5.6",
		api: "openai-responses",
		contextWindow: 128000,
		maxTokens: 16000,
		...overrides,
	} as Model<Api>;
}

const emptyContext = { messages: [] } as Context;

test("buildStreamOptions copies Pi streamSimple options and only adds serviceTier", () => {
	const gpt = openaiModel();
	const options: SimpleStreamOptions = { maxTokens: 64000, temperature: 0.2, apiKey: "test-key" };
	const expected = {
		...buildBaseOptions(gpt, emptyContext, options, options.apiKey),
		reasoningEffort: undefined,
	};

	assert.deepEqual(buildStreamOptions(gpt, emptyContext, options, undefined), expected);
	assert.deepEqual(buildStreamOptions(gpt, emptyContext, options, SERVICE_TIER), {
		...expected,
		serviceTier: SERVICE_TIER,
	});
});

test("buildStreamOptions keeps Pi maxTokens defaulting and context clamping", () => {
	const gpt = openaiModel({ contextWindow: 20000, maxTokens: 16000 });
	const shortContext = { messages: [] } as Context;
	const longContext = {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "x".repeat(18000) }],
			},
		],
	} as Context;

	const withoutCallerCap = buildStreamOptions(gpt, shortContext, { apiKey: "test-key" }, undefined);
	assert.equal(
		withoutCallerCap.maxTokens,
		buildBaseOptions(gpt, shortContext, { apiKey: "test-key" }, "test-key").maxTokens,
	);

	const oversized = { maxTokens: 64000, apiKey: "test-key" };
	const clamped = buildStreamOptions(gpt, longContext, oversized, SERVICE_TIER);
	assert.ok((clamped.maxTokens ?? 0) < 64000);
	assert.equal(
		clamped.maxTokens,
		buildBaseOptions(gpt, longContext, oversized, oversized.apiKey).maxTokens,
	);
	assert.equal(clamped.serviceTier, SERVICE_TIER);
});

test("OpenAI streamSimple wrappers still match the installed pi-ai recipe", () => {
	const openaiSource = readInstalledApiSource("openai-responses.js");
	const codexSource = readInstalledApiSource("openai-codex-responses.js");
	const recipe =
		/export const streamSimple = \(model, context, options\) => \{[\s\S]*?buildBaseOptions\(model, context, options, options\?\.apiKey\);[\s\S]*?clampThinkingLevel\(model, options\.reasoning\)[\s\S]*?return stream\(model, context, \{\s*\.\.\.base,\s*reasoningEffort,\s*\}\);/;
	const codexRecipe =
		/export const streamSimple = \(model, context, options\) => \{[\s\S]*?buildBaseOptions\(model, context, options, apiKey\);[\s\S]*?clampThinkingLevel\(model, options\.reasoning\)[\s\S]*?return stream\(model, context, \{\s*\.\.\.base,\s*reasoningEffort,\s*\}\);/;

	assert.match(
		openaiSource,
		recipe,
		"pi-ai openai-responses streamSimple changed. Re-read it and update buildStreamOptions if the recipe gained new fields.",
	);
	assert.match(
		codexSource,
		codexRecipe,
		"pi-ai openai-codex-responses streamSimple changed. Re-read it and update buildStreamOptions if the recipe gained new fields.",
	);
});

function readInstalledApiSource(fileName: string): string {
	const simpleOptionsUrl = import.meta.resolve("@earendil-works/pi-ai/api/simple-options");
	return readFileSync(join(dirname(fileURLToPath(simpleOptionsUrl)), fileName), "utf8");
}

test("applyXaiPriorityPayload only mutates matching xAI payloads when enabled", () => {
	const payload = { model: "grok-4.6", max_tokens: 8000 };
	assert.equal(
		applyXaiPriorityPayload({ enabled: false, model: model("xai", "openai-completions"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("openai", "openai-responses"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "anthropic-messages"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-completions"), payload: "raw" }),
		undefined,
	);
	assert.deepEqual(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-completions"), payload }),
		{ model: "grok-4.6", max_tokens: 8000, service_tier: SERVICE_TIER },
	);
	assert.deepEqual(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-responses"), payload }),
		{ model: "grok-4.6", max_tokens: 8000, service_tier: SERVICE_TIER },
	);
	assert.deepEqual(payload, { model: "grok-4.6", max_tokens: 8000 });
});

test("new, resume, and fork keep the current switch; startup and reload reread settings", () => {
	assert.equal(shouldReloadEnabledFromSettings("startup"), true);
	assert.equal(shouldReloadEnabledFromSettings("reload"), true);
	assert.equal(shouldReloadEnabledFromSettings("new"), false);
	assert.equal(shouldReloadEnabledFromSettings("resume"), false);
	assert.equal(shouldReloadEnabledFromSettings("fork"), false);
	assert.equal(shouldReloadEnabledFromSettings(undefined), false);
});

test("loadDefaultEnabled reads only settings.json fast-mode.enabled", async () => {
	await withSettingsDir(async (agentDir) => {
		assert.equal(resolveSettingsPath(), path.join(agentDir, "settings.json"));
		assert.equal(loadDefaultEnabled(), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { enabled: true }, other: 1 })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(), true);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { enabled: false } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(), false);

		await writeFile(path.join(agentDir, "settings.json"), "{not-json", "utf8");
		assert.equal(loadDefaultEnabled(), false);
	});
});

test("writeDefaultEnabled atomically updates only the fast-mode object", async () => {
	await withSettingsDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, "settings.json");
		await writeFile(
			settingsPath,
			`${JSON.stringify({ theme: "dark", "fast-mode": { extra: "keep-me" } }, null, 2)}\n`,
			"utf8",
		);

		writeDefaultEnabled(true);
		const afterOn = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOn, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", enabled: true },
		});
		assert.equal(loadDefaultEnabled(), true);

		writeDefaultEnabled(false);
		const afterOff = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOff, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", enabled: false },
		});
		assert.equal(loadDefaultEnabled(), false);
	});
});

test("writing the default does not imply a current-switch change", async () => {
	await withSettingsDir(async () => {
		let current = true;
		writeDefaultEnabled(false);
		assert.equal(current, true);
		assert.equal(loadDefaultEnabled(), false);
		current = !current;
		assert.equal(current, false);
		assert.equal(loadDefaultEnabled(), false);
	});
});
