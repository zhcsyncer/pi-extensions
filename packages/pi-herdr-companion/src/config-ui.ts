import {
	getSettingsListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	cloneCompanionConfig,
	parseCompanionConfig,
	type BlockedSourceRule,
	type CompanionConfig,
} from "./config.ts";

export interface CompanionConfigController {
	path: string;
	get(): CompanionConfig;
	save(config: CompanionConfig): Promise<CompanionConfig>;
	reset(): Promise<CompanionConfig>;
}

type ConfigAction =
	| "edit-ratio"
	| "edit-timeout"
	| "edit-events"
	| "edit-tools"
	| "reset"
	| "save"
	| "discard";

const ACTION_IDS = new Set<ConfigAction>([
	"edit-ratio",
	"edit-timeout",
	"edit-events",
	"edit-tools",
	"reset",
	"save",
	"discard",
]);

export function formatBlockedRules(rules: readonly BlockedSourceRule[]): string {
	return rules.map((rule) => `${rule.name} = ${rule.label}`).join("\n");
}

export function parseBlockedRulesText(text: string, kind: "events" | "tools"): BlockedSourceRule[] {
	const rules = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const separator = line.indexOf("=");
			const name = (separator === -1 ? line : line.slice(0, separator)).trim();
			const label = (separator === -1 ? name : line.slice(separator + 1)).trim();
			return { name, label };
		});
	const parsed = parseCompanionConfig({
		blocked: {
			events: kind === "events" ? rules : [],
			tools: kind === "tools" ? rules : [],
		},
	});
	return parsed.blocked[kind];
}

function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

export function buildCompanionSettingItems(config: CompanionConfig): SettingItem[] {
	return [
		{
			id: "runtime.injectSystemPrompt",
			label: "Runtime prompt",
			description: "Add Herdr runtime guidance to each model call's system prompt.",
			currentValue: onOff(config.runtime.injectSystemPrompt),
			values: ["on", "off"],
		},
		{
			id: "process.defaultDirection",
			label: "Pane split direction",
			description: "Default split direction for herdr_process and /btw.",
			currentValue: config.process.defaultDirection,
			values: ["down", "right"],
		},
		{
			id: "process.defaultShell",
			label: "Process command shell",
			description: "POSIX Bash uses a private script; pane sends the command to the interactive pane shell. Windows defaults to pane.",
			currentValue: config.process.defaultShell,
			values: ["bash", "pane"],
		},
		{
			id: "edit-ratio",
			label: "Process split ratio",
			description: "Enter a value from 0.1 through 0.9.",
			currentValue: String(config.process.defaultRatio),
			values: ["edit"],
		},
		{
			id: "edit-timeout",
			label: "Readiness timeout",
			description: "Enter milliseconds from 100 through 600000.",
			currentValue: `${config.process.readyTimeoutMs} ms`,
			values: ["edit"],
		},
		{
			id: "process.defaultLifetime",
			label: "Process lifetime",
			description: "Session closes the pane when the Pi session ends; persistent keeps it until stop.",
			currentValue: config.process.defaultLifetime,
			values: ["session", "persistent"],
		},
		{
			id: "edit-events",
			label: "Blocked event rules",
			description: "Edit exact event names and Herdr labels, one name = label rule per line.",
			currentValue: `${config.blocked.events.length} configured`,
			values: ["edit"],
		},
		{
			id: "edit-tools",
			label: "Blocked tool rules",
			description: "Edit exact tool names and Herdr labels, one name = label rule per line.",
			currentValue: `${config.blocked.tools.length} configured`,
			values: ["edit"],
		},
		{
			id: "reset",
			label: "Reset draft",
			description: "Replace every setting in this draft with package defaults.",
			currentValue: "defaults",
			values: ["reset"],
		},
		{
			id: "save",
			label: "Save and close",
			description: "Validate and atomically save this draft.",
			currentValue: "save",
			values: ["save"],
		},
		{
			id: "discard",
			label: "Discard changes",
			description: "Close without changing the active configuration.",
			currentValue: "discard",
			values: ["discard"],
		},
	];
}

