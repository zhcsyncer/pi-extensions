import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendConsultEvent, backfillAdopted, parseConsultLog, readRecentEvents } from "../src/events.ts";
import { getConsultPaths } from "../src/paths.ts";
import type { ConsultEvent } from "../src/types.ts";

const cleanup = new Set<string>();

afterEach(async () => {
	await Promise.all([...cleanup].map((directory) => rm(directory, { recursive: true, force: true })));
	cleanup.clear();
});

async function agentDir(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-consult-events-"));
	cleanup.add(directory);
	return directory;
}

function event(overrides: Partial<ConsultEvent> = {}): ConsultEvent {
	return {
		ts: "2026-09-01T00:00:00.000Z",
		session: "sess-1",
		trigger: "pull",
		why: "need a second opinion on the approach",
		models: ["anthropic/claude-fable-5"],
		verdict: "correction",
		adopted: null,
		tokensIn: 100,
		tokensOut: 20,
		costUsd: 0.5,
		...overrides,
	};
}

describe("consult events jsonl", () => {
	it("appends one compact line and never stores transcript text", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event(), directory);
		const raw = await readFile(getConsultPaths(directory).eventsFile, "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]) as ConsultEvent;
		expect(parsed.why).toBe("need a second opinion on the approach");
		expect(JSON.stringify(parsed)).not.toMatch(/You are an advisor|system prompt|conversation/);
	});

	it("backfills adopted on the latest pending event for the session", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event({ ts: "1" }), directory);
		await appendConsultEvent(event({ ts: "2", session: "other" }), directory);
		expect(await backfillAdopted("sess-1", true, directory)).toBe(true);
		const events = await readRecentEvents(10, directory);
		expect(events.find((item) => item.ts === "1")?.adopted).toBe(true);
		expect(events.find((item) => item.session === "other")?.adopted).toBeNull();
	});

	it("parses CONSULT-LOG adopt, reject, reasons, and the legacy shape", () => {
		expect(parseConsultLog("hello\nCONSULT-LOG: adopt | tests failed\n")).toEqual({
			adopted: true,
			reason: "tests failed",
		});
		expect(parseConsultLog("CONSULT-LOG: 不采纳 | 证据相反")).toEqual({
			adopted: false,
			reason: "证据相反",
		});
		expect(parseConsultLog("CONSULT-LOG: approach | stop editing | adopt | tests failed")).toEqual({
			adopted: true,
			reason: "tests failed",
		});
		expect(parseConsultLog("CONSULT-LOG: reject | I would adopt extra complexity")).toEqual({
			adopted: false,
			reason: "I would adopt extra complexity",
		});
		expect(parseConsultLog("CONSULT-LOG: adopt | first | second")).toEqual({
			adopted: true,
			reason: "first | second",
		});
		expect(parseConsultLog("CONSULT-LOG: adopt|reject | <reason>")).toBeUndefined();
		expect(parseConsultLog("no log here")).toBeUndefined();
	});
});
