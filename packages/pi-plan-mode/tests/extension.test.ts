import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import planModeExtension, {
	APPROVED_PLAN_MESSAGE_TYPE,
	PLAN_LIFECYCLE_ENTRY_TYPE,
	PLAN_MODE_SHORTCUT,
	PLAN_STEPS_SHORTCUT,
	REVISE_WORK_CHOICE,
	isPersistentSession,
} from "../extensions/plan-mode.ts";
import { getPlanModeConfigPath } from "../src/config.ts";
import { COMPLETE_PLAN_TOOL, SUBMIT_PLAN_TOOL } from "../src/policy.ts";

interface CustomEntry {
	type: "custom";
	customType: string;
	data: unknown;
}

type EventHandler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

class FakePi {
	activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	readonly activeToolHistory: string[][] = [];
	readonly tools = new Map<string, any>();
	readonly commands = new Map<string, any>();
	readonly shortcuts = new Map<string, any>();
	readonly handlers = new Map<string, EventHandler[]>();
	readonly entries: CustomEntry[];
	readonly sentUserMessages: Array<{ content: string; options?: unknown }> = [];
	readonly sentMessages: Array<{ message: any; options?: unknown; activeTools: string[] }> = [];
	readonly messageRenderers = new Map<string, any>();
	readonly entryRenderers = new Map<string, any>();
	readonly flags = new Map<string, unknown>();
	readonly emittedEvents: Array<{ event: string; data: unknown }> = [];
	readonly events = {
		emit: (event: string, data: unknown) => this.emittedEvents.push({ event, data }),
	};
	onSendMessage?: () => void;

	constructor(entries: CustomEntry[] = []) {
		this.entries = entries;
	}

	api(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}

	on(name: string, handler: EventHandler): void {
		const handlers = this.handlers.get(name) ?? [];
		handlers.push(handler);
		this.handlers.set(name, handlers);
	}

	registerTool(definition: { name: string }): void {
		this.tools.set(definition.name, definition);
		this.activeTools = [...new Set([...this.activeTools, definition.name])];
	}

	registerFlag(name: string, definition: { default?: unknown }): void {
		if (!this.flags.has(name)) this.flags.set(name, definition.default);
	}

	getFlag(name: string): unknown {
		return this.flags.get(name);
	}

	registerCommand(name: string, definition: unknown): void {
		this.commands.set(name, definition);
	}

	registerMessageRenderer(customType: string, renderer: unknown): void {
		this.messageRenderers.set(customType, renderer);
	}

	registerEntryRenderer(customType: string, renderer: unknown): void {
		this.entryRenderers.set(customType, renderer);
	}

	registerShortcut(shortcut: string, definition: unknown): void {
		this.shortcuts.set(shortcut, definition);
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	setActiveTools(tools: string[]): void {
		this.activeTools = [...tools];
		this.activeToolHistory.push([...tools]);
	}

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}

	sendUserMessage(content: string, options?: unknown): void {
		this.sentUserMessages.push({ content, options });
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.onSendMessage?.();
		this.sentMessages.push({ message, options, activeTools: [...this.activeTools] });
	}

	async emit(name: string, event: unknown, ctx: ExtensionContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(name) ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	}
}

interface FakeContextOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	sessionFile?: string;
	sessionId?: string;
	cwd?: string;
	entries?: CustomEntry[];
	choices?: Array<string | undefined>;
}

interface FakeContextHarness {
	ctx: ExtensionContext;
	notifications: Array<{ message: string; type?: string }>;
	terminal: { stops: number; starts: number; renders: number };
	widgets: Map<string, { content: any; placement?: string }>;
	renderWidget(key: string, width?: number): string[] | undefined;
}

