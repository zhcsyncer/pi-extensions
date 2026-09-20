/**
 * /search-setup — SettingsList home page plus a providers page, over one global draft.
 */

import {
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";
import { BACKEND_DEFS } from "./backends/registry.js";
import { loadMigratedSearchConfig, saveSearchConfig } from "./config-storage.js";
import { applyEnvAutoEnable, enabledBackendNames, effectiveSearchConfig, orderedActiveBackends, refreshConfig, routingOf } from "./config.js";
import { getKeySource } from "./credentials.js";
import {
	getGlobalConfigPath,
	getLegacyGlobalConfigPath,
	getLegacyProjectConfigPath,
	getProjectConfigPath,
} from "./paths.js";
import type { BackendConfig, SearchBackendName, SearchConfig } from "./types.js";
import {
	isSearchBackendName,
	ROUTING_STRATEGIES,
	SEARCH_BACKEND_NAMES,
} from "./types.js";

type SetupDraftState = {
	original: SearchConfig;
	draft: SearchConfig;
	clearedKeys: Set<SearchBackendName>;
};

type SetupAction =
	| { type: "close" }
	| { type: "back" }
	| { type: "esc-dirty" }
	| { type: "edit-keys"; backend: SearchBackendName }
	| { type: "edit-providers" }
	| { type: "edit-priority" };

type SettingsListInternals = {
	items: SettingItem[];
	filteredItems: SettingItem[];
	selectedIndex: number;
};

export function cloneConfig(value: SearchConfig): SearchConfig {
	return JSON.parse(JSON.stringify(value)) as SearchConfig;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function draftIsDirty(state: SetupDraftState): boolean {
	return !valuesEqual(state.original, state.draft);
}

export function parseApiKeysEditor(text: string): string[] {
	const keys: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!keys.includes(trimmed)) keys.push(trimmed);
	}
	return keys;
}

function keyCount(backend: SearchBackendName, config: SearchConfig): number {
	const keys = (config.backends?.[backend]?.apiKeys ?? []).filter((key) => key.trim());
	return keys.length;
}

function keyCountLabel(count: number): string {
	return `${count} ${count === 1 ? "key" : "keys"}`;
}

function credentialSummary(backend: SearchBackendName, config: SearchConfig): string {
	const saved = keyCount(backend, config);
	if (saved > 0) return keyCountLabel(saved);
	const { configured, source } = getKeySource(backend, config);
	if (!configured) return "0 keys";
	if (source.startsWith("env:")) return `env ${source.slice(4)}`;
	if (source.startsWith("shell:")) return "shell command";
	return "configured";
}

function enabledLabel(enabled: boolean): "on" | "off" {
	return enabled ? "on" : "off";
}

function enabledOrder(draft: SearchConfig): SearchBackendName[] {
	const enabled = enabledBackendNames(draft);
	return orderedActiveBackends(draft).filter((name) => enabled.includes(name));
}

export function normalizeSetupDraft(draft: SearchConfig): SearchConfig {
	const normalized = cloneConfig(draft);
	const backends: SearchConfig["backends"] = {};
	for (const name of SEARCH_BACKEND_NAMES) {
		const current = normalized.backends?.[name];
		if (!current) continue;
		const cleaned: BackendConfig = { ...current };
		if (typeof cleaned.apiKey === "string") {
			cleaned.apiKey = cleaned.apiKey.trim();
			if (!cleaned.apiKey) delete cleaned.apiKey;
		}
		if (Array.isArray(cleaned.apiKeys)) {
			cleaned.apiKeys = cleaned.apiKeys.map((key) => key.trim()).filter(Boolean);
			if (cleaned.apiKeys.length === 0) delete cleaned.apiKeys;
		}
		if (cleaned.apiKey) {
			cleaned.apiKeys = [cleaned.apiKey, ...(cleaned.apiKeys ?? []).filter((key) => key !== cleaned.apiKey)];
		}
		if (cleaned.apiKeys && cleaned.apiKeys.length > 0) {
			cleaned.apiKey = cleaned.apiKeys[0];
		} else {
			delete cleaned.apiKey;
		}
		backends[name] = cleaned;
	}
	normalized.backends = backends;
	normalized.routing = routingOf(normalized);
	normalized.priority = enabledOrder(normalized);
	if (normalized.priority.length === 0) delete normalized.priority;
	return normalized;
}

export function mergePreservedKeys(
	saved: SearchConfig,
	disk: SearchConfig,
	clearedKeys: ReadonlySet<SearchBackendName>,
): SearchConfig {
	const next = cloneConfig(saved);
	const backends = { ...(next.backends ?? {}) };
	for (const name of SEARCH_BACKEND_NAMES) {
		if (clearedKeys.has(name)) continue;
		if (keyCount(name, next) > 0) continue;
		const diskKeys = disk.backends?.[name]?.apiKeys?.filter((key) => key.trim()) ?? [];
		if (diskKeys.length === 0) continue;
		backends[name] = { ...(backends[name] ?? {}), apiKeys: diskKeys };
	}
	next.backends = backends;
	return next;
}

