import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastMode, {
	applyPriorityPayload,
	footerStatusLabel,
	loadDefaultEnabled,
	migrateFastModeSettings,
	modelKey,
	readEnabledModelList,
	resolveSettingsPath,
	SERVICE_TIER,
	SHORTCUT_REPEAT_GUARD_MS,
	STATUS_OFF,
	STATUS_ON,
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

const supportedModels = [
	model("openai", "openai-responses"),
	model("openai", "openai-codex-responses"),
	model("openai-codex", "openai-responses"),
	model("openai-codex", "openai-codex-responses"),
	model("xai", "openai-responses"),
	model("xai", "openai-completions"),
];

test("supportsApi accepts only the hardcoded OpenAI and xAI surfaces", () => {
	for (const model of supportedModels) assert.equal(supportsApi(model), true);
	for (const model of [undefined, { provider: "openai", api: "openai-completions" },
		{ provider: "xai", api: "openai-codex-responses" }, { provider: "anthropic", api: "openai-responses" },
		{ provider: "google", api: "google-generative-ai" }]) {
		assert.equal(supportsApi(model), false);
	}
});

test("footerStatusLabel is a short on/off badge and hides unsupported models", () => {
	assert.equal(footerStatusLabel(true, true), STATUS_ON);
	assert.equal(footerStatusLabel(false, true), STATUS_OFF);
	assert.equal(footerStatusLabel(true, false), undefined);
	assert.equal(footerStatusLabel(false, false), undefined);
});

test("priority replaces only the tier on a shallow copy for every supported surface", () => {
	const nested = Object.freeze({ temperature: 0.2 });
	const payload = Object.freeze({ model: "fixture", service_tier: "flex", nested, max_output_tokens: 8000 });
	for (const model of supportedModels) {
		const result = applyPriorityPayload({ enabled: true, model, payload });
		assert.deepEqual(result, { ...payload, service_tier: SERVICE_TIER });
		assert.notEqual(result, payload);
		assert.equal(result?.nested, nested);
	}
	assert.equal(payload.service_tier, "flex");
});

test("off or unsupported requests pass through without deleting a user tier", () => {
	const payload = Object.freeze({ service_tier: "flex", model: "fixture" });
	for (const model of supportedModels) {
		assert.equal(applyPriorityPayload({ enabled: false, model, payload }), undefined);
	}
	for (const model of [undefined, { provider: "openai", api: "openai-completions" },
		{ provider: "xai", api: "anthropic-messages" }, { provider: "custom", api: "openai-responses" }]) {
		assert.equal(applyPriorityPayload({ enabled: true, model, payload }), undefined);
	}
	assert.deepEqual(payload, { service_tier: "flex", model: "fixture" });
});

test("priority ignores non-record payloads", () => {
	for (const payload of [undefined, null, "raw", 1, true, []]) {
		assert.equal(applyPriorityPayload({ enabled: true, model: supportedModels[0], payload }), undefined);
	}
});

test("real Pi 1.2 loader loads Fast without registering provider replacements", async () => {
	await withSettingsDir(async (agentDir) => {
		const loader = new DefaultResourceLoader({
			cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../extensions/fast-mode.ts", import.meta.url))],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.deepEqual(result.runtime.pendingProviderRegistrations, []);
	});
});

function harness() {
	type Handler = (event: { reason?: string; payload?: unknown }, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const notifications: string[] = [];
	let status: string | undefined;
	fastMode({
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(_name: string, registered: NonNullable<typeof command>) { command = registered; },
	} as unknown as ExtensionAPI);
	const ctx = {
		model: { ...supportedModels[0], id: "shared-id" },
		ui: {
			setStatus(_key: string, label: string | undefined) { status = label; },
			theme: { fg: (_color: string, label: string) => label, bold: (label: string) => label },
			notify(message: string) { notifications.push(message); },
			onTerminalInput(handler: NonNullable<typeof terminalInput>) {
				terminalInput = handler;
				return () => { terminalInput = undefined; };
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx, notifications,
		get status() { return status; },
		emit(name: string, event: Parameters<Handler>[0] = {}) { return handlers.get(name)!(event, ctx); },
		command(args: string) { return command!.handler(args, ctx); },
		input(data: string) { return terminalInput?.(data); },
	};
}

test("main-request hook follows provider/model switches across session changes and reload", async () => {
	await withSettingsDir(async () => {
		const h = harness();
		const openai = h.ctx.model;
		const payload = Object.freeze({ service_tier: "flex", input: [] });
		const request = () => h.emit("before_provider_request", { payload });
		try {
			h.emit("session_start", { reason: "startup" });
			assert.equal(request(), undefined);
			await h.command("on");
			assert.deepEqual(request(), { ...payload, service_tier: SERVICE_TIER });
			h.ctx.model = { ...openai!, provider: "openai-codex", api: "openai-codex-responses" };
			h.emit("model_select");
			assert.equal(request(), undefined, "same id on a different provider has its own switch");
			h.ctx.model = { ...openai!, id: "another-id" };
			assert.equal(request(), undefined, "another model has its own switch");
			h.ctx.model = openai;
			for (const reason of ["new", "resume", "fork"]) {
				h.emit("session_start", { reason });
				assert.deepEqual(request(), { ...payload, service_tier: SERVICE_TIER });
			}
			h.emit("session_start", { reason: "reload" });
			assert.equal(request(), undefined);
			await h.command("default on");
			assert.equal(loadDefaultEnabled("openai/shared-id"), true);
			assert.deepEqual(request(), { ...payload, service_tier: SERVICE_TIER });
			await h.command("off");
			assert.equal(request(), undefined);
			h.emit("session_start", { reason: "reload" });
			assert.deepEqual(request(), { ...payload, service_tier: SERVICE_TIER });
			h.ctx.model = undefined;
			assert.equal(request(), undefined);
			assert.equal(payload.service_tier, "flex");
		} finally {
			h.emit("session_shutdown");
		}
	});
});

test("Ctrl+F consumes repeats and release without toggling twice or notifying", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withSettingsDir(async () => {
		const h = harness();
		try {
			h.emit("session_start", { reason: "startup" });
			assert.equal(h.status, STATUS_OFF);
			assert.deepEqual(h.input("\x06"), { consume: true });
			assert.equal(h.status, STATUS_ON);
			h.input("\x06");
			assert.deepEqual(h.input("\x1b[102;5:3u"), { consume: true });
			assert.equal(h.status, STATUS_ON);
			t.mock.timers.tick(SHORTCUT_REPEAT_GUARD_MS);
			h.input("\x06");
			assert.equal(h.status, STATUS_OFF);
			assert.deepEqual(h.notifications, []);
		} finally {
			h.emit("session_shutdown");
		}
		assert.equal(h.input("\x06"), undefined);
	});
});

test("new, resume, and fork keep the current switch; startup and reload reread settings", () => {
	assert.equal(shouldReloadEnabledFromSettings("startup"), true);
	assert.equal(shouldReloadEnabledFromSettings("reload"), true);
	assert.equal(shouldReloadEnabledFromSettings("new"), false);
	assert.equal(shouldReloadEnabledFromSettings("resume"), false);
	assert.equal(shouldReloadEnabledFromSettings("fork"), false);
	assert.equal(shouldReloadEnabledFromSettings(undefined), false);
});

test("readEnabledModelList keeps unique string ids and ignores the rest", () => {
	assert.deepEqual(readEnabledModelList(undefined), []);
	assert.deepEqual(readEnabledModelList({ models: { "openai/gpt-5.6": true } }), []);
	assert.deepEqual(
		readEnabledModelList({ models: ["openai/gpt-5.6", "", 1, "openai/gpt-5.6", "xai/grok-4.6"] }),
		["openai/gpt-5.6", "xai/grok-4.6"],
	);
});

test("modelKey uses provider/id and ignores incomplete models", () => {
	assert.equal(modelKey(undefined), undefined);
	assert.equal(modelKey({ provider: "openai" }), undefined);
	assert.equal(modelKey({ id: "gpt-5.6" }), undefined);
	assert.equal(modelKey({ provider: "openai", id: "gpt-5.6" }), "openai/gpt-5.6");
	assert.equal(modelKey({ provider: "openai-codex", id: "gpt-5.6" }), "openai-codex/gpt-5.6");
});

test("loadDefaultEnabled reads only the named model's default and ignores the old global flag", async () => {
	await withSettingsDir(async (agentDir) => {
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";
		assert.equal(resolveSettingsPath(), path.join(agentDir, "settings.json"));
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { enabled: true }, other: 1 })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: [gpt] } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);
		assert.equal(loadDefaultEnabled("openai-codex/gpt-5.6"), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: { [gpt]: true } } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: [] } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(path.join(agentDir, "settings.json"), "{not-json", "utf8");
		assert.equal(loadDefaultEnabled(gpt), false);
	});
});

