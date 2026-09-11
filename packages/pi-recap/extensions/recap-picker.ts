import { type Component, Input, isKeyRelease, type SelectItem, SelectList } from "@earendil-works/pi-tui";

const MAX_VISIBLE_ROWS = 10;
export const CUSTOM_VALUE = "__custom__";

export type RecapPickerTheme = {
	fg(color: string, text: string): string;
};

export function filterSelectItems(items: SelectItem[], query: string): SelectItem[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items;
	return items.filter((item) => `${item.label} ${item.value}`.toLowerCase().includes(needle));
}

export function isBackspace(data: string): boolean {
	return data === "\u007f" || data === "\b";
}

export function isPrintable(data: string): boolean {
	if (data.length !== 1) return false;
	const code = data.charCodeAt(0);
	return code >= 0x20 && code !== 0x7f;
}

function selectListTheme(theme: RecapPickerTheme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

export function filterableSelect(
	items: SelectItem[],
	theme: RecapPickerTheme,
	done: (value?: string) => void,
	opts: { preferredValue?: string } = {},
): Component {
	let query = "";
	let list = buildFilterableList(items, query, theme, done, opts.preferredValue);

	return {
		render(width: number) {
			const filter = query.length > 0 ? `Filter: ${query}` : "Type to filter…";
			return [theme.fg(query.length > 0 ? "accent" : "dim", filter), ...list.render(width)];
		},
		invalidate() {
			list.invalidate();
		},
		handleInput(data: string) {
			if (isKeyRelease(data)) return;
			if (isBackspace(data)) {
				if (query.length === 0) return;
				query = query.slice(0, -1);
				list = buildFilterableList(items, query, theme, done, opts.preferredValue);
				return;
			}
			if (isPrintable(data)) {
				query += data;
				list = buildFilterableList(items, query, theme, done, opts.preferredValue);
				return;
			}
			list.handleInput(data);
		},
	};
}

function buildFilterableList(
	items: SelectItem[],
	query: string,
	theme: RecapPickerTheme,
	done: (value?: string) => void,
	preferredValue?: string,
): SelectList {
	const filtered = filterSelectItems(items, query);
	const visible = filtered.length > 0 ? filtered : [{ value: "", label: "No matches" }];
	const list = new SelectList(visible, Math.min(visible.length, MAX_VISIBLE_ROWS), selectListTheme(theme));
	list.onSelect = (item) => {
		if (!item.value) return;
		done(item.value);
	};
	list.onCancel = () => done(undefined);
	if (query.length === 0 && preferredValue) {
		const index = visible.findIndex((item) => item.value === preferredValue);
		if (index >= 0) list.setSelectedIndex(index);
	}
	return list;
}

export type CustomValueOptions = {
	title: string;
	prefill: string;
	parse: (raw: string) => string | undefined;
};

export function presetOrCustomPicker(
	presets: SelectItem[],
	theme: RecapPickerTheme,
	done: (value?: string) => void,
	opts: { preferredValue?: string; custom: CustomValueOptions },
): Component {
	const items = [...presets, { value: CUSTOM_VALUE, label: "custom…" }];
	let mode: "list" | "custom" = "list";
	const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ROWS), selectListTheme(theme));
	if (opts.preferredValue) {
		const index = items.findIndex((item) => item.value === opts.preferredValue);
		if (index >= 0) list.setSelectedIndex(index);
	}
	const input = createCustomInput(theme, opts.custom, done);
	list.onSelect = (item) => {
		if (item.value === CUSTOM_VALUE) {
			mode = "custom";
			return;
		}
		done(item.value);
	};
	list.onCancel = () => done(undefined);

	return {
		render(width: number) {
			return mode === "custom" ? input.render(width) : list.render(width);
		},
		invalidate() {
			if (mode === "custom") input.invalidate();
			else list.invalidate();
		},
		handleInput(data: string) {
			if (mode === "custom") input.handleInput?.(data);
			else list.handleInput(data);
		},
	};
}

function createCustomInput(
	theme: RecapPickerTheme,
	custom: CustomValueOptions,
	done: (value?: string) => void,
): Component {
	const input = new Input();
	input.focused = true;
	input.setValue(custom.prefill);
	input.onSubmit = (value) => {
		const parsed = custom.parse(value);
		if (parsed === undefined) return;
		done(parsed);
	};
	input.onEscape = () => done(undefined);

	return {
		render(width: number) {
			return [
				theme.fg("accent", custom.title),
				...input.render(width),
				theme.fg("dim", "Enter to save · Esc to cancel"),
			];
		},
		invalidate() {
			input.invalidate();
		},
		handleInput(data: string) {
			input.handleInput(data);
		},
	};
}

export function editorSubmenu(
	editor: ((title: string, prefill?: string) => Promise<string | undefined>) | undefined,
	title: string,
	prefill: string,
	done: (value?: string) => void,
): Component {
	if (!editor) {
		return {
			render: () => ["Editor unavailable"],
			invalidate() {},
			handleInput() {
				done(undefined);
			},
		};
	}

	void editor(title, prefill).then((edited) => {
		if (edited === undefined || edited.trim() === "") done(undefined);
		else done(edited);
	});

	return {
		render: () => ["Opening editor…"],
		invalidate() {},
		handleInput() {},
	};
}
