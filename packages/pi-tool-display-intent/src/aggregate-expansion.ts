import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const PATCH = Symbol.for("pi-tool-display-intent.aggregate-global-expansion.v2");
const LEGACY_PATCH = Symbol.for("pi-tool-display-intent.aggregate-global-expansion.v1");
const MODULE_OWNER = { retired: false };
type Setter = (this: object, expanded: boolean) => void;
interface ExpansionPrototype {
	setToolsExpanded?: Setter;
	[PATCH]?: { owner: typeof MODULE_OWNER; original: Setter; patched: Setter; onChange?: (expanded: boolean) => void };
	[LEGACY_PATCH]?: { onChange?: (expanded: boolean) => void };
}

/** Observe the global command, including an empty transcript with no tool setters. */
export function patchAggregateGlobalExpansion(onChange: (expanded: boolean) => void): void {
	if (MODULE_OWNER.retired) return;
	const prototype = InteractiveMode.prototype as unknown as ExpansionPrototype;
	if (prototype[LEGACY_PATCH]) prototype[LEGACY_PATCH].onChange = undefined;
	const existing = prototype[PATCH];
	if (existing) {
		if (existing.owner !== MODULE_OWNER) existing.owner.retired = true;
		existing.owner = MODULE_OWNER;
		existing.onChange = onChange;
		return;
	}
	if (typeof prototype.setToolsExpanded !== "function") return;
	const state = {
		owner: MODULE_OWNER,
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
	if (!state || state.owner !== MODULE_OWNER) return;
	if (prototype.setToolsExpanded === state.patched) {
		prototype.setToolsExpanded = state.original;
		delete prototype[PATCH];
	} else state.onChange = undefined;
}
