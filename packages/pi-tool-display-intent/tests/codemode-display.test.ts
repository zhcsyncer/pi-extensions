import assert from "node:assert/strict";
import test from "node:test";
import { type Component } from "@earendil-works/pi-tui";
import {
	formatNestedCallsDetail,
	formatNestedCallsSummary,
	renderCodemodeCall,
	renderCodemodeResult,
	stripOptionsLine,
} from "../src/codemode-display.ts";
import {
	buildDeterministicDisplaySummary,
	extractCodemodeCommentIntent,
	extractCodemodeToolCalls,
	formatCodemodeTarget,
	resolveDisplaySummaryForTool,
} from "../src/display-summary-fallback.ts";
import { AggregateProjection, formatAggregateTarget } from "../src/aggregate-activity.ts";
import { lookupAggregateCallPresentation } from "../src/call-presentation-registry.ts";
import { buildDetailModel } from "../src/detail-viewer-model.ts";
import { getClaudeToolLabel } from "../src/tool-call-style.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

function createPlainTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function renderedText(component: Component, width = 120): string {
	return component.render(width).map((line) => line.trimEnd()).join("\n").trim();
}

test("stripOptionsLine removes // @options header", () => {
	const code = `// @options: {"max_output_tokens": 1000}\nconst x = 1;\nconsole.log(x);`;
	assert.equal(stripOptionsLine(code), "const x = 1;\nconsole.log(x);");
	assert.equal(stripOptionsLine("const y = 2;"), "const y = 2;");
});

test("extractCodemodeCommentIntent extracts comments ignoring @options", () => {
	const withOptions = `// @options: {"max_output_tokens": 1000}\n// Count all TypeScript files\nconst files = await tools.find();`;
	assert.equal(extractCodemodeCommentIntent(withOptions), "Count all TypeScript files");

	const blockComment = `/* Inspect git status and diff */\nconst diff = await tools.bash();`;
	assert.equal(extractCodemodeCommentIntent(blockComment), "Inspect git status and diff");

	const noComment = `const x = 1;`;
	assert.equal(extractCodemodeCommentIntent(noComment), undefined);
});

test("extractCodemodeToolCalls identifies invoked tools", () => {
	const code = `
		const a = await tools.read({ path: "foo" });
		const b = await tools.bash({ command: "ls" });
		const c = await tools.mcp__server__query();
	`;
	const calls = extractCodemodeToolCalls(code);
	assert.deepEqual(calls, ["read", "bash", "mcp__server__query"]);
});

test("formatCodemodeTarget chooses displaySummary, comment, tool calls, or code", () => {
	assert.equal(
		formatCodemodeTarget({ displaySummary: "Count files" }),
		"Count files",
	);
	assert.equal(
		formatCodemodeTarget({ code: "// Search error logs\nconst x = 1;" }),
		"Search error logs",
	);
	assert.equal(
		formatCodemodeTarget({ code: "await tools.read(); await tools.bash();" }),
		"read · bash",
	);
	assert.equal(
		formatCodemodeTarget({ code: "const res = 1 + 2;" }),
		"const res = 1 + 2;",
	);
	assert.equal(
		formatCodemodeTarget({ code: "// @ts-check\nconst count = 42;" }),
		"const count = 42;",
	);
});

test("deterministic summary fallback supports codemode", () => {
	assert.equal(buildDeterministicDisplaySummary("codemode", "en", 60), "Run script");
	assert.equal(buildDeterministicDisplaySummary("codemode", "zh-CN", 60), "运行脚本");

	const resolved = resolveDisplaySummaryForTool(
		{ code: "// Inspect database schema\nconst x = 1;" },
		"codemode",
		{ language: "en", maxLength: 60 },
	);
	assert.equal(resolved?.text, "Inspect database schema");
	assert.equal(resolved?.source, "model");
});

test("renderCodemodeCall renders code snippet and line count", () => {
	const theme = createPlainTheme();
	const context = { executionStarted: false, isPartial: false, invalidate: () => {} };
	const code = `// @options: {"max_output_tokens": 1000}\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);`;

	const comp = renderCodemodeCall({ code }, theme, context);
	const text = renderedText(comp);
	assert.match(text, /codemode const a = 1;/);
	assert.match(text, /3 lines · Ctrl\+O/);
});

