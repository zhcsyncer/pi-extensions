import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { recordAggregateViewportRegion, releaseAggregateViewportRegion, type AggregateViewportRun } from "./aggregate-viewport.js";

export interface AggregateClickRegion {
	startRow: number;
	endRow: number;
	onClick(): void;
}

interface HitMap {
	width: number;
	height: number;
	regions: readonly AggregateClickRegion[];
	native?: { left: number; top: number; width: number; height: number };
}

const hitMaps = new WeakMap<object, HitMap>();
const MOUSE_PATCH = Symbol.for("pi-tool-display-intent.aggregate-mouse.v2");
const LEGACY_MOUSE_PATCH = Symbol.for("pi-tool-display-intent.aggregate-mouse.v1");
const MODULE_OWNER = { retired: false };
type MouseHandler = (this: object, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
interface MousePatch {
	owner: typeof MODULE_OWNER;
	original?: MouseHandler;
	patched: MouseHandler;
	dispatch: (instance: object, event: TuiMouseEvent, original?: MouseHandler) => TuiMouseEventResult | undefined;
	owns: (instance: object) => boolean;
	enabled: boolean;
}
interface MousePrototype {
	handleMouse?: MouseHandler;
	[MOUSE_PATCH]?: MousePatch;
}

/** Even an empty owned map suppresses native hit regions from the replaced layout. */
export function recordAggregateClickRegions(
	instance: object,
	width: number,
	height: number,
	regions: readonly AggregateClickRegion[] = [],
	viewport?: { run: AggregateViewportRun; titleRow?: number },
): void {
	hitMaps.set(instance, { width, height, regions });
	if (viewport) recordAggregateViewportRegion(instance, { ...viewport, width, height });
	else releaseAggregateViewportRegion(instance);
}

export function releaseAggregateClickRegions(instance: object): void {
	hitMaps.delete(instance);
	releaseAggregateViewportRegion(instance);
}

/** Preserve native child dispatch only inside the body actually painted at this offset. */
export function recordAggregateNativeRegion(
	instance: object,
	width: number,
	height: number,
	native: NonNullable<HitMap["native"]>,
	regions: readonly AggregateClickRegion[] = [],
	viewport?: { run: AggregateViewportRun; titleRow?: number },
): void {
	recordAggregateClickRegions(instance, width, height, regions, viewport);
	hitMaps.get(instance)!.native = native;
}

function dispatch(instance: object, event: TuiMouseEvent, original?: MouseHandler): TuiMouseEventResult | undefined {
	const map = hitMaps.get(instance);
	if (!map || event.x < 0 || event.x >= map.width || event.y < 0 || event.y >= map.height) return undefined;
	if (event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl) {
		const region = map.regions.find((candidate) => event.y >= candidate.startRow && event.y < candidate.endRow);
		if (region) {
			region.onClick();
			return { handled: true };
		}
	}
	const body = map.native;
	if (!body || event.width !== map.width || event.x < body.left || event.x >= body.left + body.width
		|| event.y < body.top || event.y >= body.top + body.height) return undefined;
	// Absolute screen coordinates stay unchanged: native Container dispatch then
	// derives the correct capture/focus target, including nested child offsets.
	return original?.call(instance, {
		...event, x: event.x - body.left, y: event.y - body.top, width: body.width, height: body.height,
	});
}

export function patchAggregateMouseHandling(prototypeValue: object): void {
	if (MODULE_OWNER.retired) return;
	const prototype = prototypeValue as MousePrototype;
	const legacy = (prototypeValue as Record<symbol, { enabled: boolean } | undefined>)[LEGACY_MOUSE_PATCH];
	if (legacy) legacy.enabled = false;
	const existing = prototype[MOUSE_PATCH];
	if (existing) {
		if (existing.owner !== MODULE_OWNER) existing.owner.retired = true;
		existing.owner = MODULE_OWNER;
		existing.dispatch = dispatch;
		existing.owns = (instance) => hitMaps.has(instance);
		existing.enabled = true;
		return;
	}
	const state: MousePatch = {
		owner: MODULE_OWNER,
		original: prototype.handleMouse,
		patched(event) {
			if (state.enabled && state.owns(this)) return state.dispatch(this, event, state.original);
			return state.original?.call(this, event);
		},
		dispatch,
		owns: (instance) => hitMaps.has(instance),
		enabled: true,
	};
	prototype[MOUSE_PATCH] = state;
	prototype.handleMouse = state.patched;
}

export function restoreAggregateMouseHandling(prototypeValue: object): void {
	const prototype = prototypeValue as MousePrototype;
	const state = prototype[MOUSE_PATCH];
	if (!state || state.owner !== MODULE_OWNER) return;
	if (prototype.handleMouse === state.patched) {
		if (state.original) prototype.handleMouse = state.original;
		else delete prototype.handleMouse;
		delete prototype[MOUSE_PATCH];
	} else {
		state.enabled = false;
	}
}
