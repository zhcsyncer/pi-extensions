import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { formatBudgetRemaining } from "./budget.ts";
import { saveConsultConfig } from "./config.ts";
import { readRecentEvents, summarizeEvents } from "./events.ts";
import { DEFAULT_EFFORT, MSG_PERSIST_FAILED, MSG_REQUIRES_INTERACTIVE, NONE_VALUE, OFF_VALUE } from "./messages.ts";
import { modelKeyOf, type ConsultConfig, type GradedEffort, isGradedEffort } from "./types.ts";
import { ConsultTracker } from "./tracker.ts";

export interface ConsultCommandState {
	getConfig: () => ConsultConfig;
	getRaw: () => Record<string, unknown>;
	setConfig: (config: ConsultConfig, raw: Record<string, unknown>) => void;
	tracker: ConsultTracker;
	agentDir?: string;
	onConfigChanged: (ctx: ExtensionContext) => void;
}

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function modelPicker(models: Model<Api>[], includeNone: boolean, theme: Theme, done: (value?: string) => void) {
	const items: SelectItem[] = models.map((model) => ({
		value: modelKeyOf(model),
		label: `${model.name}  (${model.provider})`,
	}));
	if (includeNone) items.unshift({ value: NONE_VALUE, label: "None" });
	const list = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	return list;
}

function effortPicker(model: Model<Api> | undefined, theme: Theme, done: (value?: string) => void) {
	const levels = model
		? getSupportedThinkingLevels(model).filter((level): level is GradedEffort => isGradedEffort(level))
		: [];
	const items: SelectItem[] = [
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}  (recommended)` : level,
		})),
	];
	const list = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
	list.onSelect = (item) => done(item.value);
	list.onCancel = () => done(undefined);
	return list;
}

export function applyConsultSetting(config: ConsultConfig, id: string, value: string): ConsultConfig {
	const panel = config.panel.map((member) => ({ ...member }));
	switch (id) {
		case "panel0": {
			if (value === NONE_VALUE) return { ...config, panel: [], fanout: false };
			const effort = panel[0]?.effort;
			const rest = panel.slice(1);
			return { ...config, panel: [{ model: value, ...(effort ? { effort } : {}) }, ...rest] };
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
		case "loop": {
			const loop = value === "off" ? 0 : Number(value);
			return { ...config, gates: { ...config.gates, loop: Number.isFinite(loop) ? loop : config.gates.loop } };
		}
		case "done":
			return { ...config, gates: { ...config.gates, done: value === "on" } };
		default:
			return config;
	}
}

export function consultSettingItems(config: ConsultConfig, models: Model<Api>[], theme: Theme): SettingItem[] {
	const slot0 = config.panel[0];
	const slot1 = config.panel[1];
	const model0 = slot0 ? models.find((model) => modelKeyOf(model) === slot0.model) : undefined;
	const model1 = slot1 ? models.find((model) => modelKeyOf(model) === slot1.model) : undefined;
	return [
		{
			id: "panel0",
			label: "Advisor 1",
			description: "Primary advisor. Empty panel unloads consult (off costs nothing).",
			currentValue: slot0?.model ?? "none",
			submenu: (_current, done) => modelPicker(models, true, theme, done),
		},
		{
			id: "effort0",
			label: "Advisor 1 effort",
			description: "Reasoning effort for the primary advisor.",
			currentValue: slot0 ? (slot0.effort ?? "default") : "—",
			submenu: slot0 ? (_current, done) => effortPicker(model0, theme, done) : undefined,
		},
		{
			id: "panel1",
			label: "Advisor 2",
			description: "Optional second advisor for dissent. Auto gates always use Advisor 1 only.",
			currentValue: slot1?.model ?? "none",
			submenu: slot0 ? (_current, done) => modelPicker(models, true, theme, done) : undefined,
		},
		{
			id: "effort1",
			label: "Advisor 2 effort",
			description: "Reasoning effort for the second advisor.",
			currentValue: slot1 ? (slot1.effort ?? "default") : "—",
			submenu: slot1 ? (_current, done) => effortPicker(model1, theme, done) : undefined,
		},
		{
			id: "fanout",
			label: "Fanout",
			description: "When on, explicit consult() asks the whole panel in parallel. Auto gates stay single-path.",
			currentValue: config.fanout ? "on" : "off",
			values: ["off", "on"],
		},
		{
			id: "loop",
			label: "Loop gate",
			description: "Steer to consult after N identical tool calls or N consecutive errors. off disables it.",
			currentValue: config.gates.loop > 0 ? String(config.gates.loop) : "off",
			values: ["off", "2", "3", "4", "5"],
		},
		{
			id: "done",
			label: "Done gate",
			description: "Follow-up wrap-up consult after a turn that used edit/write.",
			currentValue: config.gates.done ? "on" : "off",
			values: ["on", "off"],
		},
	];
}

export async function formatConsultStatus(config: ConsultConfig, tracker: ConsultTracker, agentDir?: string): Promise<string> {
	const panel = config.panel.length === 0 ? "none" : config.panel.map((member) => `${member.model}${member.effort ? ` @${member.effort}` : ""}`).join(" + ");
	const budget = formatBudgetRemaining(config.budget, tracker.turnCount, tracker.sessionCount);
	const recent = summarizeEvents(await readRecentEvents(5, agentDir));
	return [
		`Panel: ${panel}`,
		`Fanout: ${config.fanout ? "on" : "off"}`,
		`Gates: loop=${config.gates.loop > 0 ? config.gates.loop : "off"} done=${config.gates.done ? "on" : "off"}`,
		`Budget remaining: ${budget}`,
		recent,
	].join("\n");
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
				ctx.ui.notify(await formatConsultStatus(state.getConfig(), state.tracker, state.agentDir), "info");
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
						`Budget remaining: ${formatBudgetRemaining(current.budget, state.tracker.turnCount, state.tracker.sessionCount)}`,
					),
					1,
					0,
				);
				container.addChild(status);

				let settingsList: SettingsList;
				settingsList = new SettingsList(
					consultSettingItems(current, models, theme),
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
							settingsList.updateValue("loop", next.gates.loop > 0 ? String(next.gates.loop) : "off");
							settingsList.updateValue("done", next.gates.done ? "on" : "off");
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
