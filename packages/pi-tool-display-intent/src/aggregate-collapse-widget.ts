import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { subscribeAggregateViewportControl, type AggregateViewportControl } from "./aggregate-viewport.js";

const WIDGET_KEY = "pi-tool-display-intent.ledger-collapse";

/** A normal layout component, not an overlay: native selection and scrolling keep working. */
export function createAggregateCollapseControl(
	getControl: () => AggregateViewportControl | undefined,
	tui: Pick<TUI, "mode" | "hasOverlay">,
	color: (text: string) => string,
): Component {
	let hitWidth = 0;
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
			const label = truncateToWidth(`↑ ${control.run.label()} · Collapse`, Math.floor(width), "…");
			hitWidth = visibleWidth(label);
			return [color(label)];
		},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl
				|| event.y !== 0 || event.x < 0 || event.x >= hitWidth) return undefined;
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
	const clear = () => {
		if (mounted) {
			try { ui?.setWidget(WIDGET_KEY, undefined); } catch { /* Replaced session UI. */ }
		}
		mounted = false;
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
