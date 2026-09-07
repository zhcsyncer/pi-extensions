import * as Tui from "@earendil-works/pi-tui";

export interface AggregateViewportRun {
	owner: object;
	id: string;
	isValid(): boolean;
	isExpanded(): boolean;
	toggle(): void;
	label(): string;
}

export interface AggregateViewportControl {
	run: AggregateViewportRun;
	collapse(): void;
}

type Region = { run: AggregateViewportRun; width: number; height: number; titleRow?: number };
type RecordedRegion = Region & { generation: number };
type Rect = { x: number; y: number; width: number; height: number };
type CachedComponent = {
	children?: object[];
	mouseLayout?: { width: number; children: { component: object; height: number }[] };
};
type Scroll = CachedComponent & {
	scrollTop: number;
	viewportHeight: number;
	isFollowingEnd?: boolean;
	getContentWidth(width: number): number;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
	scrollTo(row: number, options: { disableFollow: boolean }): void;
};
type LayoutBox = {
	component: object;
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: Scroll;
};
type Frame = { root: LayoutBox; primaryScrollView?: Scroll; width: number; height: number };
type Renderer = {
	mode?: string;
	stopped?: boolean;
	currentLayout?: Frame;
	terminal?: { columns: number; rows: number };
	hasOverlay(): boolean;
};
type RunGeometry = {
	run: AggregateViewportRun;
	title?: number;
	end: number;
	components: Set<object>;
	expanded: boolean;
};
type Ledger = Map<object, Map<string, RunGeometry>>;
type Viewport = {
	frame: Frame;
	box: LayoutBox;
	document: LayoutBox;
	scroll: Scroll;
	scrollTop: number;
	followingEnd?: boolean;
	overlay: boolean;
	ledger: Ledger;
};
type RendererState = {
	renderer: Renderer;
	viewport?: Viewport;
	components: Set<object>;
	undoLayout?: () => void;
	inRender: boolean;
};
type Selection = { state: RendererState; control: AggregateViewportControl };
type Transaction = {
	state: RendererState;
	viewport: Viewport;
	run: AggregateViewportRun;
	generation: number;
	expanded: boolean;
	desiredRow: number;
};

const HOOK = Symbol.for("@zhcsyncer/pi-tool-display-intent/aggregate-viewport");
let regions = new WeakMap<object, RecordedRegion>();
let receivers = new WeakMap<object, RendererState>();
const generations = new WeakMap<object, number>();
const renderers = new Map<Renderer, RendererState>();
const listeners = new Map<object, Set<(control: AggregateViewportControl | undefined) => void>>();
const selected = new Map<object, Selection>();
let pending: Transaction | undefined;
let unpatch: (() => void) | undefined;
let retired = false;

function generation(owner: object): number { return generations.get(owner) ?? 0; }
function size(value: number): boolean { return Number.isInteger(value) && value >= 0; }
function rect(value: Rect | undefined): boolean {
	return !!value && Number.isInteger(value.x) && Number.isInteger(value.y) && size(value.width) && size(value.height);
}
function valid(region: RecordedRegion): boolean {
	return region.generation === generation(region.run.owner) && region.run.isValid();
}

export function recordAggregateViewportRegion(component: object, region: Region): void {
	if (!size(region.width) || region.width === 0 || !size(region.height)
		|| (region.titleRow !== undefined && (!size(region.titleRow) || region.titleRow >= region.height))) {
		releaseAggregateViewportRegion(component);
		return;
	}
	regions.set(component, { ...region, generation: generation(region.run.owner) });
}

export function releaseAggregateViewportRegion(component: object): void {
	regions.delete(component);
	receivers.delete(component);
}

function addRegion(ledger: Ledger, component: object, region: RecordedRegion, row: number, top: number, end: number): void {
	if (!valid(region)) return;
	let runs = ledger.get(region.run.owner);
	if (!runs) ledger.set(region.run.owner, runs = new Map());
	let geometry = runs.get(region.run.id);
	if (!geometry) runs.set(region.run.id, geometry = {
		run: region.run, end: 0, components: new Set(), expanded: region.run.isExpanded(),
	});
	geometry.components.add(component);
	geometry.end = Math.max(geometry.end, Math.min(end, row + region.height));
	if (region.titleRow !== undefined) {
		const title = row + region.titleRow;
		if (title >= top && title < end) {
			geometry.title = geometry.title === undefined ? title : Math.min(geometry.title, title);
			geometry.run = region.run;
		}
	}
}