export function applySetupSetting(draft: SearchConfig, id: string, value: string): SearchConfig {
	const next = cloneConfig(draft);
	if (id === "routing" && (ROUTING_STRATEGIES as readonly string[]).includes(value)) {
		next.routing = value as SearchConfig["routing"];
		return next;
	}
	if (id === "compact") {
		next.compact = value === "on";
		return next;
	}
	if (id.startsWith("priority-move.")) {
		const backend = id.slice("priority-move.".length);
		if (!isSearchBackendName(backend)) return next;
		const order = enabledOrder(applyEnvAutoEnable(next));
		const index = order.indexOf(backend);
		if (index < 0) return next;
		if (value === "move up" && index > 0) {
			[order[index - 1], order[index]] = [order[index], order[index - 1]];
		} else if (value === "move down" && index < order.length - 1) {
			[order[index + 1], order[index]] = [order[index], order[index + 1]];
		} else {
			return next;
		}
		next.priority = order;
		return next;
	}
	if (id.startsWith("enabled.")) {
		const backend = id.slice("enabled.".length);
		if (!isSearchBackendName(backend)) return next;
		const enabled = value === "on";
		const current = { ...(next.backends?.[backend] ?? {}) };
		current.enabled = enabled;
		next.backends = { ...next.backends, [backend]: current };
		const order = enabledOrder(next);
		next.priority = order;
		if (next.priority.length === 0) delete next.priority;
		return next;
	}
	return next;
}

export function buildSearchSetupItems(draft: SearchConfig): SettingItem[] {
	const routing = routingOf(draft);
	const order = enabledOrder(draft);
	const items: SettingItem[] = [
		{
			id: "routing",
			label: "Routing",
			description: "Try order for fallback and targeted combine.",
			currentValue: routing,
			values: [...ROUTING_STRATEGIES],
		},
	];
	if (routing === "priority") {
		items.push({
			id: "priority",
			label: "Priority order",
			description: "Enter to reorder enabled backends.",
			currentValue: order.length > 0
				? order.map((name) => BACKEND_DEFS[name].label).join(" → ")
				: "none enabled",
			values: ["edit"],
		});
	}
	items.push(
		{
			id: "providers",
			label: "Providers",
			description: "Enter to enable backends and edit keys.",
			currentValue: order.length > 0 ? `${order.length} on` : "none on",
			values: ["edit"],
		},
		{
			id: "compact",
			label: "Compact",
			description: "Default compact tool results (title, source, URL).",
			currentValue: draft.compact ? "on" : "off",
			values: ["on", "off"],
		},
	);
	return items;
}

export function buildPrioritySetupItems(draft: SearchConfig, movingId?: string): SettingItem[] {
	return enabledOrder(draft).map((backend, index) => {
		const id = `priority-move.${backend}`;
		return {
			id,
			label: `${index + 1}. ${BACKEND_DEFS[backend].label}`,
			description: movingId === id
				? "Up/down moves this backend. Enter or Esc drops it."
				: "Enter to pick, then up/down to reorder.",
			currentValue: movingId === id ? "moving" : "",
		};
	});
}

export function buildProviderSetupItems(draft: SearchConfig): SettingItem[] {
	return SEARCH_BACKEND_NAMES.flatMap((backend) => {
		const def = BACKEND_DEFS[backend];
		const on = draft.backends?.[backend]?.enabled === true;
		const credential = credentialSummary(backend, draft);
		return [
			{
				id: `enabled.${backend}`,
				label: def.label,
				description: `${credential}${def.optionalKey ? " (optional)" : def.needsKey ? "" : " · no key required"}. Disable keeps saved keys.`,
				currentValue: enabledLabel(on),
				values: ["on", "off"],
			},
			{
				id: `keys.${backend}`,
				label: `${def.label} keys`,
				description: "Enter to edit. One key, ENV_VAR, or !command per line.",
				currentValue: credential,
				values: ["edit"],
			},
		];
	});
}

function listInternals(list: SettingsList): SettingsListInternals {
	return list as unknown as SettingsListInternals;
}

function replaceSettingsListItems(list: SettingsList, items: SettingItem[]): void {
	const mutable = listInternals(list);
	const selectedId = mutable.items[mutable.selectedIndex]?.id;
	mutable.items = items;
	mutable.filteredItems = items;
	const index = items.findIndex((item) => item.id === selectedId);
	if (index >= 0) mutable.selectedIndex = index;
	else if (mutable.selectedIndex >= items.length) mutable.selectedIndex = Math.max(0, items.length - 1);
}

