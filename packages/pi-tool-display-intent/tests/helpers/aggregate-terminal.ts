import * as Tui from "@earendil-works/pi-tui";
import type { Component, Terminal, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	recordAggregateViewportRegion, toggleAggregateViewportRun,
	type AggregateViewportRun,
} from "../../src/aggregate-viewport.ts";

/** Only the terminal transport is fake; layout, paint, mouse routing and scrolling are native. */
export class AggregateTerminal implements Terminal {
	columns = 44;
	rows = 12;
	kittyProtocolActive = false;
	writes: string[] = [];
	onInput?: (data: string) => void;
	onResize?: () => void;
	onStop?: () => void;
	onWrite?: (data: string) => void;
	start(input: (data: string) => void, resize: () => void) { this.onInput = input; this.onResize = resize; }
	stop() { this.onStop?.(); this.onInput = undefined; this.onResize = undefined; }
	async drainInput() {}
	write(data: string) { this.writes.push(data); this.onWrite?.(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.onResize?.(); }
	mouse(button: number, x: number, y: number, release = false) {
		this.onInput?.(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	}
	click(x: number, y: number) { this.mouse(0, x, y); this.mouse(0, x, y, true); }
}

export class Run implements AggregateViewportRun {
	expanded = false;
	valid = true;
	toggles = 0;
	text = "Identical heading";
	onToggle?: () => void;
	constructor(public owner: object, public id: string) {}
	isValid() { return this.valid; }
	isExpanded() { return this.expanded; }
	label() { return this.text; }
	toggle() { this.onToggle?.(); this.expanded = !this.expanded; this.toggles++; }
}

export class Rows implements Component {
	renders = 0;
	constructor(public count: number, public text = "outside ledger") {}
	render(width: number) { this.renders++; return Array.from({ length: this.count }, () => this.text.slice(0, width)); }
	invalidate() {}
}

export class Host implements Component {
	private readonly stale = new Tui.Container();
	get children() { return this.stale.children; }
	get mouseLayout() { return (this.stale as unknown as { mouseLayout: unknown }).mouseLayout; }
	renders = 0;
	width = 0;
	lastLines: string[] = [];
	events: string[] = [];
	onMouse?: (event: TuiMouseEvent) => void;
	constructor(public run: Run, public output: (width: number) => { lines: string[]; titleRow?: number }) {
		// Retain an actual native Container cache while replacing the rendered host output.
		this.stale.addChild(new Rows(50, "obsolete native cache"));
		this.stale.render(44);
	}
	invalidate() {}
	render(width: number) {
		this.renders++;
		this.width = width;
		const { lines, titleRow } = this.output(width);
		this.lastLines = lines;
		recordAggregateViewportRegion(this, { run: this.run, width, height: lines.length, titleRow });
		return lines;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.events.push(event.type);
		this.onMouse?.(event);
		if (event.type !== "click" || event.button !== "left") return undefined;
		toggleAggregateViewportRun(this, this.run);
		return { handled: true };
	}
}

export function host(run: Run, body = 30): Host {
	return new Host(run, () => ({ lines: [run.label(), ...Array.from({ length: run.expanded ? body : 1 }, () => "ledger body")], titleRow: 0 }));
}

export function fullscreen(options: { top?: number; left?: number; tail?: number; scrollbar?: "always" | "hidden"; follow?: "end" | "none" } = {}) {
	const terminal = new AggregateTerminal();
	const document = new Tui.Container();
	const scroll = new Tui.ScrollView(document, { primary: true, follow: options.follow ?? "end", scrollbar: options.scrollbar ?? "always" });
	const sidebar = new Rows(1, "side");
	const content = options.left ? new Tui.HStack([
		{ component: sidebar, basis: options.left, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, minSize: 0 },
	]) : scroll;
	const widgets = new Tui.Container();
	const root = new Tui.VStack([
		{ component: new Rows(options.top ?? 2, "fixed top"), basis: options.top ?? 2, shrink: 0 },
		{ component: content, basis: 0, grow: 1, minSize: 0 },
		{ component: widgets, shrink: 0 },
		{ component: new Rows(options.tail ?? 2, "editor"), basis: options.tail ?? 2, shrink: 0 },
	]);
	const renderer = new Tui.TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
	renderer.setLayoutRoot(root);
	const native = renderer as unknown as {
		currentLayout: { root: any; lines: string[]; width: number; height: number };
		previousScreen: string[];
		focusedComponent?: Component;
	};
	return {
		terminal, document, scroll, root, widgets, renderer, native,
		start() { renderer.start(); renderer.renderNow(); },
		paint() { renderer.renderNow(); },
		stop() { renderer.stop({ preserveScreen: true }); },
		lines() { return native.previousScreen.map(Tui.stripTerminalSequences); },
	};
}
