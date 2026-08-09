import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CompanionConfig } from "../src/config.ts";
import { applyBtwConfigCommand } from "../src/btw/parent.ts";
import {
	decideCacheMode,
	fingerprintActiveToolSchemas,
	fingerprintSystemPrompt,
} from "../src/btw/cache-mode.ts";
import {
	MERGE_TRANSCRIPT_BUDGET_BYTES,
	TRANSCRIPT_TRUNCATION_NOTE,
	buildMergeTranscript,
	isMergePromptWithinBounds,
	validateRequestAgainstPayload,
	type MergeRequest,
} from "../src/btw/protocol.ts";
import { parseBtwCommand } from "../src/btw/router.ts";
import {
	BTW_LAUNCH_DRAFT_COMMAND,
	buildChildPiArgs,
	createBtwPayload,
	isBtwPayload,
	type AgentMessage,
	type BtwPayload,
} from "../src/btw/types.ts";

function config(): CompanionConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CompanionConfig;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function assistant(text: string, extra: unknown[] = []): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...extra],
		provider: "test",
		model: "test",
		api: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	} as AgentMessage;
}

function payload(overrides: Partial<BtwPayload> = {}): BtwPayload {
	return createBtwPayload({
		createdAt: "2026-08-09T12:00:00.000Z",
		parentSessionId: "session-1",
		parentPaneId: "w1:p1",
		metadata: { generatedAt: "2026-08-09T12:00:00.000Z", cwd: "/work", session: "/session.jsonl", model: "openai/gpt" },
		parentSystemPrompt: "exact system",
		parentSystemPromptFingerprint: fingerprintSystemPrompt("exact system"),
		parentActiveTools: ["read", "herdr_process"],
		parentToolSchemaFingerprint: "ordered-schema-v1",
		parentThinkingLevel: "high",
		messages: [user("parent")],
		draftQuestion: "side question",
		config: config().btw,
		launchId: "launch-1",
		capability: "c".repeat(64),
		...overrides,
	});
}

describe("/btw parser and config", () => {
	it("routes only exact reserved first words and preserves ordinary questions", () => {
		expect(parseBtwCommand("")).toEqual({ kind: "open" });
		expect(parseBtwCommand("why merge conflicts happen")).toEqual({ kind: "ask", question: "why merge conflicts happen" });
		expect(parseBtwCommand("merge later?")).toEqual({ kind: "merge", prompt: "later?" });
		expect(parseBtwCommand("ask merge later?")).toEqual({ kind: "ask", question: "merge later?" });
		expect(parseBtwCommand("config tools none")).toEqual({ kind: "config", args: "tools none" });
	});

	it("changes only BTW defaults and validates bounded values", () => {
		const base = config();
		const changed = applyBtwConfigCommand(base, "tools read-only").config;
		expect(changed.btw.tools).toBe("read-only");
		expect(changed.process).toEqual(base.process);
		expect(applyBtwConfigCommand(changed, "model anthropic/sonnet").config.btw.model).toBe("anthropic/sonnet");
		expect(() => applyBtwConfigCommand(base, "thinking enormous")).toThrow(/\/btw config/);
	});
});