/** Ordinary Containers are opaque to LayoutBox. Only their last native render can supply child offsets.
 * A recorded host is also opaque: its replaced render deliberately does not update native mouseLayout. */
function walkCached(component: object, width: number, height: number, row: number, top: number, end: number, ledger: Ledger): void {
	const region = regions.get(component);
	if (region) {
		if (region.width === width && region.height === height) addRegion(ledger, component, region, row, top, end);
		return;
	}
	const container = component as CachedComponent;
	const cache = container.mouseLayout;
	if (!cache || cache.width !== width || !Array.isArray(cache.children)
		|| cache.children.length !== container.children?.length) return;
	let total = 0;
	for (let index = 0; index < cache.children.length; index++) {
		const child = cache.children[index];
		if (child.component !== container.children[index] || !size(child.height)) return;
		total += child.height;
	}
	if (total !== height) return;
	let offset = row;
	for (const child of cache.children) {
		walkCached(child.component, width, child.height, offset, Math.max(top, offset), Math.min(end, offset + child.height), ledger);
		offset += child.height;
	}
}

function walkBox(box: LayoutBox, origin: number, ledger: Ledger, top = -Infinity, end = Infinity): void {
	if (!rect(box?.rect) || !rect(box.clip) || !Array.isArray(box.children) || box.clip.width === 0) return;
	const row = box.rect.y - origin;
	top = Math.max(top, row);
	end = Math.min(end, row + box.rect.height);
	if (regions.has(box.component) || box.children.length === 0) {
		walkCached(box.component, box.rect.width, box.lines?.length ?? box.rect.height,
			row - (box.lineOffset ?? 0), top, end, ledger);
		return;
	}
	// Nested scrollports are separate documents, not part of this transcript's ledger.
	if (box.scrollView) return;
	for (const child of box.children) walkBox(child, origin, ledger, top, end);
}

function scrollBox(box: LayoutBox, scroll: Scroll): LayoutBox | undefined {
	if (!box || !Array.isArray(box.children)) return undefined;
	if (box.scrollView === scroll) return box;
	for (const child of box.children) {
		const found = scrollBox(child, scroll);
		if (found) return found;
	}
	return undefined;
}

function usable(renderer: Renderer): boolean {
	return renderer.mode === "fullscreen" && renderer.stopped !== true && typeof renderer.hasOverlay === "function";
}
function current(state: RendererState, viewport: Viewport): boolean {
	const { renderer } = state;
	return usable(renderer) && renderer.currentLayout === viewport.frame
		&& viewport.frame.primaryScrollView === viewport.scroll
		&& viewport.scroll.children?.[0] === viewport.document.component
		&& viewport.scroll.scrollTop === viewport.scrollTop
		&& viewport.scroll.isFollowingEnd === viewport.followingEnd
		&& (!renderer.terminal || (renderer.terminal.columns === viewport.frame.width && renderer.terminal.rows === viewport.frame.height));
}

function clearReceivers(state: RendererState): void {
	for (const component of state.components) if (receivers.get(component) === state) receivers.delete(component);
	state.components.clear();
}
function notify(owner: object, selection?: Selection): void {
	const previous = selected.get(owner);
	if (previous?.state === selection?.state && previous?.control.run.id === selection?.control.run.id) {
		if (previous && selection) previous.control.run = selection.control.run;
		return;
	}
	if (selection) selected.set(owner, selection);
	else selected.delete(owner);
	for (const listener of listeners.get(owner) ?? []) listener(selection?.control);
}
function hide(state: RendererState): void {
	for (const [owner, selection] of selected) if (selection.state === state) notify(owner);
}
function cleanup(state: RendererState): void {
	if (pending?.state === state) pending = undefined;
	const undoLayout = state.undoLayout;
	state.undoLayout = undefined;
	try { undoLayout?.(); } catch { /* A later owner may have sealed the native instance. */ }
	state.viewport = undefined;
	clearReceivers(state);
	renderers.delete(state.renderer);
	hide(state);
}

