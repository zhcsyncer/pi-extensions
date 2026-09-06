import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { formatBudgetRemaining } from "./budget.ts";
import { saveConsultConfig } from "./config.ts";
import { ConsultStatusDashboard } from "./dashboard.ts";
import { readRecentEvents } from "./events.ts";
import { DEFAULT_EFFORT, MSG_PERSIST_FAILED, MSG_REQUIRES_INTERACTIVE, NONE_VALUE, OFF_VALUE } from "./messages.ts";
import { filterableSelect } from "./picker.ts";
import {
	EFFORT_ORDINAL,
	modelKeyOf,
	type ConsultConfig,
	type ConsultEvent,
	type GradedEffort,
	isGradedEffort,
} from "./types.ts";
import { ConsultTracker } from "./tracker.ts";

export interface ConsultCommandState {
	getConfig: () => ConsultConfig;
	getRaw: () => Record<string, unknown>;
	setConfig: (config: ConsultConfig, raw: Record<string, unknown>) => void;
	tracker: ConsultTracker;
	agentDir?: string;
	onConfigChanged: (ctx: ExtensionContext) => void;
}

function modelItems(models: Model<Api>[], includeNone: boolean): SelectItem[] {
	const items: SelectItem[] = models.map((model) => ({
		value: modelKeyOf(model),
		label: `${model.name}  (${model.provider})`,
	}));
	if (includeNone) items.unshift({ value: NONE_VALUE, label: "None" });
	return items;
}

