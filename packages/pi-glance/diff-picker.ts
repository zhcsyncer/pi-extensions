import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";
import { diffDisplayText, type DiffRevisionCandidate } from "./diff-target.js";

export interface DiffRevisionChoice {
	readonly ref: string;
	readonly label: string;
}

export function filterDiffRevisions(candidates: readonly DiffRevisionCandidate[], query: string): DiffRevisionCandidate[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return candidates.filter((candidate) => {
		const text = `${candidate.name} ${candidate.ref} ${candidate.sha} ${candidate.subject}`.toLowerCase();
		return terms.every((term) => text.includes(term));
	});
}

export class DiffRevisionPicker implements Component, Focusable {
	private readonly input = new Input();
	private list!: SelectList;
	private choices: DiffRevisionChoice[] = [];
	private selected = 0;
	private pasting = false;

	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(
		private readonly title: string,
		private readonly candidates: readonly DiffRevisionCandidate[],
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (choice: DiffRevisionChoice | undefined) => void,
		private readonly requestRender: () => void,
	) {
		this.rebuild();
	}

	private rebuild(): void {
		const query = this.input.getValue().trim();
		const matches = filterDiffRevisions(this.candidates, query);
		this.choices = matches.map((candidate) => ({ ref: candidate.sha, label: candidate.name }));
		const items = matches.map((candidate, index) => ({
			value: String(index), label: diffDisplayText(candidate.name),
			description: `${candidate.kind} · ${candidate.sha.slice(0, 12)} · ${candidate.subject}`,
		}));
		if (query) {
			items.push({ value: String(items.length), label: `Use typed ref/SHA: ${diffDisplayText(query)}`, description: "Resolve this ref exactly" });
			this.choices.push({ ref: query, label: query });
		}
		this.selected = 0;
		this.list = new SelectList(items, 8, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("muted", text),
		});
	}

	handleInput(data: string): void {
		// Bracketed paste chunks belong entirely to Input, including embedded key sequences.
		const paste = this.pasting || data.includes("\x1b[200~");
		if (!paste && this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (!paste && this.keybindings.matches(data, "tui.select.confirm")) {
			const choice = this.choices[this.selected];
			if (choice) this.done(choice);
			return;
		}
		if (!paste && (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down"))) {
			const step = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
			if (this.choices.length) this.selected = (this.selected + step + this.choices.length) % this.choices.length;
			this.list.setSelectedIndex(this.selected);
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (paste) this.pasting = !data.includes("\x1b[201~");
			const value = this.input.getValue();
			const safe = diffDisplayText(value);
			if (safe !== value) this.input.setValue(safe);
			if (previous !== this.input.getValue()) this.rebuild();
		}
		this.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return [
			this.theme.fg("accent", this.theme.bold(diffDisplayText(this.title))),
			this.theme.fg("dim", "Search branches, tags, SHA or commit subject; or paste a ref"),
			...this.input.render(width),
			...(this.choices.length ? this.list.render(Math.max(4, width)) : [this.theme.fg("muted", "No revisions. Type a ref/SHA to continue.")]),
			this.theme.fg("dim", "↑↓ select · Enter confirm · Esc cancel"),
		].map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}
}

export function pickDiffRevision(ctx: Pick<ExtensionContext, "ui">, title: string, candidates: readonly DiffRevisionCandidate[]): Promise<DiffRevisionChoice | undefined> {
	return ctx.ui.custom<DiffRevisionChoice | undefined>((tui, theme, keybindings, done) =>
		new DiffRevisionPicker(title, candidates, theme, keybindings, done, () => tui.requestRender()),
	);
}
