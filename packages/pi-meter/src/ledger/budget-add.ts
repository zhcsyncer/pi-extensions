import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { BudgetLimit, Metric, Period, Scope } from "./types.ts";

export interface BudgetUi {
	custom: <T>(build: (tui: any, theme: any, kb: any, done: (value: T | null) => void) => any) => Promise<T | null>;
}

export async function addBudgetFlow(ui: BudgetUi): Promise<BudgetLimit | null> {
	const scope = await pickSelect<Scope>(ui, "Scope", [
		{ value: "global", label: "Global", description: "across all sessions and projects" },
		{ value: "session", label: "Session", description: "current session only" },
		{ value: "project", label: "Project", description: "the current project (cwd)" },
	]);
	if (!scope) return null;

	const period = await pickSelect<Period>(ui, "Period", [
		{ value: "day", label: "Day" },
		{ value: "week", label: "Week" },
		{ value: "month", label: "Month" },
		{ value: "year", label: "Year" },
	]);
	if (!period) return null;

	const metric = await pickSelect<Metric>(ui, "Metric", [
		{ value: "cost", label: "Cost ($)", description: "local USD spend" },
		{ value: "tot", label: "Total tokens" },
		{ value: "in", label: "Input tokens" },
		{ value: "out", label: "Output tokens" },
	]);
	if (!metric) return null;

	const presets = metric === "cost" ? [1, 5, 10, 25, 50, 100] : [50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000];
	const maxStr = await pickSelect<string>(ui, `Max ${metric === "cost" ? "(USD)" : "(tokens)"}`, [
		...presets.map((value) => ({
			value: String(value),
			label: metric === "cost" ? `$${value}` : value.toLocaleString("en-US"),
		})),
		{ value: "other", label: "Other…", description: "use /usage budget add <scope> <period> <metric> <max>" },
	]);
	if (maxStr === null || maxStr === "other") return null;

	const warnStr = await pickSelect<string>(ui, "Warn at", [
		{ value: "0.5", label: "50%" },
		{ value: "0.8", label: "80%", description: "default" },
		{ value: "0.9", label: "90%" },
		{ value: "1", label: "100%", description: "only when exceeded" },
	]);
	if (warnStr === null) return null;

	return { scope, period, metric, max: Number(maxStr), warn: Number(warnStr) };
}

export async function pickSelect<T extends string>(ui: BudgetUi, title: string, items: SelectItem[]): Promise<T | null> {
	return ui.custom<T>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Meter — ${title}`)), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		list.onSelect = (item: SelectItem) => done(item.value == null ? null : item.value as T);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
