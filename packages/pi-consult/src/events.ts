import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConsultPaths } from "./paths.ts";
import type { ConsultEvent } from "./types.ts";
import { isRecord } from "./types.ts";

const ADOPT_FALSE = /不采纳|拒绝|\breject\b|\bignore\b/i;
const ADOPT_TRUE = /采纳|\badopt\b/i;

export function parseConsultLog(text: string): { adopted: boolean } | undefined {
	const match = text.match(/CONSULT-LOG:\s*(.+)$/im);
	if (!match) return undefined;
	const line = match[1];
	const parts = line.split("|").map((part) => part.trim());
	const decision = parts.length >= 3 ? parts[2] : line;
	if (ADOPT_FALSE.test(decision)) return { adopted: false };
	if (ADOPT_TRUE.test(decision)) return { adopted: true };
	return undefined;
}

export function parseConsultEvent(value: unknown): ConsultEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.ts !== "string" || typeof value.session !== "string") return undefined;
	if (value.trigger !== "pull" && value.trigger !== "loop" && value.trigger !== "done") return undefined;
	if (typeof value.why !== "string") return undefined;
	if (!Array.isArray(value.models) || !value.models.every((model) => typeof model === "string")) return undefined;
	const verdict = value.verdict;
	if (
		verdict !== "plan" &&
		verdict !== "correction" &&
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
		costUsd: value.costUsd,
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

async function writeLinesAtomically(file: string, lines: string[]): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	const body = lines.filter((line, index) => line.length > 0 || index < lines.length - 1).join("\n");
	const contents = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`;
	try {
		await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function appendConsultEvent(event: ConsultEvent, agentDir?: string): Promise<void> {
	const file = getConsultPaths(agentDir).eventsFile;
	const lines = await readEventLines(file);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	lines.push(JSON.stringify(event));
	await writeLinesAtomically(file, [...lines, ""]);
}

export async function backfillAdopted(session: string, adopted: boolean, agentDir?: string): Promise<boolean> {
	const file = getConsultPaths(agentDir).eventsFile;
	const lines = await readEventLines(file);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index].trim();
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			continue;
		}
		const event = parseConsultEvent(parsed);
		if (!event || event.session !== session || event.adopted !== null) continue;
		lines[index] = JSON.stringify({ ...event, adopted });
		await writeLinesAtomically(file, lines);
		return true;
	}
	return false;
}

export async function readRecentEvents(limit: number, agentDir?: string): Promise<ConsultEvent[]> {
	const file = getConsultPaths(agentDir).eventsFile;
	const events: ConsultEvent[] = [];
	for (const line of await readEventLines(file)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event = parseConsultEvent(JSON.parse(trimmed) as unknown);
			if (event) events.push(event);
		} catch {
			// skip malformed lines
		}
	}
	return events.slice(-limit);
}

export function summarizeEvents(events: ConsultEvent[]): string {
	if (events.length === 0) return "No consult events yet.";
	return events
		.map((event) => {
			const adopted = event.adopted === null ? "pending" : event.adopted ? "adopted" : "rejected";
			return `${event.ts.slice(0, 19)} ${event.verdict} (${event.trigger}, ${adopted})`;
		})
		.join("\n");
}