test("renderCodemodeCall displays intent when provided", () => {
	const theme = createPlainTheme();
	const context = { executionStarted: false, isPartial: false, invalidate: () => {} };
	const comp = renderCodemodeCall(
		{ code: "const a = 1;", displaySummary: "Run tests and check output" },
		theme,
		context,
		{ language: "en", maxLength: 60 },
	);
	const text = renderedText(comp);
	assert.match(text, / — Run tests and check output/);
});

test("renderCodemodeCall does not duplicate comment intent in compact header", () => {
	const theme = createPlainTheme();
	const context = { executionStarted: false, isPartial: false, invalidate: () => {} };
	const code = "// Count all files\nconst files = await tools.find();";
	const comp = renderCodemodeCall(
		{ code },
		theme,
		context,
		{ language: "en", maxLength: 60 },
	);
	const text = renderedText(comp);
	// Should show code line and comment intent without repeating '// Count all files' twice
	assert.match(text, /codemode const files = await tools\.find\(\);/);
	assert.match(text, /Count all files/);
	assert.doesNotMatch(text, /\/\/ Count all files.*Count all files/);
});

test("getClaudeToolLabel maps codemode to capitalized Codemode", () => {
	assert.equal(getClaudeToolLabel("codemode"), "Codemode");
});

test("renderCodemodeResult displays nested call summary and output", () => {
	const theme = createPlainTheme();
	const result = {
		content: [{ type: "text", text: "Script completed\nWall time 0.2s\nOutput:\nFiles: 42" }],
		nestedCalls: {
			complete: true,
			calls: [
				{ name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 10 },
				{ name: "bash", arguments: { command: "ls" }, status: "ok", durationMs: 25 },
			],
		},
	};

	const collapsed = renderCodemodeResult(result, { expanded: false }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	const collapsedText = renderedText(collapsed);
	assert.match(collapsedText, /Nested \(2 nested calls\):/);
	assert.match(collapsedText, /✓ read ×1/);
	assert.match(collapsedText, /✓ bash ×1/);

	const expanded = renderCodemodeResult(result, { expanded: true }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	const expandedText = renderedText(expanded);
	assert.match(expandedText, /✓ read a.ts 10ms/);
	assert.match(expandedText, /✓ bash ls 25ms/);
	assert.match(expandedText, /Files: 42/);
});

test("aggregate projection tracks nested calls under parent without inflating call count", () => {
	const projection = new AggregateProjection(() => false, () => "flat", () => false);
	projection.rebuild([]);

	projection.ingestAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_code", name: "codemode", arguments: { code: "// Count files\nawait tools.read();" } },
		],
	});

	projection.markStarted("call_code", "codemode", { code: "// Count files\nawait tools.read();" });

	// Live nested call start
	projection.markNestedStarted("call_code", "call_code/0", "read", { path: "package.json" });

	const liveView = projection.getView("call_code");
	assert.equal(liveView?.callCount, 1, "Call count should remain 1");
	assert.match(liveView?.displayRows[0]?.toolName ?? "", /codemode/);
	assert.equal(projection.getMember("call_code")?.activeNestedCall?.toolName, "read");

	// Live nested call complete
	projection.markNestedComplete("call_code", "call_code/0", { content: [{ type: "text", text: "ok" }] }, false);
	assert.equal(projection.getMember("call_code")?.activeNestedCall, undefined);

	// Parent codemode completes
	projection.markComplete("call_code", {
		content: [{ type: "text", text: "Script completed" }],
		nestedCalls: {
			complete: true,
			calls: [{ name: "read", arguments: { path: "package.json" }, status: "ok", durationMs: 12 }],
		},
	}, false);
	projection.markGroupSettled();

	const finalView = projection.getView("call_code");
	assert.equal(finalView?.callCount, 1);
	assert.equal(finalView?.settled, true);
	assert.equal(projection.getMember("call_code")?.nestedCalls?.calls?.length, 1);
});