test("writeDefaultEnabled atomically updates only the named model default", async () => {
	await withSettingsDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, "settings.json");
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";
		await writeFile(
			settingsPath,
			`${JSON.stringify({ theme: "dark", "fast-mode": { extra: "keep-me", enabled: true } }, null, 2)}\n`,
			"utf8",
		);

		writeDefaultEnabled(gpt, true);
		const afterOn = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOn, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", models: [gpt] },
		});
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);

		writeDefaultEnabled(gpt, true);
		writeDefaultEnabled(grok, true);
		writeDefaultEnabled(gpt, false);
		const afterOff = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOff, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", models: [grok] },
		});
		assert.equal(loadDefaultEnabled(gpt), false);
		assert.equal(loadDefaultEnabled(grok), true);
	});
});

test("migrateFastModeSettings rewrites legacy shapes and only notices behavior changes", async () => {
	await withSettingsDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, "settings.json");
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";

		assert.deepEqual(migrateFastModeSettings(), { migrated: false });

		await writeFile(
			settingsPath,
			`${JSON.stringify({ theme: "dark", "fast-mode": { extra: "keep-me", enabled: false } })}\n`,
			"utf8",
		);
		assert.deepEqual(migrateFastModeSettings(), { migrated: true });
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			theme: "dark",
			"fast-mode": { extra: "keep-me" },
		});
		assert.deepEqual(migrateFastModeSettings(), { migrated: false });

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { enabled: true } })}\n`,
			"utf8",
		);
		const globalOn = migrateFastModeSettings();
		assert.equal(globalOn.migrated, true);
		assert.match(String(globalOn.notice), /no longer has a global ON default/);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { "fast-mode": {} });
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { models: { [gpt]: true, [grok]: false, extra: 1 } } })}\n`,
			"utf8",
		);
		const fromMap = migrateFastModeSettings();
		assert.equal(fromMap.migrated, true);
		assert.match(String(fromMap.notice), /allowlist/);
		assert.match(String(fromMap.notice), /openai\/gpt-5\.6/);
		assert.equal(String(fromMap.notice).includes(grok), false);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			"fast-mode": { models: [gpt] },
		});
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { models: [gpt] } })}\n`,
			"utf8",
		);
		assert.deepEqual(migrateFastModeSettings(), { migrated: false });
	});
});

test("writing the default does not imply a current-switch change", async () => {
	await withSettingsDir(async () => {
		const gpt = "openai/gpt-5.6";
		let current = true;
		writeDefaultEnabled(gpt, false);
		assert.equal(current, true);
		assert.equal(loadDefaultEnabled(gpt), false);
		current = !current;
		assert.equal(current, false);
		assert.equal(loadDefaultEnabled(gpt), false);
	});
});