export function applyFixedCompanionSetting(config: CompanionConfig, id: string, value: string): void {
	switch (id) {
		case "runtime.injectSystemPrompt": config.runtime.injectSystemPrompt = value === "on"; break;
		case "process.defaultDirection": config.process.defaultDirection = value as "down" | "right"; break;
		case "process.defaultShell": config.process.defaultShell = value as "bash" | "pane"; break;
		case "process.defaultLifetime": config.process.defaultLifetime = value as "session" | "persistent"; break;
		default: throw new Error(`Unknown companion setting: ${id}`);
	}
}

async function showSettingsScreen(
	ctx: ExtensionCommandContext,
	draft: CompanionConfig,
	path: string,
): Promise<ConfigAction> {
	return (await ctx.ui.custom<ConfigAction>((tui, theme, _keybindings, done) => {
		const items = buildCompanionSettingItems(draft);
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 18),
			getSettingsListTheme(),
			(id, value) => {
				if (ACTION_IDS.has(id as ConfigAction)) {
					done(id as ConfigAction);
					return;
				}
				applyFixedCompanionSetting(draft, id, value);
			},
			() => done("discard"),
			{ enableSearch: true },
		);
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Herdr Companion Settings")), 0, 0));
		container.addChild(new Text(theme.fg("dim", path), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	})) ?? "discard";
}

async function editNumber(
	ctx: ExtensionCommandContext,
	label: string,
	initial: number,
	minimum: number,
	maximum: number,
	integer: boolean,
): Promise<number | undefined> {
	let input = await ctx.ui.input(label, String(initial));
	while (input !== undefined) {
		const trimmed = input.trim();
		const value = Number(trimmed);
		if (trimmed && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value))) {
			return value;
		}
		ctx.ui.notify(`${label} must be ${integer ? "an integer " : ""}between ${minimum} and ${maximum}.`, "error");
		input = await ctx.ui.input(label, trimmed);
	}
	return undefined;
}

async function editRules(
	ctx: ExtensionCommandContext,
	kind: "events" | "tools",
	current: readonly BlockedSourceRule[],
): Promise<BlockedSourceRule[] | undefined> {
	let source = [
		`# One ${kind === "events" ? "event" : "tool"} per line: exact_name = Herdr label`,
		"# Empty content disables this source type.",
		formatBlockedRules(current),
	].filter(Boolean).join("\n");
	for (;;) {
		const edited = await ctx.ui.editor(`Blocked ${kind}`, source);
		if (edited === undefined) return undefined;
		try {
			return parseBlockedRulesText(edited, kind);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			source = edited;
		}
	}
}

export async function openCompanionConfigUi(
	ctx: ExtensionCommandContext,
	controller: CompanionConfigController,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/herdr-config requires Pi TUI mode.", "error");
		return;
	}
	let draft = cloneCompanionConfig(controller.get());
	for (;;) {
		const action = await showSettingsScreen(ctx, draft, controller.path);
		switch (action) {
			case "edit-ratio": {
				const value = await editNumber(ctx, "Process split ratio", draft.process.defaultRatio, 0.1, 0.9, false);
				if (value !== undefined) draft.process.defaultRatio = value;
				break;
			}
			case "edit-timeout": {
				const value = await editNumber(ctx, "Readiness timeout (milliseconds)", draft.process.readyTimeoutMs, 100, 600_000, true);
				if (value !== undefined) draft.process.readyTimeoutMs = value;
				break;
			}
			case "edit-events": {
				const rules = await editRules(ctx, "events", draft.blocked.events);
				if (rules) draft.blocked.events = rules;
				break;
			}
			case "edit-tools": {
				const rules = await editRules(ctx, "tools", draft.blocked.tools);
				if (rules) draft.blocked.tools = rules;
				break;
			}
			case "reset":
				if (await ctx.ui.confirm("Reset Herdr Companion settings?", "The draft will return to package defaults.")) {
					draft = cloneCompanionConfig();
				}
				break;
			case "save": {
				try {
					const saved = await controller.save(parseCompanionConfig(draft));
					ctx.ui.notify(`Herdr Companion settings saved.\n${controller.path}`, "info");
					draft = cloneCompanionConfig(saved);
					return;
				} catch (error) {
					ctx.ui.notify(`Could not save Herdr Companion settings: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				break;
			}
			case "discard":
				return;
		}
	}
}
