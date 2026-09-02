import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, type SelectItem, SelectList } from "@earendil-works/pi-tui";

const MAX_VISIBLE_ROWS = 10;

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

function selectListTheme(theme: Theme) {
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
	theme: Theme,
	done: (value?: string) => void,
	opts: { preferredValue?: string } = {},
): Component {
	let query = "";
	let list = buildList(items, query, theme, done, opts.preferredValue);

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
				list = buildList(items, query, theme, done, opts.preferredValue);
				return;
			}
			if (isPrintable(data)) {
				query += data;
				list = buildList(items, query, theme, done, opts.preferredValue);
				return;
			}
			list.handleInput(data);
		},
	};
}

function buildList(
	items: SelectItem[],
	query: string,
	theme: Theme,
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