test("detail viewer highlights code as typescript and formats nestedCalls", () => {
	const model = buildDetailModel({
		kind: "tool",
		toolName: "codemode",
		target: "Codemode(Count files)",
		args: { code: "const x = 1;" },
		result: {
			content: [{ type: "text", text: "Script completed\nOutput:\nResult: 42" }],
			nestedCalls: {
				complete: true,
				calls: [
					{ name: "read", arguments: { path: "foo.ts" }, status: "ok", durationMs: 15 },
					{ name: "bash", arguments: { command: "test" }, status: "error", error: "Command failed" },
				],
			},
		},
	});

	const argsTab = model.tabs.find((t) => t.id === "args");
	assert.ok(argsTab?.fields);
	const codeField = argsTab.fields.find((f) => f.key === "code");
	assert.equal(codeField?.language, "typescript");

	const resultTab = model.tabs.find((t) => t.id === "result");
	assert.ok(resultTab);
	assert.match(resultTab.text, /Nested calls: 2/);
	assert.match(resultTab.text, /✓ read {"path":"foo.ts"} 15ms/);
	assert.match(resultTab.text, /✗ bash {"command":"test"}/);
	assert.match(resultTab.text, /Command failed/);
});

test("renderCodemodeCall does not spin on completed calls", () => {
	const theme = createPlainTheme();
	const completedContext = { executionStarted: true, isPartial: false, invalidate: () => {} };
	const comp = renderCodemodeCall({ code: "const x = 1;" }, theme, completedContext);
	const text = renderedText(comp);
	assert.doesNotMatch(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	assert.match(text, /codemode const x = 1;/);

	const runningContext = { toolCallId: "call_code_1", executionStarted: true, isPartial: true, invalidate: () => {} };
	const runningComp = renderCodemodeCall({ code: "const x = 1;" }, theme, runningContext);
	const runningText = renderedText(runningComp);
	assert.match(runningText, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] codemode const x = 1;/);

	// Transition to completed to stop the spinner interval
	renderCodemodeCall({ code: "const x = 1;" }, theme, {
		toolCallId: "call_code_1",
		executionStarted: true,
		isPartial: false,
	});
});

test("renderCodemodeResult wraps long lines to provided render width", () => {
	const theme = createPlainTheme();
	const longLine = "a".repeat(120);
	const result = {
		content: [{ type: "text", text: longLine }],
	};

	const comp = renderCodemodeResult(
		result,
		{ expanded: false },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, resultMode: "preview", previewRows: 4 },
		theme,
	);
	// Rendering with width 40 should wrap the 120-char line across multiple 40-column rows
	const lines = comp.render(40);
	assert.ok(lines.length > 1, `Expected multiple wrapped rows, got ${lines.length}`);
	assert.ok(lines.every((line) => line.length <= 40));
});

test("detail viewer keeps codemode result presentation as text even with markdown syntax", () => {
	const model = buildDetailModel({
		kind: "tool",
		toolName: "codemode",
		target: "Codemode(Run script)",
		args: { code: "const x = 1;" },
		result: {
			content: [{ type: "text", text: "# Summary\n* item 1\n* item 2\n> quote" }],
		},
	});

	const resultTab = model.tabs.find((t) => t.id === "result");
	assert.ok(resultTab);
	assert.equal(resultTab.presentation, "text", "codemode output should remain literal text");
});

test("tool overrides decorates codemode candidate from getAllTools without execute without throwing", async () => {
	const codemodeTool = {
		name: "codemode",
		description: "Run JavaScript code in sandbox",
		parameters: {
			type: "object",
			properties: { code: { type: "string" } },
			required: ["code"],
		},
	};

	const handlers: Record<string, () => Promise<void> | void> = {};
	const api = {
		registerTool: () => {},
		registerCommand: () => {},
		getAllTools: () => [codemodeTool],
		getActiveTools: () => ["codemode"],
		setActiveTools: () => {},
		on: (event: string, handler: () => Promise<void> | void) => {
			handlers[event] = handler;
		},
	} as any;

	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "individual",
	}));

	assert.equal(typeof handlers["session_start"], "function");
	await handlers["session_start"]!();

	assert.equal(typeof (codemodeTool as any).renderCall, "function");
	assert.equal(typeof (codemodeTool as any).renderResult, "function");
	assert.ok((codemodeTool.parameters as any).properties.displaySummary);

	// Wait for discovery retry timers to settle
	await new Promise((resolve) => setTimeout(resolve, 320));
});