function candidate(viewport: Viewport, owner: object): RunGeometry | undefined {
	const top = viewport.scrollTop + viewport.box.clip.y - viewport.box.rect.y;
	let best: RunGeometry | undefined;
	for (const geometry of viewport.ledger.get(owner)?.values() ?? []) {
		if (geometry.title === undefined || geometry.title >= top || geometry.end <= top
			|| !geometry.run.isValid() || !geometry.run.isExpanded()) continue;
		if (!best || geometry.title > best.title) best = geometry;
	}
	return best;
}
/** Compare document/run geometry without re-rendering children. Text-only updates (including
 * clocks/streaming) must not restart the dock feedback loop when no reading bounds changed.
 * Dock height and the resulting native scrollTop are deliberately not selection inputs. */
function sameDocumentLayout(before: Viewport, after: Viewport): boolean {
	if (before.scroll !== after.scroll || before.frame.root.component !== after.frame.root.component
		|| before.frame.width !== after.frame.width || before.frame.height !== after.frame.height
		|| before.overlay !== after.overlay || before.document.component !== after.document.component
		|| before.document.rect.width !== after.document.rect.width || before.document.rect.height !== after.document.rect.height
		|| before.box.rect.x !== after.box.rect.x || before.box.rect.y !== after.box.rect.y
		|| before.box.rect.width !== after.box.rect.width || before.box.clip.x !== after.box.clip.x
		|| before.box.clip.y !== after.box.clip.y || before.box.clip.width !== after.box.clip.width) return false;
	if (before.ledger.size !== after.ledger.size) return false;
	for (const [owner, runs] of after.ledger) {
		const oldRuns = before.ledger.get(owner);
		if (oldRuns?.size !== runs.size) return false;
		for (const [id, geometry] of runs) {
			const old = oldRuns.get(id);
			if (!old || old.run !== geometry.run || old.title !== geometry.title || old.end !== geometry.end
				|| old.expanded !== geometry.expanded || old.components.size !== geometry.components.size) return false;
			for (const component of geometry.components) if (!old.components.has(component)) return false;
		}
	}
	return true;
}
function publish(state: RendererState, preserve: boolean): void {
	const viewport = state.viewport;
	if (!viewport || !current(state, viewport) || state.renderer.hasOverlay()) { hide(state); return; }
	const owners = new Set(viewport.ledger.keys());
	for (const [owner, selection] of selected) if (selection.state === state) owners.add(owner);
	for (const owner of owners) {
		const previous = selected.get(owner);
		const retained = previous?.state === state ? viewport.ledger.get(owner)?.get(previous.control.run.id) : undefined;
		const geometry = preserve ? retained : candidate(viewport, owner);
		if (!geometry || geometry.title === undefined || !geometry.run.isValid() || !geometry.run.isExpanded()) {
			if (selected.get(owner)?.state === state) notify(owner);
			continue;
		}
		const control: AggregateViewportControl = {
			run: geometry.run,
			collapse: () => {
				const active = selected.get(owner);
				if (active?.control !== control || !state.viewport || !current(state, state.viewport)
					|| state.renderer.hasOverlay() || !control.run.isValid() || !control.run.isExpanded()
					|| !state.viewport.ledger.get(owner)?.has(control.run.id)) return;
				performToggle(state, control.run, 0);
			},
		};
		notify(owner, { state, control });
	}
}

