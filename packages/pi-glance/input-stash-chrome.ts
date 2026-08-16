export const INPUT_STASH_MARK_FULL = "stash";
export const INPUT_STASH_MARK_SHORT = "s";

export type InputStashChromeKind = "full" | "short" | "hidden";

export interface InputStashChromeInput {
	readonly occupied: boolean;
	readonly hasModeLabel: boolean;
	readonly hasScrollIndicator: boolean;
}

export function resolveInputStashChrome(input: InputStashChromeInput): InputStashChromeKind {
	if (!input.occupied) return "hidden";
	if (input.hasModeLabel || input.hasScrollIndicator) return "short";
	return "full";
}

export function inputStashMark(kind: InputStashChromeKind): string | undefined {
	if (kind === "full") return INPUT_STASH_MARK_FULL;
	if (kind === "short") return INPUT_STASH_MARK_SHORT;
	return undefined;
}