test("tool overrides wraps codemode with execute and strips displaySummary before execution", () => {
	let executedArgs: Record<string, unknown> | undefined;
	const codemodeTool = {
		name: "codemode",
		description: "Run JavaScript code in sandbox",
		parameters: {
			type: "object",
			properties: { code: { type: "string" } },
			required: ["code"],
		},
		execute: async (_id: string, args: Record<string, unknown>) => {
			executedArgs = args;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};

	let registeredTool: any;
	const api = {
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		registerCommand: () => {},
		getAllTools: () => [],
		getActiveTools: () => ["codemode"],
		setActiveTools: () => {},
		on: () => {},
	} as any;

	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "individual",
	}));

	// When tool is registered via intercepted registerTool
	api.registerTool(codemodeTool);

	assert.ok(registeredTool);
	assert.equal(typeof registeredTool.execute, "function");
	registeredTool.execute("call_1", { code: "const a = 1;", displaySummary: "Run a script" });
	assert.deepEqual(executedArgs, { code: "const a = 1;" }, "displaySummary should be stripped before execute");
});

test("tool overrides in aggregate layout registers codemode adapter", () => {
	const api = {
		registerTool: () => {},
		registerCommand: () => {},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		on: () => {},
	} as any;

	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "aggregate",
	}));

	const presentation = lookupAggregateCallPresentation("codemode", {
		code: "// Search logs\nconst x = 1;",
	});
	assert.equal(presentation?.target, "Search logs");
});

test("aggregate projection tracks parallel nested calls and reverts to remaining active call", () => {
	const projection = new AggregateProjection(() => false, () => "flat", () => false);
	projection.rebuild([]);

	projection.ingestAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_code_parallel", name: "codemode", arguments: { code: "await Promise.all([tools.read(), tools.bash()]);" } },
		],
	});

	projection.markStarted("call_code_parallel", "codemode", { code: "await Promise.all([tools.read(), tools.bash()]);" });

	// Start two nested calls concurrently
	projection.markNestedStarted("call_code_parallel", "call_code/1", "read", { path: "a.ts" });
	assert.equal(projection.getMember("call_code_parallel")?.activeNestedCall?.toolName, "read");

	projection.markNestedStarted("call_code_parallel", "call_code/2", "bash", { command: "ls" });
	assert.equal(projection.getMember("call_code_parallel")?.activeNestedCall?.toolName, "bash");

	// Finish the second call first: activeNestedCall should revert to remaining unfinished call (read)
	projection.markNestedComplete("call_code_parallel", "call_code/2", { content: [{ type: "text", text: "ok" }] }, false);
	assert.equal(projection.getMember("call_code_parallel")?.activeNestedCall?.toolName, "read");
	assert.equal(projection.getMember("call_code_parallel")?.activeNestedCall?.toolCallId, "call_code/1");

	// Finish the remaining call: activeNestedCall should be cleared
	projection.markNestedComplete("call_code_parallel", "call_code/1", { content: [{ type: "text", text: "ok" }] }, false);
	assert.equal(projection.getMember("call_code_parallel")?.activeNestedCall, undefined);
});

