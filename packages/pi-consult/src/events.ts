import { appendFile, mkdir, readFile } from "node:fs/promises";
import { getConsultPaths } from "./paths.ts";
import type { ConsultEvent } from "./types.ts";
import { isRecord } from "./types.ts";

const ADOPT_FALSE = /^(?:不采纳|拒绝|reject|ignore)$/i;
const ADOPT_TRUE = /^(?:采纳|adopt)$/i;

export interface ConsultAdoption {
	adopted: boolean;
	reason: string;
}

interface ConsultAdoptionEvent {
	kind: "adoption";
	ts: string;
	session: string;
	adopted: boolean;
}

function adoptionValue(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	if (ADOPT_FALSE.test(value)) return false;
	if (ADOPT_TRUE.test(value)) return true;
	return undefined;
}

export function parseConsultLog(text: string): ConsultAdoption | undefined {
	const match = text.match(/CONSULT-LOG:\s*(.+)$/im);
	if (!match) return undefined;
	if (/\badopt\|reject\b/i.test(match[1])) return undefined;
	const parts = match[1].split("|").map((part) => part.trim());
	const firstDecision = adoptionValue(parts[0]);
	if (firstDecision !== undefined) {
		return { adopted: firstDecision, reason: parts.slice(1).join(" | ").trim() };
	}
	const legacyDecision = adoptionValue(parts[2]);
	if (legacyDecision !== undefined) {
		return { adopted: legacyDecision, reason: parts.slice(3).join(" | ").trim() };
	}
	return undefined;
}

export function parseConsultEvent(value: unknown): ConsultEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.ts !== "string" || typeof value.session !== "string") return undefined;
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
	if (value.adopted !== null && typeof value.adopted !== "boolean") return undefined;
	if (typeof value.tokensIn !== "number" || typeof value.tokensOut !== "number" || typeof value.costUsd !== "number") {
		return undefined;
	}
	return {
		ts: value.ts,
		session: value.session,
		trigger: value.trigger,
		why: value.why,
		models: value.models,
		verdict,
		adopted: value.adopted,
		tokensIn: value.tokensIn,
		tokensOut: value.tokensOut,
		cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
		cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
		costUsd: value.costUsd,
	};
}

function parseAdoptionEvent(value: unknown): ConsultAdoptionEvent | undefined {
	if (!isRecord(value) || value.kind !== "adoption") return undefined;
	if (typeof value.ts !== "string" || typeof value.session !== "string" || typeof value.adopted !== "boolean") {
		return undefined;
	}
	return { kind: "adoption", ts: value.ts, session: value.session, adopted: value.adopted };
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

export async function appendConsultAdoption(session: string, adopted: boolean, agentDir?: string): Promise<void> {
	await appendEventLine({ kind: "adoption", ts: new Date().toISOString(), session, adopted }, agentDir);
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
			if (!candidate || candidate.session !== adoption.session || candidate.adopted !== null) continue;
			events[index] = { ...candidate, adopted: adoption.adopted };
			break;
		}
	}
	return events.slice(-limit);
}
