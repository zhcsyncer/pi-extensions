import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendConsultAdoption,
	appendConsultEvent,
	parseConsultEvent,
	parseConsultLog,
	readRecentEvents,
} from "../src/events.ts";
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
	const merged = {
		ts: "2026-09-01T00:00:00.000Z",
		session: "sess-1",
		toolCallId: "consult-1",
		trigger: "onDemand" as const,
		why: "need a second opinion on the approach",
		models: ["anthropic/claude-fable-5"],
		outcome: "completed" as const,
		verdict: "revise" as const,
		adopted: null,
		adoptionEffect: null,
		tokensIn: 100,
		tokensOut: 20,
		costUsd: 0.5,
		...overrides,
	};
	return { ...merged, cacheRead: merged.cacheRead ?? 0, cacheWrite: merged.cacheWrite ?? 0 } as ConsultEvent;
}

describe("consult events jsonl", () => {
	it("appends one compact line with stable transcript linkage", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event(), directory);
		const raw = await readFile(getConsultPaths(directory).eventsFile, "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]) as ConsultEvent;
		expect(parsed.toolCallId).toBe("consult-1");
		expect(parsed.outcome).toBe("completed");
		expect(parsed.why).toBe("need a second opinion on the approach");
		expect(JSON.stringify(parsed)).not.toMatch(/You are an advisor|system prompt|conversation/);
	});

	it("folds adoption by session and toolCallId", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event(), directory);
		await appendConsultEvent(event({ session: "other", toolCallId: "consult-2" }), directory);
		await appendConsultAdoption("sess-1", "consult-1", { adopted: true, effect: "changed" }, directory);
		const events = await readRecentEvents(10, directory);
		expect(events.find((item) => item.toolCallId === "consult-1")?.adoptionEffect).toBe("changed");
		expect(events.find((item) => item.toolCallId === "consult-2")?.adoptionEffect).toBeNull();
	});

	it("rejects removed trigger, verdict, and unlinked event values", () => {
		expect(parseConsultEvent({ ...event(), trigger: "pull" })).toBeUndefined();
		expect(parseConsultEvent({ ...event(), verdict: "plan" })).toBeUndefined();
		expect(parseConsultEvent({ ...event(), toolCallId: undefined })).toBeUndefined();
		expect(parseConsultEvent({ ...event(), outcome: undefined })).toBeUndefined();
		expect(parseConsultEvent({ ...event(), adopted: undefined })).toBeUndefined();
		expect(parseConsultEvent({ ...event(), adoptionEffect: undefined })).toBeUndefined();
	});

	it("serializes concurrent appends without losing events", async () => {
		const directory = await agentDir();
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				appendConsultEvent(event({ ts: String(index), session: `sess-${index}`, toolCallId: `consult-${index}` }), directory),
			),
		);
		const events = await readRecentEvents(100, directory);
		expect(events).toHaveLength(20);
		expect(new Set(events.map((item) => item.toolCallId)).size).toBe(20);
	});

	it("does not lose a consult append racing with an adoption append", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event(), directory);
		await Promise.all([
			appendConsultAdoption("sess-1", "consult-1", { adopted: true, effect: "confirmed" }, directory),
			appendConsultEvent(event({ ts: "second", session: "sess-2", toolCallId: "consult-2" }), directory),
		]);
		const events = await readRecentEvents(10, directory);
		expect(events).toHaveLength(2);
		expect(events.find((item) => item.toolCallId === "consult-1")?.adoptionEffect).toBe("confirmed");
		expect(events.find((item) => item.toolCallId === "consult-2")?.adoptionEffect).toBeNull();
	});

	it("associates out-of-order adoption records with their exact calls", async () => {
		const directory = await agentDir();
		await appendConsultEvent(event({ toolCallId: "consult-1" }), directory);
		await appendConsultEvent(event({ toolCallId: "consult-2" }), directory);
		await appendConsultAdoption("sess-1", "consult-1", { adopted: true, effect: "confirmed" }, directory);
		await appendConsultAdoption("sess-1", "consult-1", { adopted: true, effect: "changed" }, directory);
		await appendConsultAdoption("sess-1", "consult-1", { adopted: true, effect: "rejected" }, directory);
		await appendConsultAdoption("sess-1", "consult-2", { adopted: false, effect: "rejected" }, directory);
		const events = await readRecentEvents(10, directory);
		expect(events.find((item) => item.toolCallId === "consult-1")?.adoptionEffect).toBe("confirmed");
		expect(events.find((item) => item.toolCallId === "consult-2")?.adoptionEffect).toBe("rejected");
	});

	it("defaults absent cache fields without weakening linkage fields", () => {
		const current = event();
		const { cacheRead: _cacheRead, cacheWrite: _cacheWrite, ...withoutCache } = current;
		expect(parseConsultEvent(withoutCache)).toMatchObject({
			toolCallId: "consult-1",
			outcome: "completed",
			adopted: null,
			adoptionEffect: null,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("parses changed, confirmed, and rejected CONSULT-LOG effects", () => {
		expect(parseConsultLog("CONSULT-LOG: adopt | changed: tests exposed a different boundary")).toEqual({
			adopted: true,
			effect: "changed",
			reason: "tests exposed a different boundary",
		});
		expect(parseConsultLog("CONSULT-LOG: adopt | confirmed: primary evidence agrees")).toEqual({
			adopted: true,
			effect: "confirmed",
			reason: "primary evidence agrees",
		});
		expect(parseConsultLog("CONSULT-LOG: reject | primary evidence disagrees")).toEqual({
			adopted: false,
			effect: "rejected",
			reason: "primary evidence disagrees",
		});
		expect(parseConsultLog("CONSULT-LOG: adopt | ambiguous old reason")).toBeUndefined();
		expect(parseConsultLog("CONSULT-LOG: adopt | changed: <reason>")).toBeUndefined();
		expect(parseConsultLog("CONSULT-LOG: adopt|reject | <reason>")).toBeUndefined();
		expect(parseConsultLog("no log here")).toBeUndefined();
	});
});