test("renderCodemodeResult expanded mode shows no output hint when empty", () => {
	const theme = createPlainTheme();
	const result = {
		content: [],
	};

	const expanded = renderCodemodeResult(result, { expanded: true }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	const text = renderedText(expanded);
	assert.match(text, /Script completed \(no output\)/);
});

test("renderCodemodeResult and detail viewer resolve nestedCalls from details fallback", () => {
	const theme = createPlainTheme();
	const result = {
		content: [{ type: "text", text: "Done" }],
		details: {
			nestedCalls: {
				complete: true,
				calls: [{ name: "read", arguments: { path: "x.ts" }, status: "ok" }],
			},
		},
	};

	const collapsed = renderCodemodeResult(result, { expanded: false }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	assert.match(renderedText(collapsed), /✓ read ×1/);

	const model = buildDetailModel({
		kind: "tool",
		toolName: "codemode",
		target: "Codemode(Run)",
		args: { code: "await tools.read();" },
		result,
	});
	const resultTab = model.tabs.find((t) => t.id === "result");
	assert.ok(resultTab);
	assert.match(resultTab.text, /Nested calls: 1/);
	assert.match(resultTab.text, /✓ read {"path":"x.ts"}/);
});

test("detail viewer formats nested calls without arguments without double spacing", () => {
	const model = buildDetailModel({
		kind: "tool",
		toolName: "codemode",
		target: "Codemode(Run)",
		args: { code: "await tools.exit();" },
		result: {
			content: [{ type: "text", text: "Done" }],
			nestedCalls: {
				complete: true,
				calls: [
					{ name: "exit", status: "ok", durationMs: 5 },
					{ name: "read", status: "ok" },
				],
			},
		},
	});

	const resultTab = model.tabs.find((t) => t.id === "result");
	assert.ok(resultTab);
	assert.match(resultTab.text, /✓ exit 5ms/);
	assert.doesNotMatch(resultTab.text, /✓ exit  5ms/);
	assert.match(resultTab.text, /✓ read(\n|$)/);
});

test("markNestedStarted ignores invalid or empty toolName without crashing", () => {
	const projection = new AggregateProjection(() => false, () => "flat", () => false);
	projection.rebuild([]);
	projection.markStarted("call_code", "codemode", { code: "const x = 1;" });

	// Call markNestedStarted with empty string toolName
	projection.markNestedStarted("call_code", "call_code/1", "", {});
	assert.equal(projection.getMember("call_code")?.activeNestedCall, undefined);

	// Call markNestedStarted with whitespace-only toolName
	projection.markNestedStarted("call_code", "call_code/2", "   ", {});
	assert.equal(projection.getMember("call_code")?.activeNestedCall, undefined);
});

test("formatNestedCallsSummary separates ok and error counts for the same tool", () => {
	const theme = createPlainTheme();
	const nested = {
		complete: true,
		calls: [
			{ name: "read", status: "ok" as const },
			{ name: "read", status: "ok" as const },
			{ name: "read", status: "error" as const },
		],
	};
	const summary = formatNestedCallsSummary(nested, theme);
	assert.match(summary, /✓ read ×2/);
	assert.match(summary, /✗ read ×1/);
	assert.doesNotMatch(summary, /✗ read ×3/);
});

test("formatNestedCallsDetail and summary render unfinished status as ellipsis", () => {
	const theme = createPlainTheme();
	const nested = {
		complete: false,
		calls: [
			{ name: "bash", status: "unfinished" as const, durationMs: 100 },
		],
	};
	const summary = formatNestedCallsSummary(nested, theme);
	assert.match(summary, /… bash ×1/);

	const details = formatNestedCallsDetail(nested, theme);
	assert.match(details[0] ?? "", /… bash/);
	assert.doesNotMatch(details[0] ?? "", /✓/);
});

test("extractCodemodeCommentIntent handles directives and empty comment lines", () => {
	const code = `
// @options: {"max_output_tokens": 1000}
//
// @ts-check
// Search audit logs
const x = 1;
`;
	assert.equal(extractCodemodeCommentIntent(code), "Search audit logs");
});

test("formatAggregateTarget avoids duplicating static tool list when runtime nestedCalls exist", () => {
	const member = {
		toolName: "codemode",
		args: { code: "await tools.read(); await tools.bash();" },
		nestedCalls: {
			complete: true,
			calls: [
				{ name: "read", status: "ok" as const },
				{ name: "bash", status: "ok" as const },
			],
		},
	};
	const formatted = formatAggregateTarget(member);
	assert.equal(formatted, "Codemode(read ×1 · bash ×1)");
});

test("tool overrides restores original execute upon reload/cleanup", () => {
	resetDisposed();
	const originalExecute = async () => ({ content: [{ type: "text", text: "original" }] });
	const codemodeTool = {
		name: "codemode",
		description: "Run code",
		parameters: { type: "object", properties: { code: { type: "string" } } },
		execute: originalExecute,
	};
	const api = {
		registerTool: () => {},
		registerCommand: () => {},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		on: () => {},
	} as any;
	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "individual",
	}));
	api.registerTool(codemodeTool);
	assert.notEqual(codemodeTool.execute, originalExecute, "execute should be wrapped");

	disposeAll();
	resetDisposed();
	assert.equal(codemodeTool.execute, originalExecute, "execute should be restored after cleanup");
});

