import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	applyConfigSetting,
	normalizeConfig,
	recapModelValues,
	resolveRecapModel,
	settingItems,
	shouldApplyTitleForPolicy,
	type RecapConfig,
	type RecapModelOption,
} from "../extensions/recap.ts";

function theme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function itemsFor(config: RecapConfig, available: RecapModelOption[] = []) {
	return settingItems(config, {
		availableModels: available,
		theme: theme(),
		getConfig: () => config,
	});
}

function itemIds(config: RecapConfig, available: RecapModelOption[] = []) {
	return itemsFor(config, available).map((item) => item.id);
}

const ALL_SETTING_IDS = [
	"recap.auto",
	"recap.idleAfterTurnMs",
	"recap.model",
	"recap.fallbackToCurrentModel",
	"recap.language",
	"title.applyToSessionName",
	"multiplexer.enabled",
	"multiplexer.template",
] as const;

test("recap model values put current first and keep unavailable configured models", () => {
	assert.deepEqual(
		recapModelValues(
			[
				{ provider: "google", id: "gemini-2.5-flash" },
				{ provider: "openai", id: "gpt-4.1" },
				{ provider: "google", id: "gemini-2.5-flash" },
			],
			"anthropic/claude-missing",
		),
		["current", "google/gemini-2.5-flash", "openai/gpt-4.1", "anthropic/claude-missing"],
	);
	assert.deepEqual(recapModelValues([{ provider: "google", id: "gemini-2.5-flash" }], "current"), [
		"current",
		"google/gemini-2.5-flash",
	]);
});

test("setting items hide fallback on current and keep a configured unavailable model visible", () => {
	const available: RecapModelOption[] = [{ provider: "google", id: "gemini-2.5-flash", name: "Gemini" }];
	const current = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	assert.equal(current.recap.model, "current");
	assert.ok(!itemIds(current, available).includes("recap.fallbackToCurrentModel"));

	const configured = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	configured.recap.model = "anthropic/claude-missing";
	const ids = itemIds(configured, available);
	assert.ok(ids.includes("recap.fallbackToCurrentModel"));
	assert.equal(itemsFor(configured, available).find((item) => item.id === "recap.model")?.currentValue, "anthropic/claude-missing");
	assert.deepEqual(recapModelValues(available, configured.recap.model)[0], "current");
	assert.ok(recapModelValues(available, configured.recap.model).includes("anthropic/claude-missing"));
});

test("switching to current hides fallback without clearing the stored fallback flag", () => {
	const config = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	config.recap.model = "google/gemini-2.5-flash";
	config.recap.fallbackToCurrentModel = false;
	assert.ok(itemIds(config).includes("recap.fallbackToCurrentModel"));

	const next = applyConfigSetting(config, "recap.model", "current");
	assert.equal(next.recap.model, "current");
	assert.equal(next.recap.fallbackToCurrentModel, false);
	assert.ok(!itemIds(next).includes("recap.fallbackToCurrentModel"));
});

test("setting items only expose the remaining recap knobs", () => {
	const specific = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	specific.recap.model = "google/gemini-2.5-flash";
	assert.deepEqual(itemIds(specific), [...ALL_SETTING_IDS]);

	const current = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	assert.deepEqual(
		itemIds(current),
		ALL_SETTING_IDS.filter((id) => id !== "recap.fallbackToCurrentModel"),
	);
});

test("apply writes remaining fields including custom idle, language, and template", () => {
	const next = applyConfigSetting(
		applyConfigSetting(
			applyConfigSetting(
				applyConfigSetting(DEFAULT_CONFIG, "recap.idleAfterTurnMs", "60000"),
				"recap.language",
				"ja",
			),
			"multiplexer.template",
			"{project} · {session}",
		),
		"title.applyToSessionName",
		"on",
	);

	assert.equal(next.recap.idleAfterTurnMs, 60_000);
	assert.equal(next.recap.language, "ja");
	assert.equal(next.multiplexer.template, "{project} · {session}");
	assert.equal(next.title.applyToSessionName, true);
});

