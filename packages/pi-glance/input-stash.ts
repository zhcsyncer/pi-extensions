export const INPUT_STASH_PRIMARY_SHORTCUT = "ctrl+s";
export const INPUT_STASH_SECONDARY_SHORTCUT = "ctrl+q";
export const INPUT_STASH_CONFIRM_WINDOW_MS = 1500;
export const INPUT_STASH_PREVIEW_LIMIT = 24;
export const INPUT_STASH_STATUS_KEY = "pi-glance.input-stash";

export type InputStashKey = "primary" | "secondary";
export type InputStashAction = "stash" | "restore" | "arm-confirm" | "overwrite" | "discard" | "noop";

export interface InputStashDecisionInput {
	readonly editorHasText: boolean;
	readonly slotHasContent: boolean;
	readonly confirmArmed: boolean;
	readonly key: InputStashKey;
}

export function inputHasText(text: string | undefined): boolean {
	return (text ?? "").trim().length > 0;
}

export function isInputStashConfirmArmed(armedAtMs: number | undefined, nowMs: number, windowMs = INPUT_STASH_CONFIRM_WINDOW_MS): boolean {
	return armedAtMs !== undefined && nowMs - armedAtMs < windowMs;
}

export function previewStashedDraft(text: string, limit = INPUT_STASH_PREVIEW_LIMIT): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(1, limit - 1))}…`;
}

export function formatInputStashConfirmPrompt(kind: "overwrite" | "discard", draft: string): string {
	const preview = previewStashedDraft(draft);
	const quoted = preview ? ` “${preview}”` : "";
	return kind === "discard"
		? `Press again to discard${quoted}`
		: `Press again to replace the current input with${quoted || " the stashed draft"}`;
}

export function resolveInputStashAction(input: InputStashDecisionInput): InputStashAction {
	if (input.key === "secondary") {
		if (!input.slotHasContent) return "noop";
		return input.confirmArmed ? "discard" : "arm-confirm";
	}
	if (input.editorHasText && !input.slotHasContent) return "stash";
	if (!input.editorHasText && input.slotHasContent) return "restore";
	if (input.editorHasText && input.slotHasContent) return input.confirmArmed ? "overwrite" : "arm-confirm";
	return "noop";
}