function effortItems(model: Model<Api> | undefined): SelectItem[] {
	const supported = model
		? getSupportedThinkingLevels(model).filter((level): level is GradedEffort => isGradedEffort(level))
		: [];
	const levels = supported.length > 0 ? supported : [...EFFORT_ORDINAL];
	return [
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}  (recommended)` : level,
		})),
	];
}

function modelPicker(
	models: Model<Api>[],
	includeNone: boolean,
	theme: Theme,
	done: (value?: string) => void,
	preferredValue?: string,
) {
	return filterableSelect(modelItems(models, includeNone), theme, done, { preferredValue });
}

function effortPicker(
	model: Model<Api> | undefined,
	theme: Theme,
	done: (value?: string) => void,
	preferredValue?: string,
) {
	return filterableSelect(effortItems(model), theme, done, {
		preferredValue: preferredValue ?? (model ? DEFAULT_EFFORT : OFF_VALUE),
	});
}

export function applyConsultSetting(config: ConsultConfig, id: string, value: string): ConsultConfig {
	const panel = config.panel.map((member) => ({ ...member }));
	switch (id) {
		case "panel0": {
			if (value === NONE_VALUE) return { ...config, panel: [], fanout: false };
			const effort = panel[0]?.effort ?? DEFAULT_EFFORT;
			const rest = panel.slice(1);
			return { ...config, panel: [{ model: value, effort }, ...rest] };
		}
		case "effort0": {
			if (!panel[0]) return config;
			if (value === OFF_VALUE) {
				panel[0] = { model: panel[0].model };
			} else if (isGradedEffort(value)) {
				panel[0] = { model: panel[0].model, effort: value };
			}
			return { ...config, panel };
		}
		case "panel1": {
			if (!panel[0]) return config;
			if (value === NONE_VALUE) return { ...config, panel: [panel[0]], fanout: false };
			const effort = panel[1]?.effort;
			return { ...config, panel: [panel[0], { model: value, ...(effort ? { effort } : {}) }] };
		}
		case "effort1": {
			if (!panel[1]) return config;
			if (value === OFF_VALUE) {
				panel[1] = { model: panel[1].model };
			} else if (isGradedEffort(value)) {
				panel[1] = { model: panel[1].model, effort: value };
			}
			return { ...config, panel };
		}
		case "fanout":
			return { ...config, fanout: value === "on" };
		case "watchdog": {
			const watchdog = value === "off" ? 0 : Number(value);
			return {
				...config,
				gates: { ...config.gates, watchdog: Number.isFinite(watchdog) ? watchdog : config.gates.watchdog },
			};
		}
		default:
			return config;
	}
}

function findModel(models: Model<Api>[], key: string | undefined): Model<Api> | undefined {
	return key ? models.find((model) => modelKeyOf(model) === key) : undefined;
}

export function consultSettingItems(
	config: ConsultConfig,
	models: Model<Api>[],
	theme: Theme,
	getConfig: () => ConsultConfig = () => config,
): SettingItem[] {
	const slot0 = config.panel[0];
	const slot1 = config.panel[1];
	return [
		{
			id: "panel0",
			label: "Advisor 1",
			description: "Primary advisor. Empty panel unloads consult (off costs nothing). Type to filter.",
			currentValue: slot0?.model ?? "none",
			submenu: (_current, done) => modelPicker(models, true, theme, done, getConfig().panel[0]?.model),
		},
		{
			id: "effort0",
			label: "Advisor 1 effort",
			description: "Reasoning effort for the primary advisor.",
			currentValue: slot0 ? (slot0.effort ?? "default") : "—",
			submenu: (_current, done) => {
				const slot = getConfig().panel[0];
				return effortPicker(findModel(models, slot?.model), theme, done, slot?.effort ?? OFF_VALUE);
			},
		},
		{
			id: "panel1",
			label: "Advisor 2",
			description: "Optional second advisor for dissent. Auto gates always use Advisor 1 only. Type to filter.",
			currentValue: slot1?.model ?? "none",
			submenu: (_current, done) => modelPicker(models, true, theme, done, getConfig().panel[1]?.model),
		},
		{
			id: "effort1",
			label: "Advisor 2 effort",
			description: "Reasoning effort for the second advisor.",
			currentValue: slot1 ? (slot1.effort ?? "default") : "—",
			submenu: (_current, done) => {
				const slot = getConfig().panel[1];
				return effortPicker(findModel(models, slot?.model), theme, done, slot?.effort ?? OFF_VALUE);
			},
		},
		{
			id: "fanout",
			label: "Fanout",
			description: "When on, explicit consult() asks the whole panel in parallel. Auto gates stay single-path.",
			currentValue: config.fanout ? "on" : "off",
			values: ["off", "on"],
		},
		{
			id: "watchdog",
			label: "Watchdog",
			description: "Steer to consult after N identical tool calls or N consecutive errors. off disables it.",
			currentValue: config.gates.watchdog > 0 ? String(config.gates.watchdog) : "off",
			values: ["off", "2", "3", "4", "5", "6", "8"],
		},
	];
}

export async function openConsultStatusDashboard(
	config: ConsultConfig,
	tracker: ConsultTracker,
	agentDir: string | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	let recent: ConsultEvent[] = [];
	let recentError: string | undefined;
	try {
		recent = await readRecentEvents(5, agentDir);
	} catch {
		recentError = "Recent consult log is unavailable.";
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const dashboard = new ConsultStatusDashboard(
			{
				panel: config.panel,
				fanout: config.fanout,
				watchdog: config.gates.watchdog,
				budgetRemaining: formatBudgetRemaining(config.budget, tracker.runCount, tracker.sessionCount),
				recent,
				...(recentError ? { recentError } : {}),
			},
			{
				fg: (color, text) => theme.fg(color as never, text),
				bold: (text) => theme.bold(text),
			},
		);
		dashboard.onDone = () => done();
		return {
			render: (width: number) => dashboard.render(width),
			invalidate: () => dashboard.invalidate(),
			handleInput: (data: string) => {
				dashboard.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export function registerConsultCommand(pi: ExtensionAPI, state: ConsultCommandState): void {
	pi.registerCommand("consult", {
		description: "Configure the consult panel, gates, and inspect budget/log",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}
			if (args.trim() === "status") {
				await openConsultStatusDashboard(state.getConfig(), state.tracker, state.agentDir, ctx);
				return;
			}

			const models = ctx.modelRegistry.getAvailable();
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				let current = state.getConfig();
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Consult")), 1, 0));
				const status = new Text(
					theme.fg(
						"dim",
						`Budget remaining: ${formatBudgetRemaining(current.budget, state.tracker.runCount, state.tracker.sessionCount)}`,
					),
					1,
					0,
				);
				container.addChild(status);

				let settingsList: SettingsList;
				settingsList = new SettingsList(
					consultSettingItems(current, models, theme, () => current),
					8,
					getSettingsListTheme(),
					(id, value) => {
						const next = applyConsultSetting(current, id, value);
						void (async () => {
							const saved = await saveConsultConfig(next, state.agentDir, state.getRaw());
							if (!saved) {
								ctx.ui.notify(MSG_PERSIST_FAILED, "error");
								return;
							}
							current = next;
							state.setConfig(next, { ...state.getRaw(), ...next });
							state.onConfigChanged(ctx);
							settingsList.updateValue("panel0", next.panel[0]?.model ?? "none");
							settingsList.updateValue("effort0", next.panel[0] ? (next.panel[0].effort ?? "default") : "—");
							settingsList.updateValue("panel1", next.panel[1]?.model ?? "none");
							settingsList.updateValue("effort1", next.panel[1] ? (next.panel[1].effort ?? "default") : "—");
							settingsList.updateValue("fanout", next.fanout ? "on" : "off");
							settingsList.updateValue(
								"watchdog",
								next.gates.watchdog > 0 ? String(next.gates.watchdog) : "off",
							);
						})();
					},
					() => done(undefined),
				);
				container.addChild(settingsList);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
