import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HERDR_BLOCKED_EVENT = "herdr:blocked";

export interface HerdrBlockedEventData {
	active: boolean;
	label?: string;
}

type EventAPI = Pick<ExtensionAPI, "events">;

/**
 * Emit Herdr's reserved blocked-state event without creating a hard runtime
 * dependency on Herdr. Pi's shared event bus is process-local, so non-Herdr
 * environments simply have no listener. Listener failures must never break
 * the Plan workflow.
 */
export function emitHerdrBlocked(pi: EventAPI, active: boolean, label?: string): void {
	const data: HerdrBlockedEventData = active && label ? { active, label } : { active };
	try {
		pi.events.emit(HERDR_BLOCKED_EVENT, data);
	} catch {
		// Optional integration: Plan behavior must remain unchanged if a listener fails.
	}
}

/** Mark a user-facing approval/question UI as blocked and always balance it. */
export async function withHerdrBlocked<T>(
	pi: EventAPI,
	label: string,
	operation: () => T | Promise<T>,
): Promise<T> {
	emitHerdrBlocked(pi, true, label);
	try {
		return await operation();
	} finally {
		emitHerdrBlocked(pi, false);
	}
}
