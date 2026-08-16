export const INPUT_STASH_PRIMARY_SHORTCUT = "ctrl+alt+s";
export const INPUT_STASH_SECONDARY_SHORTCUT = "ctrl+alt+u";
export const INPUT_STASH_CONFIRM_WINDOW_MS = 1500;

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

export function resolveInputStashAction(input: InputStashDecisionInput): InputStashAction {
	if (input.key === "secondary") return input.slotHasContent ? "discard" : "noop";
	if (input.editorHasText && !input.slotHasContent) return "stash";
	if (!input.editorHasText && input.slotHasContent) return "restore";
	if (input.editorHasText && input.slotHasContent) return input.confirmArmed ? "overwrite" : "arm-confirm";
	return "noop";
}
