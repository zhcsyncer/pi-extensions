export const DEFAULT_PROMPT_SNIPPET =
	"Ask consult({ why }) for a second opinion before structural decisions or after repeated failure";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Call `consult` alone with a required `why` (1-2 sentences) before choosing among ≥2 approaches that will shape later structure; wait for its result before calling other tools.",
	"Call `consult` when the same error has been patched twice without holding, or when you are about to abandon the current approach.",
	"Do not call `consult` for short mechanical steps whose next action is already dictated by the tool output you just read.",
	"Give the advisor's advice serious weight. Empirical failure or primary-source evidence beats the suggestion; a passing self-test is not enough to dismiss it.",
	"If evidence points one way and consult points another, do not silently switch — surface the conflict and ask once more, or ask the user. Never quietly change course.",
	"After each `consult` result, the next visible reply must declare adopt or reject with a reason as a `CONSULT-LOG:` line.",
];