function selectedItem(list: SettingsList): SettingItem | undefined {
	const mutable = listInternals(list);
	return mutable.items[mutable.selectedIndex];
}

function dropSettingsHint(lines: string[]): string[] {
	const copy = [...lines];
	while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop();
	if (copy.length > 0 && /Enter\/Space to change/.test(copy[copy.length - 1]!)) {
		copy.pop();
		while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop();
	}
	return copy;
}

function wrapList(list: SettingsList): Component {
	return {
		render: (width: number) => dropSettingsHint(list.render(width)),
		invalidate: () => list.invalidate(),
	};
}

function readGlobalConfig(ctx: ExtensionCommandContext): SearchConfig {
	return loadMigratedSearchConfig({
		targetPath: getGlobalConfigPath(),
		legacyPath: getLegacyGlobalConfigPath(),
		scope: "global",
		onNotice: (message) => ctx.ui.notify(message, "warning"),
	});
}

function readProjectConfig(ctx: ExtensionCommandContext): SearchConfig {
	if (!ctx.isProjectTrusted()) return {};
	return loadMigratedSearchConfig({
		targetPath: getProjectConfigPath(ctx.cwd),
		legacyPath: getLegacyProjectConfigPath(ctx.cwd),
		scope: "project",
		onNotice: (message) => ctx.ui.notify(message, "warning"),
	});
}

function hasProjectOverrides(ctx: ExtensionCommandContext): boolean {
	return Object.keys(readProjectConfig(ctx)).length > 0;
}

function readDiskConfig(): SearchConfig {
	return loadMigratedSearchConfig({
		targetPath: getGlobalConfigPath(),
		legacyPath: getLegacyGlobalConfigPath(),
		scope: "global",
	});
}

function saveDraft(ctx: ExtensionCommandContext, state: SetupDraftState): boolean {
	try {
		const disk = readDiskConfig();
		const saved = normalizeSetupDraft(mergePreservedKeys(normalizeSetupDraft(state.draft), disk, state.clearedKeys));
		saveSearchConfig(getGlobalConfigPath(), saved);
		state.original = cloneConfig(saved);
		state.draft = cloneConfig(saved);
		state.clearedKeys.clear();
		refreshConfig(ctx.cwd, ctx.isProjectTrusted(), true, (message) => ctx.ui.notify(message, "warning"));
		ctx.ui.notify(
			hasProjectOverrides(ctx)
				? "Search Hub configuration saved and applied. Current project overrides remain effective."
				: "Search Hub configuration saved and applied.",
			"info",
		);
		return true;
	} catch (error) {
		ctx.ui.notify(`Failed to save Search Hub configuration: ${(error as Error).message}`, "error");
		return false;
	}
}

function showPage(
	ctx: ExtensionCommandContext,
	state: SetupDraftState,
	options: {
		title: string;
		hint: string;
		project: SearchConfig;
		projectOverrides: boolean;
		itemsOf: (draft: SearchConfig, movingId?: string) => SettingItem[];
		onCancel: () => SetupAction;
		onActivate: (id: string, done: (action: SetupAction) => void) => boolean;
		allowPriorityMove?: boolean;
	},
): Promise<SetupAction> {
	return ctx.ui.custom<SetupAction>((tui, theme, _keybindings, done) => {
		const header = new Text(theme.fg("accent", theme.bold(options.title)), 0, 0);
		const hint = new Text(theme.fg("dim", options.hint), 0, 0);
		const scope = new Text(
			theme.fg("dim", options.projectOverrides
				? "Project config overrides this session; edit that file separately."
				: "Editing global config."),
			0,
			0,
		);
		const dirty = new Text(
			theme.fg("dim", draftIsDirty(state) ? "● Unsaved changes" : "No unsaved changes"),
			0,
			0,
		);
		let movingId: string | undefined;
		const refreshChrome = () => {
			hint.setText(theme.fg("dim", movingId ? "↑↓ move · Enter/Esc drop" : options.hint));
			dirty.setText(theme.fg("dim", draftIsDirty(state) ? "● Unsaved changes" : "No unsaved changes"));
		};
		const viewOf = (draft: SearchConfig, movingId?: string) => (
			options.itemsOf(effectiveSearchConfig(draft, options.project), movingId)
		);
		const rebuild = () => {
			replaceSettingsListItems(list, viewOf(state.draft, movingId));
			refreshChrome();
		};
		let list: SettingsList;
		list = new SettingsList(
			viewOf(state.draft),
			18,
			getSettingsListTheme(),
			(id, value) => {
				if (options.onActivate(id, done)) return;
				state.draft = applySetupSetting(state.draft, id, value);
				rebuild();
			},
			() => done(options.onCancel()),
			{ enableSearch: false },
		);
		const container = new Container();
		container.addChild(header);
		container.addChild(hint);
		container.addChild(scope);
		container.addChild(dirty);
		container.addChild(new Spacer(1));
		container.addChild(wrapList(list));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const kb = getKeybindings();
				if ((data === "s" || data === "S") && !movingId) {
					saveDraft(ctx, state);
					rebuild();
					tui.requestRender();
					return;
				}
				if (options.allowPriorityMove) {
					const selected = selectedItem(list);
					if (movingId) {
						if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm") || data === " ") {
							movingId = undefined;
							rebuild();
							tui.requestRender();
							return;
						}
						if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
							const direction = kb.matches(data, "tui.select.up") ? "move up" : "move down";
							state.draft = applySetupSetting(state.draft, movingId, direction);
							rebuild();
							tui.requestRender();
							return;
						}
						return;
					}
					if (
						selected?.id.startsWith("priority-move.")
						&& (kb.matches(data, "tui.select.confirm") || data === " ")
					) {
						movingId = selected.id;
						rebuild();
						tui.requestRender();
						return;
					}
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}).then((action) => action ?? { type: "close" });
}