describe("BTW payload and cache path", () => {
	it("validates capability/session-bound payloads", () => {
		const value = payload();
		expect(isBtwPayload(value)).toBe(true);
		expect(isBtwPayload({ ...value, capability: "short" })).toBe(false);
		expect(isBtwPayload({ ...value, config: { ...value.config, tools: "write-everything" } })).toBe(false);
	});

	it("keeps context and capability off child argv; only a launch sentinel may be submitted", () => {
		const value = payload({ config: { ...config().btw, autoSubmit: true } });
		const args = buildChildPiArgs(value, "openai/gpt", "high");
		expect(args).toContain(BTW_LAUNCH_DRAFT_COMMAND);
		expect(args.join(" ")).not.toContain(value.capability);
		expect(args.join(" ")).not.toContain(value.draftQuestion);
		expect(args).toContain("read,herdr_process");
	});

	it("uses native replay only for exact model/tool-schema/thinking and a known parent prompt", () => {
		const value = payload();
		const actual = {
			model: "openai/gpt",
			activeTools: ["read", "herdr_process"],
			toolSchemaFingerprint: "ordered-schema-v1",
			thinkingLevel: "high",
		};
		expect(decideCacheMode(value, actual)).toEqual({ mode: "native" });
		expect(decideCacheMode({ ...value, config: { ...value.config, tools: "read-only" } }, actual))
			.toMatchObject({ mode: "flattened", reason: expect.stringContaining("tools") });
		expect(decideCacheMode(value, { ...actual, toolSchemaFingerprint: "changed" }))
			.toMatchObject({ mode: "flattened", reason: expect.stringContaining("schemas") });
		expect(decideCacheMode({ ...value, parentToolSchemaFingerprint: null }, actual))
			.toMatchObject({ mode: "flattened", reason: expect.stringContaining("fingerprint unavailable") });
		expect(decideCacheMode({ ...value, parentSystemPrompt: null }, actual))
			.toEqual({ mode: "flattened", reason: "parent system prompt or fingerprint unavailable" });
		expect(decideCacheMode({ ...value, parentSystemPrompt: "mutated" }, actual))
			.toEqual({ mode: "flattened", reason: "parent system prompt fingerprint mismatch" });
	});

	it("fingerprints ordered active schemas including descriptions, parameters, and guidelines", () => {
		const base = [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			promptGuidelines: ["Use read for files."],
			sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
		}] as unknown as ToolInfo[];
		const fingerprint = fingerprintActiveToolSchemas(["read"], base);
		expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(fingerprintActiveToolSchemas(["read"], [{ ...(base[0] as ToolInfo), description: "Changed" }]))
			.not.toBe(fingerprint);
		expect(fingerprintActiveToolSchemas(["missing"], base)).toBeNull();
	});
});

describe("merge protocol", () => {
	it("filters tool payloads/thinking and keeps user/assistant text", () => {
		const transcript = buildMergeTranscript([
			user("question"),
			assistant("answer", [
				{ type: "thinking", thinking: "private" },
				{ type: "toolCall", id: "x", name: "read", arguments: { path: "/secret" } },
			]),
			{ role: "toolResult", toolCallId: "x", toolName: "read", content: [{ type: "text", text: "payload" }], isError: false, timestamp: 0 } as AgentMessage,
		]);
		expect(transcript).toBe("User:\nquestion\n\nAssistant:\nanswer");
		expect(transcript).not.toContain("private");
		expect(transcript).not.toContain("payload");
		expect(transcript).not.toContain("/secret");
	});

	it("drops old turns and preserves a UTF-8-bounded tail", () => {
		const transcript = buildMergeTranscript([
			user("old ".repeat(10_000)),
			assistant("latest finding ".repeat(4_000)),
		], MERGE_TRANSCRIPT_BUDGET_BYTES);
		expect(transcript).toContain(TRANSCRIPT_TRUNCATION_NOTE);
		expect(Buffer.byteLength(transcript!, "utf8")).toBeLessThanOrEqual(MERGE_TRANSCRIPT_BUDGET_BYTES + 2);
		expect(transcript).toContain("latest finding");
	});

	it("binds each merge to launch, capability, and exact parent session", () => {
		const value = payload();
		const request: MergeRequest = {
			protocolVersion: 1,
			requestId: "request-1",
			launchId: value.launchId,
			parentSessionId: value.parentSessionId,
			capability: value.capability,
			createdAt: value.createdAt,
			summary: "summary",
			prompt: "continue",
		};
		expect(validateRequestAgainstPayload(request, value)).toBeUndefined();
		expect(validateRequestAgainstPayload({ ...request, capability: "x".repeat(64) }, value)).toBe("capability mismatch");
		expect(validateRequestAgainstPayload({ ...request, parentSessionId: "other" }, value)).toBe("parent session mismatch");
		expect(isMergePromptWithinBounds("x".repeat(16 * 1024 + 1))).toBe(false);
	});
});
