import assert from "node:assert/strict";
import test from "node:test";
import {
	addDisplaySummaryParameter,
	getDisplaySummary,
	normalizeDisplaySummary,
	stripDisplaySummary,
	withDisplaySummary,
} from "../src/display-summary.js";
import { stripDisplaySummariesFromContextMessages } from "../src/display-summary-context.js";

const SCHEMA_KIND = Symbol("schema-kind");

function createTool(overrides: Record<string, unknown> = {}) {
	return {
		name: "probe",
		label: "Probe",
		description: "Inspect a value.",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			[SCHEMA_KIND]: "Object",
		},
		execute(_id: string, args: unknown) {
			return args;
		},
		...overrides,
	};
}

test("adds a required displaySummary without mutating the original schema", () => {
	const tool = createTool();
	const originalParameters = tool.parameters;
	const next = addDisplaySummaryParameter(originalParameters, {
		language: "zh-CN",
		maxLength: 80,
	}) as typeof originalParameters & {
		properties: Record<string, Record<string, unknown>>;
		required: string[];
	};

	assert.notEqual(next, originalParameters);
	assert.notEqual(next.properties, originalParameters.properties);
	assert.equal(next[SCHEMA_KIND], "Object");
	assert.equal(next.properties.displaySummary?.type, "string");
	assert.equal(next.properties.displaySummary?.maxLength, 80);
	assert.match(String(next.properties.displaySummary?.description), /Simplified Chinese/);
	assert.deepEqual(next.required, ["value", "displaySummary"]);
	assert.equal("displaySummary" in originalParameters.properties, false);
});

test("refuses to hijack a custom tool's existing displaySummary parameter", () => {
	assert.throws(
		() => addDisplaySummaryParameter({
			type: "object",
			properties: { displaySummary: { type: "number" } },
		}),
		/schema already defines displaySummary/,
	);
});

test("withDisplaySummary preserves preparation order and strips presentation args before execution", async () => {
	let preparedInput: unknown;
	let executedInput: unknown;
	const tool = createTool({
		prepareArguments(args: unknown) {
			preparedInput = args;
			return { ...(args as Record<string, unknown>), prepared: true };
		},
		execute(_id: string, args: unknown) {
			executedInput = args;
			return args;
		},
	});
	const wrapped = withDisplaySummary(tool, { language: "auto" });
	const raw = {
		value: "alpha",
		displaySummary: "\u001b]8;;https://example.com\u0007Inspecting\n the value\u001b]8;;\u0007",
	};

	const prepared = wrapped.prepareArguments?.(raw) as Record<string, unknown>;
	assert.deepEqual(preparedInput, { value: "alpha" });
	assert.deepEqual(prepared, {
		value: "alpha",
		prepared: true,
		displaySummary: "Inspecting the value",
	});

	await wrapped.execute("call-1", prepared);
	assert.deepEqual(executedInput, { value: "alpha", prepared: true });
});

test("withDisplaySummary supplies a validation fallback for old or incomplete calls", () => {
	const wrapped = withDisplaySummary(createTool(), { language: "zh-CN" });
	assert.deepEqual(wrapped.prepareArguments?.({ value: "alpha" }), {
		value: "alpha",
		displaySummary: "正在运行 Probe",
	});
});

test("renderer args are stripped by default and can be preserved for intent-aware renderers", () => {
	let defaultRendererArgs: unknown;
	const defaultWrapped = withDisplaySummary(createTool({
		renderCall(args: unknown) {
			defaultRendererArgs = args;
			return args;
		},
	}));
	defaultWrapped.renderCall?.({ value: "alpha", displaySummary: "Inspecting alpha" });
	assert.deepEqual(defaultRendererArgs, { value: "alpha" });

	let preservedRendererArgs: unknown;
	const preservedWrapped = withDisplaySummary(createTool({
		renderCall(args: unknown) {
			preservedRendererArgs = args;
			return args;
		},
	}), { preserveRendererArgs: true });
	preservedWrapped.renderCall?.({ value: "alpha", displaySummary: "Inspecting alpha" });
	assert.deepEqual(preservedRendererArgs, { value: "alpha", displaySummary: "Inspecting alpha" });
});

test("summary helpers sanitize terminal controls, normalize whitespace, and are idempotent", () => {
	const args = { value: "alpha", displaySummary: "  Checking\u001b[31m   value\nnow  " };
	assert.equal(normalizeDisplaySummary(args.displaySummary), "Checking value now");
	assert.equal(getDisplaySummary(args), "Checking value now");
	assert.deepEqual(stripDisplaySummary(args), { value: "alpha" });
	assert.equal(stripDisplaySummary({ value: "alpha" }).value, "alpha");

	const wrapped = withDisplaySummary(createTool());
	assert.equal(withDisplaySummary(wrapped), wrapped);
});

test("context sanitization removes summaries only from outgoing assistant tool calls", () => {
	const messages = [
		{ role: "user", content: "Inspect alpha" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Need a tool" },
				{
					type: "toolCall",
					id: "call-1",
					name: "probe",
					arguments: { value: "alpha", displaySummary: "Inspecting alpha" },
				},
			],
		},
	];

	const sanitized = stripDisplaySummariesFromContextMessages(messages) as typeof messages;
	assert.notEqual(sanitized, messages);
	assert.deepEqual((sanitized[1]?.content as Array<Record<string, unknown>>)[1]?.arguments, { value: "alpha" });
	assert.deepEqual((messages[1]?.content as Array<Record<string, unknown>>)[1]?.arguments, {
		value: "alpha",
		displaySummary: "Inspecting alpha",
	});
});
