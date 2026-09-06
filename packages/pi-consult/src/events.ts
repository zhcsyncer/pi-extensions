import { appendFile, mkdir, readFile } from "node:fs/promises";
import { getConsultPaths } from "./paths.ts";
import type { ConsultAdoptionEffect, ConsultEvent, ConsultOutcome } from "./types.ts";
import { isRecord } from "./types.ts";

const OUTCOMES = new Set<ConsultOutcome>(["completed", "blocked", "failed", "cancelled"]);
const ADOPTION_EFFECTS = new Set<ConsultAdoptionEffect>(["changed", "confirmed", "rejected"]);

export interface ConsultAdoption {
	adopted: boolean;
	effect: ConsultAdoptionEffect;
	reason: string;
}

interface ConsultAdoptionEvent {
	kind: "adoption";
	ts: string;
	session: string;
	toolCallId: string;
	adopted: boolean;
	effect: ConsultAdoptionEffect | null;
}

export function parseConsultLog(text: string): ConsultAdoption | undefined {
	const match = text.match(/CONSULT-LOG:\s*(.+)$/im);
	if (!match) return undefined;
	if (/\badopt\|reject\b|<reason>/i.test(match[1])) return undefined;
	const [decision, ...rest] = match[1].split("|").map((part) => part.trim());
	const payload = rest.join(" | ").trim();
	if (decision === "reject") {
		return payload ? { adopted: false, effect: "rejected", reason: payload } : undefined;
	}
	if (decision !== "adopt") return undefined;
	const effect = payload.match(/^(changed|confirmed)\s*:\s*(.+)$/i);
	if (!effect?.[1] || !effect[2]) return undefined;
	return {
		adopted: true,
		effect: effect[1].toLowerCase() as Extract<ConsultAdoptionEffect, "changed" | "confirmed">,
		reason: effect[2].trim(),
	};
}

export function parseConsultEvent(value: unknown): ConsultEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.ts !== "string" || typeof value.session !== "string" || typeof value.toolCallId !== "string") {
		return undefined;
	}
	if (value.trigger !== "onDemand" && value.trigger !== "watchdog") return undefined;
	if (typeof value.why !== "string") return undefined;
	if (!Array.isArray(value.models) || !value.models.every((model) => typeof model === "string")) return undefined;
	const verdict = value.verdict;
	if (
		verdict !== "recommend" &&
		verdict !== "confirm" &&
		verdict !== "revise" &&
		verdict !== "stop" &&
		verdict !== "split" &&
		verdict !== "error"
	) {
		return undefined;
	}
	if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome as ConsultOutcome)) return undefined;
	if (value.adopted !== null || value.adoptionEffect !== null) return undefined;
	if (typeof value.tokensIn !== "number" || typeof value.tokensOut !== "number" || typeof value.costUsd !== "number") {
		return undefined;
	}
	return {
		ts: value.ts,
		session: value.session,
		toolCallId: value.toolCallId,
		trigger: value.trigger,
		why: value.why,
		models: value.models,
		outcome: value.outcome as ConsultOutcome,
		verdict,
		adopted: null,
		adoptionEffect: null,
		tokensIn: value.tokensIn,
		tokensOut: value.tokensOut,
		cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
		cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
		costUsd: value.costUsd,
	};
}

function parseAdoptionEvent(value: unknown): ConsultAdoptionEvent | undefined {
	if (!isRecord(value) || value.kind !== "adoption") return undefined;
	if (
		typeof value.ts !== "string" ||
		typeof value.session !== "string" ||
		typeof value.toolCallId !== "string" ||
		typeof value.adopted !== "boolean" ||
		(value.effect !== null &&
			(typeof value.effect !== "string" || !ADOPTION_EFFECTS.has(value.effect as ConsultAdoptionEffect)))
	) {
		return undefined;
	}
	if (value.effect !== null && value.adopted !== (value.effect !== "rejected")) return undefined;
	return {
		kind: "adoption",
		ts: value.ts,
		session: value.session,
		toolCallId: value.toolCallId,
		adopted: value.adopted,
		effect: value.effect as ConsultAdoptionEffect | null,
	};
}

async function readEventLines(file: string): Promise<string[]> {
	try {
		const raw = await readFile(file, "utf8");
		return raw.split("\n");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

async function appendEventLine(value: ConsultEvent | ConsultAdoptionEvent, agentDir?: string): Promise<void> {
	const paths = getConsultPaths(agentDir);
	await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
	await appendFile(paths.eventsFile, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function appendConsultEvent(event: ConsultEvent, agentDir?: string): Promise<void> {
	await appendEventLine(event, agentDir);
}

export async function appendConsultAdoption(
	session: string,
	toolCallId: string,
	adoption: Pick<ConsultAdoption, "adopted" | "effect">,
	agentDir?: string,
): Promise<void> {
	await appendEventLine({ kind: "adoption", ts: new Date().toISOString(), session, toolCallId, ...adoption }, agentDir);
}

export async function readRecentEvents(limit: number, agentDir?: string): Promise<ConsultEvent[]> {
	const file = getConsultPaths(agentDir).eventsFile;
	const events: ConsultEvent[] = [];
	for (const line of await readEventLines(file)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		const event = parseConsultEvent(value);
		if (event) {
			events.push(event);
			continue;
		}
		const adoption = parseAdoptionEvent(value);
		if (!adoption) continue;
		for (let index = events.length - 1; index >= 0; index--) {
			const candidate = events[index];
			if (
				!candidate ||
				candidate.session !== adoption.session ||
				candidate.toolCallId !== adoption.toolCallId ||
				candidate.adopted !== null ||
				candidate.adoptionEffect !== null
			) {
				continue;
			}
			events[index] = { ...candidate, adopted: adoption.adopted, adoptionEffect: adoption.effect };
			break;
		}
	}
	return events.slice(-limit);
}
