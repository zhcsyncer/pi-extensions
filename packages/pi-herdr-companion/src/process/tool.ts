import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { PROCESS_TOOL_NAME, type ProcessRegistrySnapshot } from "./registry.ts";
import type { ProcessManager } from "./manager.ts";

export const herdrProcessSchema = Type.Object({
	action: StringEnum(["start", "list", "logs", "stop"] as const, {
		description: "Process operation to perform.",
	}),
	command: Type.Optional(Type.String({ minLength: 1, description: "Shell command for start." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory for start; defaults to Pi's cwd." })),
	label: Type.Optional(Type.String({ minLength: 1, description: "Short owned process label for start." })),
	direction: Type.Optional(StringEnum(["down", "right"] as const, {
		description: "Split direction for start; defaults to down.",
	})),
	ratio: Type.Optional(Type.Number({ minimum: 0.1, maximum: 0.9, description: "New pane ratio; defaults to 0.35." })),
	readyMatch: Type.Optional(Type.String({ minLength: 1, description: "Literal output that marks the process ready." })),
	readyRegex: Type.Optional(Type.String({ minLength: 1, description: "Rust regex output that marks the process ready; mutually exclusive with readyMatch." })),
	readyTimeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 600_000, description: "Readiness timeout in milliseconds." })),
	lifetime: Type.Optional(StringEnum(["session", "persistent"] as const, {
		description: "session panes close on normal session teardown; persistent panes require explicit stop.",
	})),
	target: Type.Optional(Type.String({ minLength: 1, description: "Owned label or pane ID for logs/stop; defaults to the newest process." })),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000, description: "Recent unwrapped lines for logs; defaults to 200." })),
});

export type HerdrProcessInput = Static<typeof herdrProcessSchema>;

export interface HerdrProcessDetails {
	action: HerdrProcessInput["action"];
	registry: ProcessRegistrySnapshot;
	paneId?: string;
	label?: string;
	stalePaneIds?: string[];
	truncated?: boolean;
}

function result(text: string, details: HerdrProcessDetails) {
	const suffix = `\n\n[herdr_process output tail-truncated to ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}.]`;
	const bounded = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
	});
	return {
		content: [{ type: "text" as const, text: bounded.truncated ? `${bounded.content}${suffix}` : bounded.content }],
		details,
	};
}

export function registerHerdrProcessTool(pi: ExtensionAPI, manager: ProcessManager): void {
	pi.registerTool({
		name: PROCESS_TOOL_NAME,
		label: "Herdr Process",
		description: "Start, list, read logs from, or stop companion-owned long-running commands in visible Herdr panes. Output is tail-truncated to 2000 lines or 50KB. It never closes the caller or unowned panes.",
		promptSnippet: "Manage visible long-running dev, preview, and watch processes in Herdr panes",
		promptGuidelines: [
			"Use herdr_process for dev servers, previews, watchers, and other long-running commands instead of nohup, shell backgrounding, or disown.",
			"Use herdr_process stop only for panes returned by herdr_process; it cannot close caller or user-owned panes.",
		],
		parameters: herdrProcessSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (typeof params.command !== "string") throw new Error("herdr_process start requires command");
					const entry = await manager.start({
						command: params.command,
						...(params.cwd === undefined ? {} : { cwd: params.cwd }),
						...(params.label === undefined ? {} : { label: params.label }),
						...(params.direction === undefined ? {} : { direction: params.direction }),
						...(params.ratio === undefined ? {} : { ratio: params.ratio }),
						...(params.readyMatch === undefined ? {} : { readyMatch: params.readyMatch }),
						...(params.readyRegex === undefined ? {} : { readyRegex: params.readyRegex }),
						...(params.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: params.readyTimeoutMs }),
						...(params.lifetime === undefined ? {} : { lifetime: params.lifetime }),
					}, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, signal);
					return result(
						`Started ${entry.label} in ${entry.paneId} (${entry.lifetime}, cwd ${entry.cwd}).`,
						{ action: "start", registry: manager.registry.snapshot(), paneId: entry.paneId, label: entry.label },
					);
				}
				case "list": {
					const listed = await manager.list(signal);
					const text = listed.entries.length === 0
						? "No companion-owned process panes are live."
						: listed.entries.map((entry) =>
							`${entry.label}\t${entry.paneId}\t${entry.lifetime}\t${entry.cwd}\t${entry.command}`,
						).join("\n");
					return result(text, {
						action: "list",
						registry: manager.registry.snapshot(),
						...(listed.stale.length ? { stalePaneIds: listed.stale.map((entry) => entry.paneId) } : {}),
					});
				}
				case "logs": {
					const logs = await manager.logs(params.target, params.lines, signal);
					return result(
						`[${logs.entry.label} · ${logs.entry.paneId}]\n${logs.text}`,
						{
							action: "logs",
							registry: manager.registry.snapshot(),
							paneId: logs.entry.paneId,
							label: logs.entry.label,
							truncated: logs.truncated,
						},
					);
				}
				case "stop": {
					const entry = await manager.stop(params.target, signal);
					return result(`Stopped ${entry.label} and closed owned pane ${entry.paneId}.`, {
						action: "stop",
						registry: manager.registry.snapshot(),
						paneId: entry.paneId,
						label: entry.label,
					});
				}
			}
		},
	});
}
