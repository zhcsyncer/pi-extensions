export const DEFAULT_PROMPT_SNIPPET =
	"Use consult for explicit advisor requests, consequential unresolved structural choices, or genuinely stuck approaches";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Call `consult` alone with a required `why` (1-2 sentences) and wait for its result before other tools only when the user explicitly asks for an advisor, or before choosing among ≥2 materially different approaches with lasting or high-cost consequences when current evidence does not favor one.",
	"Call `consult` when the same error has been patched twice without holding, or when you are about to abandon the current approach.",
	"Do not call `consult` merely because multiple options can be named. Answer or act directly when the user has already decided, is asking for your own assessment rather than an advisor, the choice is reversible (including routine UI, default, or calibration choices), or tool output already dictates the next mechanical step.",
	"Treat advisor output as a challenge, not authority. Adopt it only when it improves or validates the decision; rejecting it with evidence is a valid outcome.",
	"If evidence points one way and consult points another, reject the advice with a reason. Ask again or ask the user only when the conflict remains material and unresolved; never quietly change course.",
	"After each completed `consult` result, the next visible reply must use exactly one form: `CONSULT-LOG: adopt | changed: <reason>`, `CONSULT-LOG: adopt | confirmed: <reason>`, or `CONSULT-LOG: reject | <reason>`. If the run budget blocks consult, do not retry until the next user message.",
];