/** This runs after the document has rendered but before layout.js translates and paints its box. */
function installLayoutHook(state: RendererState, scroll: Scroll): void {
	const original = scroll.updateLayout;
	const descriptor = Object.getOwnPropertyDescriptor(scroll, "updateLayout");
	let active = true;
	const wrapper = function(this: Scroll, contentHeight: number, viewportHeight: number, requestRender: () => void) {
		const transaction = active && state.inRender && pending?.state === state && this === scroll ? pending : undefined;
		const unmoved = transaction && this.scrollTop === transaction.viewport.scrollTop;
		original.call(this, contentHeight, viewportHeight, requestRender);
		if (!transaction || pending !== transaction) return;
		pending = undefined;
		const { viewport, run } = transaction;
		if (!unmoved || !usable(state.renderer) || state.renderer.hasOverlay() || state.renderer.currentLayout !== viewport.frame
			|| viewport.scroll !== scroll || scroll.children?.[0] !== viewport.document.component
			|| transaction.generation !== generation(run.owner) || !run.isValid() || run.isExpanded() === transaction.expanded
			|| !size(contentHeight) || !size(viewportHeight) || viewportHeight === 0) return;
		if (state.renderer.terminal && (state.renderer.terminal.columns !== viewport.frame.width || state.renderer.terminal.rows !== viewport.frame.height)) return;
		const ledger: Ledger = new Map();
		walkCached(scroll.children[0], viewport.document.rect.width, contentHeight, 0, 0, contentHeight, ledger);
		const title = ledger.get(run.owner)?.get(run.id)?.title;
		if (title === undefined) return;
		scroll.scrollTo(title - transaction.desiredRow, { disableFollow: true });
	};
	Object.defineProperty(wrapper, HOOK, { value: true });
	scroll.updateLayout = wrapper;
	state.undoLayout = () => {
		active = false;
		if (scroll.updateLayout !== wrapper) return;
		if (descriptor) Object.defineProperty(scroll, "updateLayout", descriptor);
		else delete (scroll as Partial<Scroll>).updateLayout;
	};
}

function capture(state: RendererState, unmoved: boolean): void {
	const frame = state.renderer.currentLayout;
	const scroll = frame?.primaryScrollView;
	const box = frame && scroll ? scrollBox(frame.root, scroll) : undefined;
	const document = box?.children[0];
	if (!usable(state.renderer) || !box || !document || !rect(box.rect) || !rect(box.clip) || !rect(document.rect)
		|| box.clip.width <= 0 || box.clip.height <= 0 || !size(scroll.scrollTop)
		|| document.rect.y !== box.rect.y - scroll.scrollTop
		|| typeof scroll.updateLayout !== "function" || typeof scroll.scrollTo !== "function"
		|| typeof scroll.getContentWidth !== "function" || scroll.children?.[0] !== document.component
		|| document.rect.width !== scroll.getContentWidth(box.rect.width)) {
		cleanup(state);
		return;
	}
	if (state.viewport?.scroll !== scroll) {
		state.undoLayout?.();
		installLayoutHook(state, scroll);
	}
	const ledger: Ledger = new Map();
	walkBox(document, document.rect.y, ledger);
	clearReceivers(state);
	for (const runs of ledger.values()) for (const geometry of runs.values()) for (const component of geometry.components) {
		state.components.add(component);
		receivers.set(component, state);
	}
	const previous = state.viewport;
	state.viewport = {
		frame, scroll, box, document, scrollTop: scroll.scrollTop,
		followingEnd: scroll.isFollowingEnd, overlay: state.renderer.hasOverlay(), ledger,
	};
	publish(state, unmoved && !!previous && sameDocumentLayout(previous, state.viewport));
}

function performToggle(state: RendererState | undefined, run: AggregateViewportRun, desiredOffset?: number): void {
	pending = undefined;
	const viewport = state?.viewport;
	const geometry = viewport?.ledger.get(run.owner)?.get(run.id);
	if (viewport && geometry?.title !== undefined && current(state, viewport) && !state.renderer.hasOverlay() && run.isValid()) {
		const clipInset = viewport.box.clip.y - viewport.box.rect.y;
		const row = geometry.title - viewport.scrollTop - clipInset;
		const desiredRow = clipInset + (desiredOffset ?? (row >= 0 && row < viewport.box.clip.height ? row : 0));
		pending = { state, viewport, run, generation: generation(run.owner), expanded: run.isExpanded(), desiredRow };
		// Suppress follow even when the old document is shorter than the viewport.
		viewport.scroll.scrollTo(viewport.scroll.scrollTop, { disableFollow: true });
	}
	try { run.toggle(); }
	catch (error) { pending = undefined; throw error; }
}

