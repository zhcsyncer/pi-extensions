/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Off-costs-nothing: strip consult from the active set when there is no usable
 * panel or the current executor is on disabledForModels.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONSULT_TOOL_NAME } from "./messages.ts";
import { canonicalModelKey, type ConsultConfig } from "./types.ts";

export function isConsultBlocked(config: ConsultConfig, currentModelKey: string | undefined): boolean {
	if (config.panel.length === 0) return true;
	if (!currentModelKey) return false;
	const current = canonicalModelKey(currentModelKey);
	return config.disabledForModels.some((entry) => canonicalModelKey(entry) === current);
}

export function reconcileConsultTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { blocked: boolean; notify?: { disabled: string; restored: string } },
): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(CONSULT_TOOL_NAME);
	if (opts.blocked && hasTool) {
		pi.setActiveTools(active.filter((name) => name !== CONSULT_TOOL_NAME));
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.disabled, "info");
	} else if (!opts.blocked && !hasTool) {
		pi.setActiveTools([...active, CONSULT_TOOL_NAME]);
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.restored, "info");
	}
}
