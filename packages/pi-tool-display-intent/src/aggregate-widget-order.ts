import { InteractiveMode } from "@earendil-works/pi-coding-agent";

export const AGGREGATE_COLLAPSE_WIDGET_KEY = "pi-tool-display-intent.ledger-collapse";
const PATCH = Symbol.for("pi-tool-display-intent.aggregate-widget-order.v1");
type Host = { extensionWidgetsAbove?: Map<string, unknown> };
type Compose = (this: Host, container: unknown, widgets: Map<string, unknown>, ...options: unknown[]) => unknown;
interface OrderPatch {
	original: Compose;
	patched: Compose;
	owners: Set<object>;
}
interface Prototype {
	renderWidgetContainer?: Compose;
	[PATCH]?: OrderPatch;
}

/** Pi exposes placement but not ordering. Reorder only our entry at native composition time;
 * never mutate another extension's widget map, recreate its component, or enter the overlay stack. */
export function retainAggregateWidgetPriority(): () => void {
	const prototype = InteractiveMode.prototype as unknown as Prototype;
	let state = prototype[PATCH];
	if (!state) {
		if (typeof prototype.renderWidgetContainer !== "function" || !Object.isExtensible(prototype)) return () => {};
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "renderWidgetContainer");
		if (descriptor && ("writable" in descriptor ? !descriptor.writable : !descriptor.set)) return () => {};
		const original = prototype.renderWidgetContainer;
		const created: OrderPatch = {
			original, owners: new Set(),
			patched(container, widgets, ...options) {
				let ordered = widgets;
				if (created.owners.size > 0 && widgets === this.extensionWidgetsAbove && widgets instanceof Map
					&& widgets.has(AGGREGATE_COLLAPSE_WIDGET_KEY) && widgets.keys().next().value !== AGGREGATE_COLLAPSE_WIDGET_KEY) {
					ordered = new Map([[AGGREGATE_COLLAPSE_WIDGET_KEY, widgets.get(AGGREGATE_COLLAPSE_WIDGET_KEY)],
						...[...widgets].filter(([key]) => key !== AGGREGATE_COLLAPSE_WIDGET_KEY)]);
				}
				return created.original.call(this, container, ordered, ...options);
			},
		};
		state = created;
		Object.defineProperty(prototype, PATCH, { value: state, configurable: true });
		prototype.renderWidgetContainer = state.patched;
	}
	// The shared trampoline only retains opaque leases, not a module-local renderer/projection.
	// A late old module release therefore cannot remove a new session's ordering.
	const patch = state;
	const owner = {};
	patch.owners.add(owner);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		patch.owners.delete(owner);
		if (patch.owners.size !== 0 || prototype[PATCH] !== patch) return;
		if (prototype.renderWidgetContainer === patch.patched) {
			prototype.renderWidgetContainer = patch.original;
			delete prototype[PATCH];
		}
	};
}