function showHomePage(ctx: ExtensionCommandContext, state: SetupDraftState, project: SearchConfig): Promise<SetupAction> {
	return showPage(ctx, state, {
		title: "Search Hub",
		hint: "s save · Esc close",
		project,
		projectOverrides: Object.keys(project).length > 0,
		itemsOf: buildSearchSetupItems,
		onCancel: () => draftIsDirty(state) ? { type: "esc-dirty" } : { type: "close" },
		onActivate: (id, done) => {
			if (id === "providers") {
				done({ type: "edit-providers" });
				return true;
			}
			if (id === "priority") {
				done({ type: "edit-priority" });
				return true;
			}
			return false;
		},
	});
}

function showPriorityPage(ctx: ExtensionCommandContext, state: SetupDraftState, project: SearchConfig): Promise<SetupAction> {
	return showPage(ctx, state, {
		title: "Priority order",
		hint: "s save · Esc back",
		project,
		projectOverrides: Object.keys(project).length > 0,
		itemsOf: buildPrioritySetupItems,
		onCancel: () => ({ type: "back" }),
		allowPriorityMove: true,
		onActivate: () => false,
	});
}

function showProvidersPage(ctx: ExtensionCommandContext, state: SetupDraftState, project: SearchConfig): Promise<SetupAction> {
	return showPage(ctx, state, {
		title: "Providers",
		hint: "s save · Esc back",
		project,
		projectOverrides: Object.keys(project).length > 0,
		itemsOf: buildProviderSetupItems,
		onCancel: () => ({ type: "back" }),
		onActivate: (id, done) => {
			if (id.startsWith("keys.")) {
				const backend = id.slice("keys.".length);
				if (isSearchBackendName(backend)) {
					done({ type: "edit-keys", backend });
					return true;
				}
			}
			return false;
		},
	});
}

export async function openSearchSetup(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("/search-setup requires TUI mode", "error");
		return;
	}

	const original = readGlobalConfig(ctx);
	const state: SetupDraftState = {
		original: cloneConfig(original),
		draft: cloneConfig(original),
		clearedKeys: new Set(),
	};
	const project = ctx.isProjectTrusted() ? readProjectConfig(ctx) : {};
	let screen: "home" | "providers" | "priority" = "home";

	while (true) {
		const action = screen === "providers"
			? await showProvidersPage(ctx, state, project)
			: screen === "priority"
				? await showPriorityPage(ctx, state, project)
				: await showHomePage(ctx, state, project);
		if (action.type === "close") return;
		if (action.type === "back") {
			screen = "home";
			continue;
		}
		if (action.type === "esc-dirty") {
			const choice = await ctx.ui.select("Unsaved Search Hub changes", [
				"Discard changes",
				"Keep editing",
			]);
			if (choice === "Discard changes") return;
			continue;
		}
		if (action.type === "edit-providers") {
			screen = "providers";
			continue;
		}
		if (action.type === "edit-priority") {
			screen = "priority";
			continue;
		}
		const keys = state.draft.backends?.[action.backend]?.apiKeys ?? [];
		const edited = await ctx.ui.editor(
			`${BACKEND_DEFS[action.backend].label} keys (one reference per line)`,
			keys.join("\n"),
		);
		if (edited === undefined) continue;
		const nextKeys = parseApiKeysEditor(edited);
		const current = { ...(state.draft.backends?.[action.backend] ?? {}) };
		if (nextKeys.length > 0) {
			current.apiKeys = nextKeys;
			state.clearedKeys.delete(action.backend);
		} else {
			delete current.apiKeys;
			state.clearedKeys.add(action.backend);
		}
		delete current.apiKey;
		state.draft = {
			...state.draft,
			backends: { ...state.draft.backends, [action.backend]: current },
		};
	}
}
