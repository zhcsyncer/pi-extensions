import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	applyConfigSetting,
	recapModelValues,
	resolveRecapModel,
	settingItems,
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
	"recap.enabled",
	"recap.auto",
	"recap.manualCommand",
	"recap.idleAfterTurnMs",
	"recap.minSessionTurns",
	"recap.neverTwiceInARow",
	"recap.model",
	"recap.fallbackToCurrentModel",
	"recap.maxRecentChars",
	"recap.maxTokens",
	"recap.language",
	"title.generate",
	"title.applyToSessionName",
	"title.applyPolicy",
	"title.maxLength",
	"display.widgetPlacement",
	"multiplexer.enabled",
	"multiplexer.template",
	"multiplexer.maxLength",
	"multiplexer.restoreOnShutdown",
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

test("setting items cover every RecapConfig field while generate=false only hides title extras", () => {
	const specific = structuredClone(DEFAULT_CONFIG) as RecapConfig;
	specific.recap.model = "google/gemini-2.5-flash";
	assert.deepEqual(itemIds(specific), [...ALL_SETTING_IDS]);

	const withoutTitle = structuredClone(specific);
	withoutTitle.title.generate = false;
	withoutTitle.title.applyToSessionName = true;
	withoutTitle.title.applyPolicy = "always";
	withoutTitle.title.maxLength = 80;
	const hidden = itemIds(withoutTitle);
	assert.ok(!hidden.includes("title.applyToSessionName"));
	assert.ok(!hidden.includes("title.applyPolicy"));
	assert.ok(!hidden.includes("title.maxLength"));
	assert.ok(hidden.includes("title.generate"));

	const stillHidden = applyConfigSetting(withoutTitle, "recap.manualCommand", "off");
	assert.equal(stillHidden.title.generate, false);
	assert.equal(stillHidden.title.applyToSessionName, true);
	assert.equal(stillHidden.title.applyPolicy, "always");
	assert.equal(stillHidden.title.maxLength, 80);
});

test("apply writes custom numbers, language, template, and remaining flags", () => {
	const next = applyConfigSetting(
		applyConfigSetting(
			applyConfigSetting(
				applyConfigSetting(
					applyConfigSetting(
						applyConfigSetting(
							applyConfigSetting(
								applyConfigSetting(
									applyConfigSetting(DEFAULT_CONFIG, "recap.idleAfterTurnMs", "60000"),
									"recap.minSessionTurns",
									"7",
								),
								"recap.maxRecentChars",
								"12345",
							),
							"recap.maxTokens",
							"777",
						),
						"title.maxLength",
						"42",
					),
					"multiplexer.maxLength",
					"55",
				),
				"recap.language",
				"ja",
			),
			"multiplexer.template",
			"{project} · {session}",
		),
		"recap.neverTwiceInARow",
		"off",
	);

	assert.equal(next.recap.idleAfterTurnMs, 60_000);
	assert.equal(next.recap.minSessionTurns, 7);
	assert.equal(next.recap.maxRecentChars, 12_345);
	assert.equal(next.recap.maxTokens, 777);
	assert.equal(next.title.maxLength, 42);
	assert.equal(next.multiplexer.maxLength, 55);
	assert.equal(next.recap.language, "ja");
	assert.equal(next.multiplexer.template, "{project} · {session}");
	assert.equal(next.recap.neverTwiceInARow, false);
	assert.equal(next.recap.manualCommand, true);
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