function fakeContext(options: FakeContextOptions = {}): FakeContextHarness {
	const mode = options.mode ?? "tui";
	const notifications: Array<{ message: string; type?: string }> = [];
	const terminal = { stops: 0, starts: 0, renders: 0 };
	const widgets = new Map<string, { content: any; placement?: string }>();
	const choices = [...(options.choices ?? [])];
	const entries = options.entries ?? [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: options.cwd ?? process.cwd(),
		sessionManager: {
			getBranch: () => entries,
			getSessionFile: () => options.sessionFile,
			getSessionId: () => options.sessionId ?? "session-test",
		},
		ui: {
			theme,
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setWidget: (key: string, content: any, widgetOptions?: { placement?: string }) => {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, { content, placement: widgetOptions?.placement });
			},
			select: async () => choices.shift(),
			confirm: async () => choices.shift() === "confirm",
			custom: async (factory: any) => {
				let completed = false;
				let value: unknown;
				await factory(
					{
						stop: () => terminal.stops++,
						start: () => terminal.starts++,
						requestRender: () => terminal.renders++,
					},
					theme,
					{},
					(result: unknown) => {
						completed = true;
						value = result;
					},
				);
				if (!completed) throw new Error("Custom UI did not complete synchronously in the test harness");
				return value;
			},
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		notifications,
		terminal,
		widgets,
		renderWidget: (key, width = 100) => {
			const widget = widgets.get(key);
			if (!widget) return undefined;
			const component = typeof widget.content === "function"
				? widget.content({ terminal: { rows: 40 } }, theme)
				: { render: () => widget.content };
			return component.render(width);
		},
	};
}

function plain(text: string | undefined): string {
	return (text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
}

const cleanup = new Set<string>();

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all([...cleanup].map(async (directory) => {
		const { rm } = await import("node:fs/promises");
		await rm(directory, { recursive: true, force: true });
	}));
	cleanup.clear();
});

