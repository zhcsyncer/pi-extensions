import type { GradedEffort } from "./types.ts";

export const CONSULT_TOOL_NAME = "consult";
export const TOOL_LABEL = "Consult";

export const NONE_VALUE = "__none__";
export const OFF_VALUE = "__off__";

export const DEFAULT_EFFORT: GradedEffort = "high";

export const MSG_CONSULT_NUDGE = "Please advise on the executor's situation above.";
export const MSG_REQUIRES_INTERACTIVE = "/consult requires interactive mode";
export const MSG_PERSIST_FAILED = "Failed to save consult configuration";
export const MSG_CONSULT_DISABLED = "Consult disabled (empty panel)";
export const MSG_CONSULT_LOG_HINT =
	"In your next visible reply, use exactly one CONSULT-LOG form:\n" +
	"CONSULT-LOG: adopt | changed: <reason>\n" +
	"CONSULT-LOG: adopt | confirmed: <reason>\n" +
	"CONSULT-LOG: reject | <reason>";

export const ERR_NO_PANEL = "No consult panel is configured. The user can enable one with /consult.";
export const ERR_NO_PANEL_DETAIL = "no panel configured";
export const ERR_NO_MODEL = "Configured consult models are not available in this session.";
export const ERR_NO_MODEL_DETAIL = "panel models unavailable";
export const ERR_EMPTY_WHY = "consult.why is required: say in 1-2 sentences why you need a second opinion now.";
export const ERR_CALL_ABORTED = "Consult call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Consult returned no text content.";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";
export const ERR_BUDGET_RUN = "Consult run budget exhausted; do not retry until the next user message.";
export const ERR_BUDGET_SESSION = "Consult session budget exhausted.";

export const WATCHDOG_STEER_TEXT =
	"先 consult 再继续\nStop repeating the same tool call or the same error. Call consult({ why }) with a 1-2 sentence reason before continuing.";

export const errMisconfigured = (label: string, err: string) => `Consult (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Consult (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Consult call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Consult call threw: ${msg}`;
export const errModelUnavailable = (key: string) => `Configured consult model ${key} is no longer available`;
export const msgConsulting = (label: string, effort: string | undefined) =>
	`Consulting (${label}${effort ? `, ${effort}` : ""})…`;
export const msgConsultEnabled = (labels: string[]) =>
	labels.length === 0 ? MSG_CONSULT_DISABLED : `Consult panel: ${labels.join(" + ")}`;
