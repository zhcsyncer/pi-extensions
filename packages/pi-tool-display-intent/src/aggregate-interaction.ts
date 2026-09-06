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
}

const hitMaps = new WeakMap<object, HitMap>();
const MOUSE_PATCH = Symbol.for("pi-tool-display-intent.aggregate-mouse.v1");
type MouseHandler = (this: object, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
interface MousePatch {
	original?: MouseHandler;
	patched: MouseHandler;
	dispatch: (instance: object, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
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

function dispatch(instance: object, event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const map = hitMaps.get(instance);
	if (!map || event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
	if (event.x < 0 || event.x >= map.width || event.y < 0 || event.y >= map.height) return undefined;
	const region = map.regions.find((candidate) => event.y >= candidate.startRow && event.y < candidate.endRow);
	if (!region) return undefined;
	region.onClick();
	return { handled: true };
}

export function patchAggregateMouseHandling(prototypeValue: object): void {
	const prototype = prototypeValue as MousePrototype;
	const existing = prototype[MOUSE_PATCH];
	if (existing) {
		existing.dispatch = dispatch;
		existing.owns = (instance) => hitMaps.has(instance);
		existing.enabled = true;
		return;
	}
	const state: MousePatch = {
		original: prototype.handleMouse,
		patched(event) {
			if (state.enabled && state.owns(this)) return state.dispatch(this, event);
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
	if (!state) return;
	if (prototype.handleMouse === state.patched) {
		if (state.original) prototype.handleMouse = state.original;
		else delete prototype.handleMouse;
		delete prototype[MOUSE_PATCH];
	} else {
		state.enabled = false;
	}
}