async function fakeRevdiff(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-plan-revdiff-test-"));
	cleanup.add(directory);
	const executable = path.join(directory, "revdiff-test.mjs");
	await writeFile(
		executable,
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst out = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);\nconst annotations = process.env.PLAN_MODE_TEST_ANNOTATIONS ?? "";\nif (out && annotations) writeFileSync(out, annotations);\nprocess.exit(Number(process.env.PLAN_MODE_TEST_EXIT ?? (annotations ? 10 : 0)));\n`,
		"utf8",
	);
	await chmod(executable, 0o700);
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("REVDIFF_BIN", executable);
	vi.stubEnv("PLAN_MODE_TEST_ANNOTATIONS", "");
	vi.stubEnv("PLAN_MODE_TEST_EXIT", "0");
	return executable;
}

async function turnPlanOn(pi: FakePi, ctx: ExtensionContext): Promise<void> {
	const command = pi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	await command.handler("on", ctx);
}

async function submitPlan(pi: FakePi, ctx: ExtensionContext, planId?: string) {
	const tool = pi.tools.get(SUBMIT_PLAN_TOOL);
	expect(tool).toBeDefined();
	return tool.execute(
		"submit-1",
		{
			...(planId ? { planId } : {}),
			title: "Implement simple Plan Mode",
			markdown: "# Goal\n\nImplement it.\n\n## Execution steps\n\n1. Change code\n2. Run tests\n\n## Verification\n\nRun tests.\n",
		},
		undefined,
		undefined,
		ctx,
	);
}

describe("Plan Mode extension lifecycle", () => {
	it("is completely inert outside TUI mode even when --plan is set", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-plan-non-tui-test-"));
		cleanup.add(agentDir);
		await writeFile(path.join(agentDir, "plan-mode.json"), "{", "utf8");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const pi = new FakePi();
		planModeExtension(pi.api());
		pi.flags.set("plan", true);
		const originalTools = [...pi.activeTools];
		const { ctx, notifications } = fakeContext({ mode: "print", entries: pi.entries });

		await pi.emit("session_start", { reason: "startup" }, ctx);

		expect(pi.tools.size).toBe(0);
		expect(pi.activeToolHistory).toHaveLength(0);
		expect(pi.activeTools).toEqual(originalTools);
		expect(pi.entries).toHaveLength(0);
		expect(notifications).toHaveLength(0);
		expect(await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx)).toBeUndefined();
	});

	it("warns at TUI startup and keeps Plan Mode disabled when revdiff is missing", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-plan-agent-config-test-"));
		cleanup.add(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("REVDIFF_BIN", path.join(tmpdir(), "missing-revdiff"));
		const pi = new FakePi();
		planModeExtension(pi.api());
		const originalTools = [...pi.activeTools];
		const harness = fakeContext({ entries: pi.entries });

		await pi.emit("session_start", { reason: "startup" }, harness.ctx);

		expect(pi.tools.size).toBe(0);
		expect(pi.activeTools).toEqual(originalTools);
		expect(harness.notifications.some(({ message }) => message.includes("revdiff is not installed"))).toBe(true);
		const command = pi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		await command.handler("on", harness.ctx);
		expect(pi.activeTools).toEqual(originalTools);
	});

	it("maps --plan to Plan Mode on during initial TUI startup", async () => {
		await fakeRevdiff();
		const pi = new FakePi();
		planModeExtension(pi.api());
		pi.flags.set("plan", true);
		const harness = fakeContext({ entries: pi.entries });

		await pi.emit("session_start", { reason: "startup" }, harness.ctx);

		expect(pi.activeTools).toEqual(["read", "grep", "find", "ls", SUBMIT_PLAN_TOOL]);
		for (const toolName of [SUBMIT_PLAN_TOOL, COMPLETE_PLAN_TOOL]) {
			const tool = pi.tools.get(toolName);
			expect(tool).toMatchObject({ renderShell: "self" });
			expect(tool.renderCall).toBeTypeOf("function");
			expect(tool.renderResult).toBeTypeOf("function");
		}
		const belowEntry = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "belowEditor");
		expect(belowEntry).toBeDefined();
		expect(harness.renderWidget(belowEntry![0])?.join("\n")).toContain("⏸ PLAN MODE · READ-ONLY");
	});

	it("loads zh-CN Plan content language into status and the planning prompt", async () => {
		const revdiff = await fakeRevdiff();
		const legacyConfigPath = path.join(path.dirname(revdiff), "plan-mode.json");
		const configPath = getPlanModeConfigPath(path.dirname(revdiff));
		await writeFile(legacyConfigPath, '{"contentLanguage":"zh-CN"}\n', "utf8");
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries });
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		const command = pi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		await command.handler("", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("Plan content language: zh-CN");
		expect(harness.notifications.at(-1)?.message).toContain(`Config: ${configPath}`);
		await turnPlanOn(pi, harness.ctx);
		const prompt = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("Configured content language: zh-CN");
		expect(prompt.systemPrompt).toContain("## 执行步骤");
		expect(prompt.systemPrompt).not.toContain("## Execution steps");
	});

	it("warns and falls back to auto for an invalid Plan Mode config", async () => {
		const revdiff = await fakeRevdiff();
		await writeFile(path.join(path.dirname(revdiff), "plan-mode.json"), '{"contentLanguage":"fr"}\n', "utf8");
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries });
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		expect(harness.notifications.some(({ message, type }) => type === "warning" && message.includes("Invalid Plan Mode config"))).toBe(true);
		await turnPlanOn(pi, harness.ctx);
		const prompt = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("Configured content language: auto");
	});

	it("supports /plan on|off, autocomplete, and the mode shortcut", async () => {
		await fakeRevdiff();
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries });
		const { ctx, notifications } = harness;
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const command = pi.commands.get("plan") as any;

		expect(command.getArgumentCompletions("").map((item: any) => item.value)).toEqual([
			"on",
			"off",
			"revise",
			"complete",
			"abandon",
		]);
		expect(command.getArgumentCompletions("o").map((item: any) => item.value)).toEqual(["on", "off"]);
		await command.handler("", ctx);
		expect(notifications.at(-1)?.message).toContain("Plan Mode: off");
		const stepsShortcut = pi.shortcuts.get(PLAN_STEPS_SHORTCUT) as { handler: (ctx: ExtensionContext) => void };
		stepsShortcut.handler(ctx);
		expect(notifications.at(-1)?.message).toBe("No current Plan.");

		await command.handler("on", ctx);
		expect(pi.activeTools).toEqual(["read", "grep", "find", "ls", SUBMIT_PLAN_TOOL]);
		const belowEntry = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "belowEditor");
		expect(belowEntry).toBeDefined();
		expect(harness.renderWidget(belowEntry![0])?.join("\n")).toContain("⏸ PLAN MODE · READ-ONLY");
		expect(await pi.emit("tool_call", { toolName: "read", input: {} }, ctx)).toBeUndefined();
		expect(await pi.emit("tool_call", { toolName: "unknown_custom_tool", input: {} }, ctx)).toMatchObject({ block: true });
		const prompt = await pi.emit("before_agent_start", { systemPrompt: "BASE RULES" }, ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("BASE RULES");
		expect(prompt.systemPrompt).toContain("[PLAN MODE ACTIVE]");

		const shortcut = pi.shortcuts.get(PLAN_MODE_SHORTCUT) as { handler: (ctx: ExtensionContext) => void };
		shortcut.handler(ctx);
		expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		expect([...harness.widgets.values()].some((widget) => widget.placement === "belowEditor")).toBe(false);
		await command.handler("bad", ctx);
		expect(notifications.at(-1)?.message).toBe("Usage: /plan on|off|revise|complete|abandon");
	});

	it("uses temporary revision storage, enters implementation, and explicitly reattaches for revision", async () => {
		await fakeRevdiff();
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries, choices: ["Approve Plan", REVISE_WORK_CHOICE] });
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		await turnPlanOn(pi, harness.ctx);
		expect(isPersistentSession(harness.ctx)).toBe(false);
		expect(pi.entries).toHaveLength(0);
		pi.onSendMessage = () => {
			expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", COMPLETE_PLAN_TOOL]);
			expect([...harness.widgets.values()].some((widget) => widget.placement === "belowEditor")).toBe(false);
		};

		const result = await submitPlan(pi, harness.ctx) as { details: { planId: string; planPath: string; approvedHash: string; revision: number } };
		expect(pi.emittedEvents).toEqual([
			{ event: "herdr:blocked", data: { active: true, label: "plan review" } },
			{ event: "herdr:blocked", data: { active: false } },
			{ event: "herdr:blocked", data: { active: true, label: "plan approval" } },
			{ event: "herdr:blocked", data: { active: false } },
		]);
		const planRoot = path.dirname(path.dirname(path.dirname(result.details.planPath)));
		expect(planRoot).toMatch(new RegExp(`${path.sep.replace("\\", "\\\\")}pi-plan-`));
		expect(result.details.revision).toBe(1);
		expect(result.details.planPath).toMatch(/revisions[/\\]r1\.md$/);
		expect(await readFile(result.details.planPath, "utf8")).toContain("Implement it");
		expect(pi.entries).toHaveLength(0);
		expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", COMPLETE_PLAN_TOOL]);
		expect(harness.terminal).toMatchObject({ stops: 1, starts: 1 });
		expect(pi.sentUserMessages).toHaveLength(0);
		expect(pi.sentMessages).toHaveLength(1);
		const sent = pi.sentMessages[0];
		expect(sent.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(sent.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", COMPLETE_PLAN_TOOL]);
		expect(sent.message).toMatchObject({
			customType: APPROVED_PLAN_MESSAGE_TYPE,
			display: true,
			details: {
				title: "Implement simple Plan Mode",
				revision: 1,
				stepCount: 2,
				planId: result.details.planId,
				approvedHash: result.details.approvedHash,
				planPath: result.details.planPath,
			},
		});
		expect(sent.message.content).toContain(result.details.approvedHash);
		expect(sent.message.content).toContain("Revision: r1");
		expect(sent.message.content).toContain("# Goal\n\nImplement it.");
		const renderer = pi.messageRenderers.get(APPROVED_PLAN_MESSAGE_TYPE);
		expect(renderer).toBeDefined();
		const renderedMessage = renderer(
			{ details: sent.message.details },
			{ expanded: true },
			(harness.ctx.ui as any).theme,
		).render(100);
		expect(renderedMessage).toHaveLength(1);
		expect(plain(renderedMessage[0])).toBe("✓ PLAN APPROVED · Implement simple Plan Mode · r1 · 2 steps");
		const fallbackMessage = renderer(
			{ details: "corrupted" },
			{ expanded: false },
			(harness.ctx.ui as any).theme,
		).render(100);
		expect(plain(fallbackMessage[0])).toBe("✓ PLAN APPROVED");
		const aboveEntry = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor");
		expect(aboveEntry).toBeDefined();
		expect(plain(harness.renderWidget(aboveEntry![0])?.join("\n"))).toContain("IMPLEMENTING · r1");
		expect(plain(harness.renderWidget(aboveEntry![0])?.join("\n"))).toContain("2 steps");
		expect([...harness.widgets.values()].some((widget) => widget.placement === "belowEditor")).toBe(false);
		const stepsShortcut = pi.shortcuts.get(PLAN_STEPS_SHORTCUT) as { handler: (ctx: ExtensionContext) => void };
		stepsShortcut.handler(harness.ctx);
		expect(plain(harness.renderWidget(aboveEntry![0])?.join("\n"))).toContain("1. Change code");
		expect(plain(harness.renderWidget(aboveEntry![0])?.join("\n"))).toContain("Ctrl+Alt+O collapse");

		await turnPlanOn(pi, harness.ctx);
		expect(pi.emittedEvents.slice(-2)).toEqual([
			{ event: "herdr:blocked", data: { active: true, label: "plan lifecycle decision" } },
			{ event: "herdr:blocked", data: { active: false } },
		]);
		const replanningPrompt = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, harness.ctx) as { systemPrompt: string };
		expect(replanningPrompt.systemPrompt).toContain("[CURRENT PLAN REFERENCE]");
		expect(replanningPrompt.systemPrompt).toContain(`Plan ID: ${result.details.planId}`);
		expect(replanningPrompt.systemPrompt).toContain("Revision: r1");
		expect(replanningPrompt.systemPrompt).toContain(`Plan path: ${result.details.planPath}`);

		await pi.emit("session_shutdown", { reason: "quit" }, harness.ctx);
		await expect(stat(planRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("creates immutable revisions after requested changes", async () => {
		await fakeRevdiff();
		vi.stubEnv("PLAN_MODE_TEST_ANNOTATIONS", "Step 1: add a rollback check");
		vi.stubEnv("PLAN_MODE_TEST_EXIT", "10");
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries, choices: ["Approve Plan"] });
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		await turnPlanOn(pi, harness.ctx);

		const first = await submitPlan(pi, harness.ctx) as { details: { planId: string; planPath: string; revision: number } };
		expect(first.details.revision).toBe(1);
		expect(await readFile(first.details.planPath, "utf8")).toContain("Change code");
		const stepsShortcut = pi.shortcuts.get(PLAN_STEPS_SHORTCUT) as { handler: (ctx: ExtensionContext) => void };
		stepsShortcut.handler(harness.ctx);
		const aboveKey = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor")?.[0];
		expect(aboveKey).toBeDefined();
		expect(plain(harness.renderWidget(aboveKey!)?.join("\n"))).toContain("1. Change code");

		vi.stubEnv("PLAN_MODE_TEST_ANNOTATIONS", "");
		vi.stubEnv("PLAN_MODE_TEST_EXIT", "0");
		const second = await submitPlan(pi, harness.ctx, first.details.planId) as { details: { planPath: string; revision: number } };
		expect(second.details.revision).toBe(2);
		expect(second.details.planPath).toMatch(/r2\.md$/);
		expect(await readFile(first.details.planPath, "utf8")).toContain("Change code");
		expect(plain(harness.renderWidget(aboveKey!)?.join("\n"))).toContain("Ctrl+Alt+O expand");
		expect(plain(harness.renderWidget(aboveKey!)?.join("\n"))).not.toContain("1. Change code");
		expect(pi.activeTools).toContain("edit");
	});

	it("reports manual lifecycle confirmations as balanced Herdr blocked events", async () => {
		await fakeRevdiff();
		const pi = new FakePi();
		planModeExtension(pi.api());
		const harness = fakeContext({ entries: pi.entries, choices: ["Approve Plan", "confirm"] });
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		await turnPlanOn(pi, harness.ctx);
		await submitPlan(pi, harness.ctx);
		const command = pi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		await command.handler("abandon", harness.ctx);
		expect(pi.emittedEvents.slice(-2)).toEqual([
			{ event: "herdr:blocked", data: { active: true, label: "plan abandonment confirmation" } },
			{ event: "herdr:blocked", data: { active: false } },
		]);
		expect(pi.activeTools).not.toContain(COMPLETE_PLAN_TOOL);
		const aboveKey = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor")?.[0];
		expect(plain(harness.renderWidget(aboveKey!)?.join("\n"))).toContain("ABANDONED · r1");
	});

	it("completes exact approved work and starts the next Plan unattached by default", async () => {
		await fakeRevdiff();
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-plan-complete-test-"));
		cleanup.add(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const sessionFile = path.join(agentDir, "sessions", "session.jsonl");
		const entries: CustomEntry[] = [];
		const pi = new FakePi(entries);
		planModeExtension(pi.api());
		const harness = fakeContext({
			sessionFile,
			sessionId: "complete-session",
			entries,
			choices: ["Approve Plan"],
		});
		await pi.emit("session_start", { reason: "startup" }, harness.ctx);
		await turnPlanOn(pi, harness.ctx);
		const approved = await submitPlan(pi, harness.ctx) as {
			details: { planId: string; revision: number; approvedHash: string; planPath: string };
		};
		const implementingBranch = [...entries];
		const completeTool = pi.tools.get(COMPLETE_PLAN_TOOL);
		expect(completeTool).toBeDefined();
		await expect(completeTool.execute(
			"complete-wrong",
			{
				planId: approved.details.planId,
				revision: 2,
				summary: "Wrong revision",
				verification: ["pnpm test"],
			},
			undefined,
			undefined,
			harness.ctx,
		)).rejects.toThrow(`must target ${approved.details.planId} r1`);
		expect(pi.activeTools).toContain(COMPLETE_PLAN_TOOL);
		const completed = await completeTool.execute(
			"complete-1",
			{
				planId: approved.details.planId,
				revision: approved.details.revision,
				summary: "Implemented the approved scope",
				verification: ["pnpm test", "pnpm typecheck"],
			},
			undefined,
			undefined,
			harness.ctx,
		);
		expect(completed).toMatchObject({
			terminate: true,
			details: {
				kind: "completed",
				planId: approved.details.planId,
				revision: 1,
				summary: "Implemented the approved scope",
			},
		});
		expect(pi.activeTools).not.toContain(COMPLETE_PLAN_TOOL);
		const lifecycleEntry = entries.find((entry) => entry.customType === PLAN_LIFECYCLE_ENTRY_TYPE && (entry.data as any).kind === "completed");
		expect(lifecycleEntry).toBeDefined();
		const lifecycleRenderer = pi.entryRenderers.get(PLAN_LIFECYCLE_ENTRY_TYPE);
		expect(lifecycleRenderer).toBeDefined();
		expect(plain(lifecycleRenderer(lifecycleEntry, { expanded: false }, (harness.ctx.ui as any).theme).render(100).join("\n")))
			.toBe("✓ PLAN COMPLETED · Implement simple Plan Mode · r1");
		const aboveKey = [...harness.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor")?.[0];
		expect(aboveKey).toBeDefined();
		expect(plain(harness.renderWidget(aboveKey!)?.join("\n"))).toContain("COMPLETED · r1");

		const completedBranch = [...entries];
		const older = fakeContext({ sessionFile, sessionId: "complete-session", entries: implementingBranch });
		await pi.emit("session_tree", { newLeafId: "older" }, older.ctx);
		expect(pi.activeTools).toContain(COMPLETE_PLAN_TOOL);
		const olderWidget = [...older.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor")?.[0];
		expect(plain(older.renderWidget(olderWidget!)?.join("\n"))).toContain("IMPLEMENTING · r1");
		const latest = fakeContext({ sessionFile, sessionId: "complete-session", entries: completedBranch });
		await pi.emit("session_tree", { newLeafId: "latest" }, latest.ctx);
		expect(pi.activeTools).not.toContain(COMPLETE_PLAN_TOOL);
		const latestWidget = [...latest.widgets.entries()].find(([, widget]) => widget.placement === "aboveEditor")?.[0];
		expect(plain(latest.renderWidget(latestWidget!)?.join("\n"))).toContain("COMPLETED · r1");

		await turnPlanOn(pi, harness.ctx);
		expect(pi.activeTools).toEqual(["read", "grep", "find", "ls", SUBMIT_PLAN_TOOL]);
		expect([...harness.widgets.values()].some((widget) => widget.placement === "aboveEditor")).toBe(false);
		const prompt = await pi.emit("before_agent_start", { systemPrompt: "BASE" }, harness.ctx) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("[NEW PLAN]");
		expect(prompt.systemPrompt).not.toContain("[CURRENT PLAN REFERENCE]");
		expect(prompt.systemPrompt).not.toContain(approved.details.planId);
	});

	it("migrates legacy approved pointers to unknown work instead of assuming completion", async () => {
		await fakeRevdiff();
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-plan-legacy-test-"));
		cleanup.add(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const sessionFile = path.join(agentDir, "sessions", "session.jsonl");
		const entries: CustomEntry[] = [];
		const firstPi = new FakePi(entries);
		planModeExtension(firstPi.api());
		const first = fakeContext({ sessionFile, sessionId: "legacy-session", entries, choices: ["Approve Plan"] });
		await firstPi.emit("session_start", { reason: "startup" }, first.ctx);
		await turnPlanOn(firstPi, first.ctx);
		const approved = await submitPlan(firstPi, first.ctx) as { details: { planId: string } };
		entries.push({
			type: "custom",
			customType: "zhcsyncer-plan-mode-state",
			data: {
				version: 2,
				mode: "normal",
				planId: approved.details.planId,
				revision: 1,
				normalTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			},
		});

		const resumedPi = new FakePi(entries);
		planModeExtension(resumedPi.api());
		const resumed = fakeContext({ sessionFile, sessionId: "legacy-session", entries });
		await resumedPi.emit("session_start", { reason: "resume" }, resumed.ctx);
		expect(resumedPi.activeTools).toContain(COMPLETE_PLAN_TOOL);
		const command = resumedPi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		await command.handler("", resumed.ctx);
		expect(resumed.notifications.at(-1)?.message).toContain("Plan work: UNKNOWN");
	});

	it("restores normal mode and the current Plan pointer from persistent Session state", async () => {
		await fakeRevdiff();
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-plan-agent-test-"));
		cleanup.add(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const sessionFile = path.join(agentDir, "sessions", "session.jsonl");
		const entries: CustomEntry[] = [];

		const firstPi = new FakePi(entries);
		planModeExtension(firstPi.api());
		const first = fakeContext({ sessionFile, sessionId: "persistent-session", entries, choices: ["Approve Plan"] });
		await firstPi.emit("session_start", { reason: "startup" }, first.ctx);
		await turnPlanOn(firstPi, first.ctx);
		const approved = await submitPlan(firstPi, first.ctx) as { details: { planPath: string } };
		expect(entries.some((entry) => (entry.data as any).mode === "normal" && (entry.data as any).work?.revision === 1)).toBe(true);

		const resumedPi = new FakePi(entries);
		planModeExtension(resumedPi.api());
		const resumed = fakeContext({ sessionFile, sessionId: "persistent-session", entries });
		await resumedPi.emit("session_start", { reason: "resume" }, resumed.ctx);
		expect(resumedPi.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", COMPLETE_PLAN_TOOL]);
		const command = resumedPi.commands.get("plan") as { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		await command.handler("", resumed.ctx);
		expect(resumed.notifications.at(-1)?.message).toContain("IMPLEMENTING · Implement simple Plan Mode · r1");
		expect(resumed.notifications.at(-1)?.message).toContain(approved.details.planPath);
	});
});
