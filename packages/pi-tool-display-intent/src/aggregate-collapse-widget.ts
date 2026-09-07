import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { subscribeAggregateViewportControl, type AggregateViewportControl } from "./aggregate-viewport.js";

import { AGGREGATE_COLLAPSE_WIDGET_KEY as WIDGET_KEY, retainAggregateWidgetPriority } from "./aggregate-widget-order.js";

/** A normal layout component, not an overlay: native selection and scrolling keep working. */
export function createAggregateCollapseControl(
	getControl: () => AggregateViewportControl | undefined,
	tui: Pick<TUI, "mode" | "hasOverlay">,
	color: (text: string) => string,
): Component {
	let hitWidth = 0;
	let hitLeft = 0;
	const available = () => {
		const control = getControl();
		return tui.mode === "fullscreen" && !tui.hasOverlay() && control?.run.isValid() && control.run.isExpanded()
			? control : undefined;
	};
	return {
		render(width) {
			hitWidth = 0;
			const control = available();
			if (!control || !Number.isFinite(width) || width < 1) return [];
			const rightEdge = Math.floor(width) - (width >= 2 ? 1 : 0);
			const label = truncateToWidth(`↑ ${control.run.label()} · Collapse`, rightEdge, "…");
			hitWidth = visibleWidth(label);
			hitLeft = Math.max(0, rightEdge - hitWidth);
			return [" ".repeat(hitLeft) + color(label)];
		},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl
				|| event.y !== 0 || event.x < hitLeft || event.x >= hitLeft + hitWidth) return undefined;
			const control = available();
			if (!control) return undefined;
			control.collapse();
			return { handled: true };
		},
		invalidate() { hitWidth = 0; },
	};
}

export function createAggregateCollapseWidget(owner: object): {
	bind(ctx: ExtensionContext): void;
	dispose(): void;
} {
	let ui: ExtensionContext["ui"] | undefined;
	let unsubscribe: (() => void) | undefined;
	let control: AggregateViewportControl | undefined;
	let mounted = false;
	let releasePriority: (() => void) | undefined;
	const clear = () => {
		if (mounted) {
			try { ui?.setWidget(WIDGET_KEY, undefined); } catch { /* Replaced session UI. */ }
		}
		mounted = false;
		releasePriority?.();
		releasePriority = undefined;
	};
	const dispose = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		control = undefined;
		clear();
		ui = undefined;
	};
	return {
		bind(ctx) {
			const next = ctx?.hasUI !== false && typeof ctx?.ui?.setWidget === "function" ? ctx.ui : undefined;
			if (ui === next && unsubscribe) return;
			dispose();
			if (!next) return;
			ui = next;
			unsubscribe = subscribeAggregateViewportControl(owner, (nextControl) => {
				const unchanged = control?.run === nextControl?.run;
				control = nextControl;
				if (!control) { clear(); return; }
				if (unchanged && mounted) return;
				try {
					releasePriority ??= retainAggregateWidgetPriority();
					next.setWidget(WIDGET_KEY, (tui, theme) => createAggregateCollapseControl(
						() => control, tui, (text) => (next.theme ?? theme).fg("accent", text),
					), { placement: "aboveEditor" });
					mounted = true;
				} catch {
					control = undefined;
					clear();
				}
			});
		},
		dispose,
	};
}
