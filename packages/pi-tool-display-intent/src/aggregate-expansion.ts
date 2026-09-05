import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const PATCH = Symbol.for("pi-tool-display-intent.aggregate-global-expansion.v1");
type Setter = (this: object, expanded: boolean) => void;
interface ExpansionPrototype {
	setToolsExpanded?: Setter;
	[PATCH]?: { original: Setter; patched: Setter; onChange?: (expanded: boolean) => void };
}

/** Observe the global command, including an empty transcript with no tool setters. */
export function patchAggregateGlobalExpansion(onChange: (expanded: boolean) => void): void {
	const prototype = InteractiveMode.prototype as unknown as ExpansionPrototype;
	const existing = prototype[PATCH];
	if (existing) {
		existing.onChange = onChange;
		return;
	}
	if (typeof prototype.setToolsExpanded !== "function") return;
	const state = {
		original: prototype.setToolsExpanded,
		patched: function (this: object, expanded: boolean) {
			state.onChange?.(expanded);
			state.original.call(this, expanded);
		},
		onChange: onChange as ((expanded: boolean) => void) | undefined,
	};
	prototype[PATCH] = state;
	prototype.setToolsExpanded = state.patched;
}

export function restoreAggregateGlobalExpansion(): void {
	const prototype = InteractiveMode.prototype as unknown as ExpansionPrototype;
	const state = prototype[PATCH];
	if (!state) return;
	if (prototype.setToolsExpanded === state.patched) {
		prototype.setToolsExpanded = state.original;
		delete prototype[PATCH];
	} else state.onChange = undefined;
}