test("aggregate projection retains nestedCalls even when parent fails", () => {
	const projection = new AggregateProjection(() => false, () => "flat", () => false);
	projection.rebuild([]);
	projection.markStarted("call_code_fail", "codemode", { code: "await tools.read();" });
	projection.markNestedStarted("call_code_fail", "call_code_fail/0", "read", { path: "a.ts" });
	projection.markNestedComplete("call_code_fail", "call_code_fail/0", { content: [{ type: "text", text: "ok" }] }, false);

	projection.markComplete("call_code_fail", {
		content: [{ type: "text", text: "Sandbox error" }],
		nestedCalls: {
			complete: true,
			calls: [{ name: "read", status: "ok", durationMs: 10 }],
		},
	}, true);

	const member = projection.getMember("call_code_fail");
	assert.equal(member?.state, "failed");
	assert.equal(member?.nestedCalls?.calls?.length, 1);
	assert.equal(member?.nestedCalls?.calls?.[0]?.name, "read");
});

test("renderCodemodeResult displays nested summary when script failed", () => {
	const theme = createPlainTheme();
	const failedResult = {
		isError: true,
		content: [{ type: "text", text: "Error: script execution failed" }],
		nestedCalls: {
			complete: true,
			calls: [
				{ name: "read", status: "ok" as const, durationMs: 5 },
				{ name: "bash", status: "error" as const, durationMs: 20, error: "exit code 1" },
			],
		},
	};
	const collapsed = renderCodemodeResult(failedResult, { expanded: false }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	const text = renderedText(collapsed);
	assert.match(text, /✓ read ×1/);
	assert.match(text, /✗ bash ×1/);
	assert.match(text, /Script failed/);

	const expanded = renderCodemodeResult(failedResult, { expanded: true }, DEFAULT_TOOL_DISPLAY_CONFIG, theme);
	const expandedText = renderedText(expanded);
	assert.match(expandedText, /✓ read/);
	assert.match(expandedText, /✗ bash/);
	assert.match(expandedText, /exit code 1/);
});

test("formatNestedCallsSummary and detail safely ignore malformed entries", () => {
	const theme = createPlainTheme();
	const malformed = {
		complete: false,
		calls: [
			null as any,
			undefined as any,
			{ name: "", status: "ok" as const },
			{ name: "read", status: "ok" as const, arguments: null as any },
		],
	};
	const summary = formatNestedCallsSummary(malformed, theme);
	assert.match(summary, /read ×1/);

	const detail = formatNestedCallsDetail(malformed, theme);
	assert.equal(detail.length, 2);
});

test("renderCodemodeCall with empty code has no extra space", () => {
	const theme = createPlainTheme();
	const context = { executionStarted: false, isPartial: false, invalidate: () => {} };
	const comp = renderCodemodeCall({ code: "" }, theme, context);
	const text = renderedText(comp);
	assert.equal(text, "codemode");
});

test("renderCodemodeResult respects context.isError when result.isError is not set", () => {
	const theme = createPlainTheme();
	const result = {
		content: [{ type: "text", text: "Runtime exception" }],
	};
	const comp = renderCodemodeResult(
		result,
		{ expanded: false },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		{ executionStarted: true, isPartial: false, isError: true },
	);
	const text = renderedText(comp);
	assert.match(text, /Script failed/);
	assert.match(text, /Runtime exception/);
});
