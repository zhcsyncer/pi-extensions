import { stableStringify } from "./inventory.ts";
import { CONSULT_TOOL_NAME } from "./messages.ts";

export const SUBSTANTIVE_TOOLS = new Set(["edit", "write"]);

export interface ToolFingerprintEvent {
	name: string;
	fingerprint: string;
	isError: boolean;
}

export interface FingerprintState {
	recent: ToolFingerprintEvent[];
}

export function emptyFingerprintState(): FingerprintState {
	return { recent: [] };
}

export function toolFingerprint(toolName: string, input: unknown): string {
	return `${toolName}:${stableStringify(input ?? null)}`;
}

export function recordToolEvent(
	state: FingerprintState,
	event: { name: string; input: unknown; isError: boolean },
): FingerprintState {
	if (event.name === CONSULT_TOOL_NAME) return state;
	return {
		recent: [
			...state.recent,
			{
				name: event.name,
				fingerprint: toolFingerprint(event.name, event.input),
				isError: event.isError,
			},
		],
	};
}

export function loopGateReason(state: FingerprintState, n: number): "same" | "error" | undefined {
	if (n <= 0 || state.recent.length < n) return undefined;
	const last = state.recent.slice(-n);
	if (last.every((event) => event.fingerprint === last[0]?.fingerprint)) return "same";
	if (last.every((event) => event.isError)) return "error";
	return undefined;
}

export function hadSubstantiveOutput(state: FingerprintState): boolean {
	return state.recent.some((event) => SUBSTANTIVE_TOOLS.has(event.name));
}
