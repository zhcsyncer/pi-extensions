import { CustomMessageComponent, InteractiveMode, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	applyAggregateGroupFrame,
	attachExpandedAggregateSummary,
	getActiveAggregateProjection,
	padAggregateBlock,
	renderAggregateActivity,
	renderExpandedAggregateSummary,
	type AggregateProjection,
} from "./aggregate-activity.js";
import {
	patchAggregateMouseHandling,
	recordAggregateClickRegions,
	recordAggregateNativeRegion,
	releaseAggregateClickRegions,
	restoreAggregateMouseHandling,
	type AggregateClickRegion,
} from "./aggregate-interaction.js";

const PATCH = Symbol.for("pi-tool-display-intent.aggregate-custom-message.v1");
const MODULE_OWNER = { retired: false };
type NativeMethod = (this: any, ...args: any[]) => any;
interface MethodPatch {
	prototype: object;
	key: string;
	descriptor?: PropertyDescriptor;
	original: NativeMethod;
	patched: NativeMethod;
	impl: NativeMethod;
}
interface Replay {
	projection: AggregateProjection;
	ids: Array<string | undefined>;
	index: number;
	valid: boolean;
}
interface PatchState {
	owner: typeof MODULE_OWNER;
	releaseOwner(): void;
	methods: MethodPatch[];
	requests: WeakMap<object, () => void>;
	nativeOnly: WeakSet<object>;
	ownedComponents: WeakSet<object>;
	hostUi?: WeakRef<object>;
	mouseDescriptor?: PropertyDescriptor;
	originalMouse?: NativeMethod;
}
interface CustomComponent {
	message?: unknown;
}
interface Mode {
	chatContainer?: { children: unknown[] };
	ui?: { requestRender?(): void };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function installMethod(prototype: object, key: string): MethodPatch {
	const original = (prototype as Record<string, NativeMethod>)[key];
	const state: MethodPatch = {
		prototype, key, original, descriptor: Object.getOwnPropertyDescriptor(prototype, key),
		impl: original,
		patched: function(...args) { return state.impl.apply(this, args); },
	};
	Object.defineProperty(prototype, key, { configurable: true, writable: true, value: state.patched });
	return state;
}

/** The host lifecycle owns installation; message producers and session state are untouched. */
export function patchAggregateCustomMessages(): void {
	if (MODULE_OWNER.retired) return;
	const prototype = CustomMessageComponent.prototype;
	let state = (prototype as unknown as Record<symbol, PatchState>)[PATCH];
	if (state && state.owner !== MODULE_OWNER) state.releaseOwner();
	if (!state) {
		state = {
			owner: MODULE_OWNER,
			releaseOwner: () => {},
			requests: new WeakMap(),
			nativeOnly: new WeakSet(),
			ownedComponents: new WeakSet(),
			mouseDescriptor: Object.getOwnPropertyDescriptor(prototype, "handleMouse"),
			originalMouse: prototype.handleMouse,
			methods: [
				installMethod(prototype, "render"),
				installMethod(InteractiveMode.prototype, "addMessageToChat"),
				installMethod(InteractiveMode.prototype, "renderSessionEntries"),
			],
		};
		Object.defineProperty(prototype, PATCH, { configurable: true, value: state });
	}
	state.owner = MODULE_OWNER;
	state.releaseOwner = () => { MODULE_OWNER.retired = true; };
	const shared = state;
	const replays = new WeakMap<object, Replay>();
	const [render, addMessage, replayEntries] = shared.methods;
	// Cleanup may have restored some methods while retaining another outer wrapper.
	for (const method of shared.methods) {
		if ((method.prototype as Record<string, unknown>)[method.key] === method.original) {
			Object.defineProperty(method.prototype, method.key, { configurable: true, writable: true, value: method.patched });
		}
	}
	patchAggregateMouseHandling(prototype);

	replayEntries.impl = function(this: Mode, entries: unknown[], ...args: unknown[]) {
		const projection = getActiveAggregateProjection();
		if (!projection || (shared.hostUi?.deref() && shared.hostUi.deref() !== this.ui)) {
			return replayEntries.original.call(this, entries, ...args);
		}
		const previous = replays.get(this);
		const ids = projection.prepareCustomReplay(entries);
		const scope = { projection, ids, index: 0, valid: true };
		replays.set(this, scope);
		let completed = false;
		try {
			const result = replayEntries.original.call(this, entries, ...args);
			completed = true;
			return result;
		} finally {
			if (!completed || !scope.valid || scope.index !== ids.length) projection.discardCustomReplay();
			if (previous) replays.set(this, previous);
			else replays.delete(this);
		}
	};

	addMessage.impl = function(this: Mode, message: unknown, ...args: unknown[]) {
		if (shared.hostUi?.deref() && shared.hostUi.deref() !== this.ui) return addMessage.original.call(this, message, ...args);
		const source = record(message);
		if (source.role === "custom") {
			const projection = getActiveAggregateProjection();
			const replay = replays.get(this);
			let id: string | undefined;
			if (replay) {
				const index = replay.index++;
				id = replay.ids[index];
				replay.valid &&= replay.projection === projection && index < replay.ids.length
					&& (source.display === true) === (id !== undefined);
				if (!replay.valid) id = undefined;
			} else if (source.display === true) {
				id = projection?.ingestCustomMessage(message);
			}
			if (source.display === true && projection && id !== undefined) {
				projection.bindCustomMessage(message, id);
				shared.nativeOnly.delete(source);
				shared.requests.set(source, () => this.ui?.requestRender?.());
			} else {
				// A replay mismatch is not a live notification. Never attach it to the tail run.
				shared.nativeOnly.add(source);
			}
		}
		const result = addMessage.original.call(this, message, ...args);
		if (source.role === "custom" && source.display === true && !shared.nativeOnly.has(source)) {
			const component = this.chatContainer?.children.findLast((child) =>
				child instanceof CustomMessageComponent && record(child).message === message);
			if (component && typeof component === "object") shared.ownedComponents.add(component);
		}
		return result;
	};

	render.impl = function(this: CustomComponent, width: number): string[] {
		releaseAggregateClickRegions(this);
		const message = record(this.message);
		const projection = getActiveAggregateProjection();
		const id = projection?.getCustomMessageItemId(this.message);
		if (!projection || id === undefined || !shared.ownedComponents.has(this) || shared.nativeOnly.has(message) || message.display !== true) {
			return render.original.call(this, width);
		}
		projection.connectFrameRenderer(id, () => shared.requests.get(message)?.());
		recordAggregateClickRegions(this, width, 0);
		if (!Number.isFinite(width) || width <= 4) {
			projection.markFrameContentVisible(id, false);
			return [];
		}
		const innerWidth = Math.floor(width) - 4;
		// Native Container.render records child geometry. Do not rebuild, replace,
		// trim, or re-render its children separately: they may hold interaction state.
		const body: string[] = render.original.call(this, innerWidth);
		const visible = body.some((line) => stripTerminalSequences(line).trim().length > 0);
		projection.markFrameContentVisible(id, visible);
		if (!visible) return [];
		const theme = projection.getRenderTheme();
		const run = projection.getViewportRun(id);
		const toggle = () => projection.toggleGroupExpansionFromComponent(id, this);
		if (!projection.isItemExpanded(id)) {
			const view = projection.getView(id);
			if (!view) return [];
			const lines = padAggregateBlock(renderAggregateActivity(view, width, theme));
			recordAggregateClickRegions(this, width, lines.length,
				[{ startRow: 1, endRow: lines.length - 1, onClick: toggle }],
				run ? { run, titleRow: 1 } : undefined);
			return lines;
		}
		let lines = applyAggregateGroupFrame(body, width, theme, projection.getFrameEdge(id) ?? "only");
		let top = 0;
		const regions: AggregateClickRegion[] = [];
		if (projection.shouldHostExpandedSummary(id)) {
			const view = projection.getViewForGroup(id);
			if (view) {
				const header = renderExpandedAggregateSummary(view, width, theme);
				lines = attachExpandedAggregateSummary(header, lines);
				top = header.length > 0 ? 1 + header.length : 0;
				regions.push({ startRow: 1, endRow: top, onClick: toggle });
			}
		}
		recordAggregateNativeRegion(this, width, lines.length,
			{ left: 4, top, width: innerWidth, height: body.length }, regions,
			run ? { run, ...(top > 0 ? { titleRow: 1 } : {}) } : undefined);
		return lines;
	};
}

/** Pi reload rebuilds history BEFORE session_start installs UI-owned patches.
 * Borrow the public widget factory's TUI reference, without painting a widget,
 * and bind that already-built transcript in actual component order. */
export function bindExistingAggregateCustomMessages(ctx: ExtensionContext, projection: AggregateProjection): void {
	if (ctx?.hasUI === false || typeof ctx?.ui?.setWidget !== "function") return;
	const ids = projection.getCustomOccurrenceIds();
	const state = (CustomMessageComponent.prototype as unknown as Record<symbol, PatchState>)[PATCH];
	if (!state || state.owner !== MODULE_OWNER || getActiveAggregateProjection() !== projection) return;
	const key = "pi-tool-display-intent.custom-replay-binding";
	try {
		ctx.ui.setWidget(key, (tui) => {
			state.hostUi = new WeakRef(tui);
			const components: CustomMessageComponent[] = [];
			const seen = new Set<object>();
			const visit = (value: unknown): void => {
				if (!value || typeof value !== "object" || seen.has(value) || seen.size >= 100_000) return;
				seen.add(value);
				if (value instanceof CustomMessageComponent) {
					if (record(record(value).message).display === true) components.push(value);
					return;
				}
				const node = record(value);
				if (Array.isArray(node.children)) for (const child of node.children) visit(child);
				// Layout-node wrappers and ScrollView's content retain original components.
				for (const field of ["component", "child"]) visit(node[field]);
			};
			if (ids.length) visit(tui);
			// During compaction the old tree can still be mounted. Fail open until
			// native replay binds the new tree; never guess by text/timestamp.
			if (components.length === ids.length) {
				components.forEach((component, index) => {
					const message = record(component).message;
					state.ownedComponents.add(component);
					projection.bindCustomMessage(message, ids[index]);
					state.nativeOnly.delete(record(message));
					state.requests.set(record(message), () => tui.requestRender());
				});
			} else {
				projection.discardCustomReplay();
			}
			return { render: () => [], invalidate() {} };
		});
	} catch {
		// Unsupported host trees keep their native messages rather than crashing reload.
		projection.discardCustomReplay();
	} finally {
		try { ctx.ui.setWidget(key, undefined); } catch { /* The UI may already be disposed. */ }
	}
}

export function restoreAggregateCustomMessages(): void {
	const prototype = CustomMessageComponent.prototype;
	const state = (prototype as unknown as Record<symbol, PatchState>)[PATCH];
	if (!state || state.owner !== MODULE_OWNER) return;
	// Disable delegates even when an unrelated outer wrapper still references them.
	for (const method of state.methods) method.impl = method.original;
	restoreAggregateMouseHandling(prototype);
	if (!state.mouseDescriptor && prototype.handleMouse === state.originalMouse) {
		Reflect.deleteProperty(prototype, "handleMouse");
	}
	let retained = false;
	for (const method of state.methods) {
		const current = (method.prototype as Record<string, unknown>)[method.key];
		if (current !== method.patched) {
			retained ||= current !== method.original;
			continue;
		}
		if (method.descriptor) Object.defineProperty(method.prototype, method.key, method.descriptor);
		else Reflect.deleteProperty(method.prototype, method.key);
	}
	if (!retained) Reflect.deleteProperty(prototype, PATCH);
}