export function toggleAggregateViewportRun(component: object, run: AggregateViewportRun): void {
	const region = regions.get(component);
	const state = region && valid(region) && region.run.owner === run.owner && region.run.id === run.id ? receivers.get(component) : undefined;
	performToggle(state, run);
}

export function subscribeAggregateViewportControl(owner: object, listener: (control: AggregateViewportControl | undefined) => void): () => void {
	let subscriptions = listeners.get(owner);
	if (!subscriptions) listeners.set(owner, subscriptions = new Set());
	subscriptions.add(listener);
	listener(selected.get(owner)?.control);
	return () => {
		subscriptions.delete(listener);
		if (subscriptions.size === 0) listeners.delete(owner);
	};
}

export function resetAggregateViewportOwner(owner: object): void {
	generations.set(owner, generation(owner) + 1);
	if (pending?.run.owner === owner) pending = undefined;
	for (const state of renderers.values()) {
		state.viewport?.ledger.delete(owner);
		for (const component of state.components) {
			if (regions.get(component)?.run.owner !== owner) continue;
			state.components.delete(component);
			if (receivers.get(component) === state) receivers.delete(component);
		}
	}
	notify(owner);
}

export function patchAggregateViewport(): void {
	if (unpatch || retired) return;
	// Fullscreen is optional in the supported peer range; named imports would break older Pi versions.
	const native = (Tui as unknown as { TuiAltScreen?: { prototype: Record<PropertyKey, any> } }).TuiAltScreen?.prototype;
	if (!native || typeof native.doRender !== "function" || typeof native.stop !== "function") return;
	// A reload creates fresh module-local regions/listeners while the host class survives.
	// Retire the old dispatcher, rather than leaving new records behind an old hook.
	const previous = native[HOOK];
	if (previous) {
		if (typeof previous.retire === "function") previous.retire();
		else previous.active = false; // Legacy wrappers already support inert delegation.
	}
	const originalRender = native.doRender;
	const originalStop = native.stop;
	const renderDescriptor = Object.getOwnPropertyDescriptor(native, "doRender");
	const stopDescriptor = Object.getOwnPropertyDescriptor(native, "stop");
	const token = { active: true, retire() {
		retired = true;
		restoreAggregateViewport();
	} };
	const render = function(this: Renderer, ...args: unknown[]) {
		if (!token.active) return originalRender.apply(this, args);
		if (!usable(this)) {
			const previous = renderers.get(this);
			if (previous) cleanup(previous);
			return originalRender.apply(this, args);
		}
		let state = renderers.get(this);
		if (!state) renderers.set(this, state = { renderer: this, components: new Set(), inRender: false });
		// Native follow-end/clamping may move scrollTop during paint solely because the widget
		// mounted or unmounted. Only movement before native render is a new navigation decision.
		const unmoved = !!state.viewport && current(state, state.viewport);
		state.inRender = true;
		try {
			const result = originalRender.apply(this, args);
			state.inRender = false;
			if (token.active && renderers.get(this) === state) {
				try { capture(state, unmoved); }
				catch { cleanup(state); } // Unsupported native internals must not break an already painted frame.
			}
			return result;
		} finally {
			state.inRender = false;
			if (pending?.state === state) pending = undefined;
		}
	};
	const stop = function(this: Renderer, ...args: unknown[]) {
		if (token.active) {
			const state = renderers.get(this);
			if (state) cleanup(state);
		}
		return originalStop.apply(this, args);
	};
	Object.defineProperty(native, HOOK, { value: token, configurable: true });
	native.doRender = render;
	native.stop = stop;
	unpatch = () => {
		token.active = false;
		if (native.doRender === render) {
			if (renderDescriptor) Object.defineProperty(native, "doRender", renderDescriptor);
			else delete native.doRender;
		}
		if (native.stop === stop) {
			if (stopDescriptor) Object.defineProperty(native, "stop", stopDescriptor);
			else delete native.stop;
		}
		if (native[HOOK] === token) delete native[HOOK];
	};
}

export function restoreAggregateViewport(): void {
	unpatch?.();
	unpatch = undefined;
	pending = undefined;
	for (const state of renderers.values()) cleanup(state);
	regions = new WeakMap();
	receivers = new WeakMap();
}
