import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type HerdrProcessDetails } from "../src/process/tool.ts";
import {
	formatProcessLocation,
	renderHerdrProcessCall,
	renderHerdrProcessResult,
	sanitizeProcessDisplayText,
} from "../src/process/render.ts";
import {
	PROCESS_OWNER,
	PROCESS_STATE_VERSION,
	type ProcessEntry,
} from "../src/process/registry.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function entry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
	return {
		owner: PROCESS_OWNER,
		paneId: "w2:p7",
		terminalId: "term-managed",
		serverScope: "0123456789abcdef",
		workspaceId: "w2",
		tabId: "w2:t3",
		label: "dev",
		command: "pnpm dev",
		cwd: "/work",
		lifetime: "session",
		createdAt: "2026-08-11T00:00:00.000Z",
		ownerSessionId: "session-1",
		ownerPaneId: "w1:p1",
		shell: "bash",
		...overrides,
	};
}

function result(details: HerdrProcessDetails | undefined, text: string): AgentToolResult<HerdrProcessDetails> {
	return { content: [{ type: "text", text }], details } as AgentToolResult<HerdrProcessDetails>;
}

function context(expanded = false, isError = false, lastComponent?: any) {
	return { expanded, isError, cwd: "/work", lastComponent };
}

function rendered(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width);
}

describe("herdr_process TUI rendering", () => {
	it("renders compact action-specific calls and reuses the call component", () => {
		const first = renderHerdrProcessCall({
			action: "start",
			command: "pnpm dev\n--host 0.0.0.0",
			label: "web\u001b[31m",
			readyMatch: "Local:",
		}, theme, context(false));
		const collapsed = rendered(first, 52);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("Start process web");
		expect(collapsed[0]).not.toContain("\u001b");
		expect(visibleWidth(collapsed[0] ?? "")).toBeLessThanOrEqual(52);

		const expanded = renderHerdrProcessCall({
			action: "start",
			command: "pnpm dev",
			label: "web",
			readyMatch: "Local:",
		}, theme, context(true, false, first));
		expect(expanded).toBe(first);
		expect(rendered(expanded).join("\n")).toContain("readiness Local:");
	});

	it("summarizes process counts and expands current locations plus agent markers", () => {
		const dev = entry();
		const worker = entry({ paneId: "w2:p8", terminalId: "term-worker", label: "worker", lifetime: "persistent" });
		const details: HerdrProcessDetails = {
			action: "list",
			registry: { version: PROCESS_STATE_VERSION, entries: [dev, worker] },
			processStates: { "w2:p7": "running", "w2:p8": "exited" },
			processPanes: {
				"w2:p7": {
					paneId: "w2:p7",
					terminalId: "term-managed",
					workspaceId: "w2",
					tabId: "w2:t3",
					agent: "pi",
					agentStatus: "idle",
					hasAgentSession: true,
				},
			},
		};
		const collapsed = renderHerdrProcessResult(result(details, "model-facing list"), {
			expanded: false,
			isPartial: false,
		}, theme, context());
		expect(rendered(collapsed)).toEqual(["2 managed · ● 1 running · ✓ 1 exited"]);

		const expanded = renderHerdrProcessResult(result(details, "model-facing list"), {
			expanded: true,
			isPartial: false,
		}, theme, context(true));
		const text = rendered(expanded).join("\n");
		expect(text).toContain("dev running · w2 · t3 · p7");
		expect(text).toContain("◆ pi idle");
		expect(text).toContain("worker exited");
	});

	it("shows only a tail preview for logs and reveals bounded full output when expanded", () => {
		const details: HerdrProcessDetails = {
			action: "logs",
			registry: { version: PROCESS_STATE_VERSION, entries: [entry()] },
			paneId: "w2:p7",
			label: "dev",
		};
		const output = `[dev · w2:p7]\n${Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n")}`;
		const collapsed = renderHerdrProcessResult(result(details, output), {
			expanded: false,
			isPartial: false,
		}, theme, context());
		const collapsedText = rendered(collapsed).join("\n");
		expect(collapsedText).toContain("8 lines");
		expect(collapsedText).toContain("3 earlier lines");
		expect(collapsedText).not.toContain("line-1");
		expect(collapsedText).toContain("line-8");

		const expanded = renderHerdrProcessResult(result(details, output), {
			expanded: true,
			isPartial: false,
		}, theme, context(true));
		expect(rendered(expanded).join("\n")).toContain("line-1");
	});

	it("keeps errors visible, sanitizes terminal controls, and respects narrow widths", () => {
		const failure = result(undefined, "focus failed\u001b[2J\nrecovery: herdr_process list/stop");
		const collapsed = renderHerdrProcessResult(failure, {
			expanded: false,
			isPartial: false,
		}, theme, context(false, true));
		const lines = rendered(collapsed, 24);
		expect(lines[0]).toContain("✗ focus failed");
		expect(lines[0]).not.toContain("\u001b");
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);

		const expanded = renderHerdrProcessResult(failure, {
			expanded: true,
			isPartial: false,
		}, theme, context(true, true));
		expect(rendered(expanded).join("\n")).toContain("recovery: herdr_process list/stop");
	});

	it("formats stable layout addresses without repeating workspace prefixes", () => {
		expect(formatProcessLocation(entry())).toBe("w2 · t3 · p7");
		expect(sanitizeProcessDisplayText("ok\u001b[31m\u0000")).toBe("ok");
	});
});