test("applyToSessionName on uses if-empty-or-auto and off does not rename", () => {
	const off = applyConfigSetting(DEFAULT_CONFIG, "title.applyToSessionName", "off");
	assert.equal(off.title.applyToSessionName, false);
	assert.equal(
		shouldApplyTitleForPolicy({
			title: "New title",
			applyToSessionName: off.title.applyToSessionName,
			policy: "if-empty-or-auto",
			currentSessionName: "Manual name",
			lastAppliedSessionName: false,
		}),
		false,
	);

	const on = applyConfigSetting(DEFAULT_CONFIG, "title.applyToSessionName", "on");
	assert.equal(on.title.applyToSessionName, true);
	assert.equal(
		shouldApplyTitleForPolicy({
			title: "New title",
			applyToSessionName: true,
			policy: "if-empty-or-auto",
			currentSessionName: "Manual name",
			lastAppliedSessionName: false,
		}),
		false,
	);
	assert.equal(
		shouldApplyTitleForPolicy({
			title: "New title",
			applyToSessionName: true,
			policy: "if-empty-or-auto",
			currentSessionName: undefined,
			lastAppliedSessionName: false,
		}),
		true,
	);
	assert.equal(
		shouldApplyTitleForPolicy({
			title: "New title",
			applyToSessionName: true,
			policy: "if-empty-or-auto",
			currentSessionName: "Previous recap",
			lastAppliedSessionName: true,
			lastAppliedTitle: "Previous recap",
		}),
		true,
	);
});

test("enabled:false migrates to auto:false and dropped fields are omitted", () => {
	const next = normalizeConfig({
		recap: {
			enabled: false,
			auto: true,
			idleAfterTurnMs: 180_000,
			model: "current",
			fallbackToCurrentModel: true,
			language: "auto",
			manualCommand: false,
		},
		title: {
			applyToSessionName: true,
			generate: false,
			applyPolicy: "always",
			maxLength: 80,
		},
		display: { widgetPlacement: "belowEditor" },
		multiplexer: {
			enabled: true,
			template: "π {session} · {project}",
			maxLength: 80,
			restoreOnShutdown: false,
		},
	} as unknown as RecapConfig);

	assert.equal(next.recap.auto, false);
	assert.equal(next.title.applyToSessionName, true);
	assert.equal(next.multiplexer.enabled, true);
	assert.equal(next.multiplexer.template, "π {session} · {project}");
	assert.equal("enabled" in next.recap, false);
	assert.equal("manualCommand" in next.recap, false);
	assert.equal("generate" in next.title, false);
	assert.equal("applyPolicy" in next.title, false);
	assert.equal("maxLength" in next.title, false);
	assert.equal("display" in next, false);
	assert.equal("maxLength" in next.multiplexer, false);
	assert.equal("restoreOnShutdown" in next.multiplexer, false);
});

test("resolveRecapModel notifies only when a specific model misses and fallback is used", () => {
	const notifications: string[] = [];
	const current = { provider: "test", id: "session-model" };
	const ctx = {
		model: current,
		modelRegistry: {
			find() {
				return undefined;
			},
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	const fallbackConfig = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	fallbackConfig.recap.model = "google/missing";
	fallbackConfig.recap.fallbackToCurrentModel = true;
	assert.equal(resolveRecapModel(ctx, fallbackConfig), current);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /google\/missing/);

	const currentConfig = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	assert.equal(resolveRecapModel(ctx, currentConfig), current);
	assert.equal(notifications.length, 1);

	const strictConfig = structuredClone(fallbackConfig);
	strictConfig.recap.fallbackToCurrentModel = false;
	assert.equal(resolveRecapModel(ctx, strictConfig), undefined);
	assert.equal(notifications.length, 1);
});
