import {
	DEFAULT_MAX_LINES,
	type ExecOptions,
	type ExecResult,
} from "@earendil-works/pi-coding-agent";
import type { SplitDirection } from "./config.ts";

export type HerdrExecutor = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export interface HerdrPane {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	cwd?: string;
	label?: string;
	focused?: boolean;
}

export interface HerdrAgent {
	paneId: string;
	name?: string;
	agent?: string;
	status?: string;
}

export interface HerdrPaneProcess {
	pid: number;
	name?: string;
	cmdline?: string;
	argv?: string[];
	cwd?: string;
}

export interface HerdrPaneProcessInfo {
	paneId: string;
	shellPid?: number;
	foregroundProcessGroupId?: number;
	foregroundProcesses: HerdrPaneProcess[];
}

export interface SplitPaneOptions {
	direction: SplitDirection;
	cwd: string;
	ratio?: number;
	focus: boolean;
	target?: "current" | string;
	environment?: Readonly<Record<string, string>>;
}

export interface WaitOutputOptions {
	match?: string;
	regex?: string;
	timeoutMs: number;
	lines?: number;
}

export interface StartAgentOptions {
	name: string;
	kind: "pi";
	paneId: string;
	args: string[];
	timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;
}

function parseErrorMetadata(stderr: string, stdout: string): { code?: string; missingPane: boolean } {
	const raw = stderr.trim() || stdout.trim();
	let code: string | undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed) && isRecord(parsed.error)) code = safeErrorCode(parsed.error.code);
	} catch {
		// Non-JSON diagnostics are used only for classification and are never exposed.
	}
	return {
		...(code ? { code } : {}),
		missingPane: Boolean(code && ["pane_not_found", "not_found", "unknown_pane"].includes(code)) ||
			/pane[^\n]*(?:not found|does not exist|closed)/i.test(raw),
	};
}

function explicitPaneIdFromResponse(stdout: string): string | undefined {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.result) || !isRecord(parsed.result.pane)) return undefined;
		const paneId = parsed.result.pane.pane_id;
		return typeof paneId === "string" && paneId.length <= 256 && /^[a-z0-9:_-]+$/i.test(paneId)
			? paneId
			: undefined;
	} catch {
		return undefined;
	}
}

const SAFE_OPERATIONS = new Set([
	"pane split",
	"pane list",
	"pane get",
	"pane rename",
	"pane run",
	"pane wait-output",
	"pane read",
	"pane close",
	"pane process-info",
	"agent start",
	"agent get",
	"agent focus",
]);

function safeOperation(args: readonly string[]): string {
	const candidate = `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
	return SAFE_OPERATIONS.has(candidate) ? candidate : "command";
}

export class HerdrCommandError extends Error {
	readonly operation: string;
	readonly exitCode: number;
	readonly killed: boolean;
	readonly herdrCode?: string;
	readonly paneId?: string;
	readonly missingPane: boolean;

	constructor(args: readonly string[], result: ExecResult) {
		const metadata = parseErrorMetadata(result.stderr, result.stdout);
		const operation = safeOperation(args);
		const status = result.killed ? "timed out or was cancelled" : `failed with exit code ${result.code}`;
		const code = metadata.code ? ` (Herdr code: ${metadata.code})` : "";
		super(`Herdr ${operation} ${status}${code}`);
		this.name = "HerdrCommandError";
		this.operation = operation;
		this.exitCode = result.code;
		this.killed = result.killed;
		this.herdrCode = metadata.code;
		this.paneId = explicitPaneIdFromResponse(result.stdout);
		this.missingPane = metadata.missingPane;
	}
}

export class HerdrProtocolError extends Error {
	constructor(operation: string, detail: string) {
		super(`Herdr ${operation} returned ${detail}`);
		this.name = "HerdrProtocolError";
	}
}

function parseEnvelope(stdout: string, operation: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new HerdrProtocolError(operation, "invalid JSON");
	}
	if (!isRecord(parsed) || !isRecord(parsed.result)) {
		throw new HerdrProtocolError(operation, "an unexpected JSON envelope");
	}
	return parsed.result;
}

function parsePane(value: unknown, operation: string): HerdrPane {
	if (!isRecord(value) || typeof value.pane_id !== "string" || !value.pane_id.trim()) {
		throw new HerdrProtocolError(operation, "an invalid pane object");
	}
	for (const [field, candidate] of [
		["tab_id", value.tab_id],
		["workspace_id", value.workspace_id],
		["cwd", value.cwd],
		["label", value.label],
	] as const) {
		if (candidate !== undefined && candidate !== null && typeof candidate !== "string") {
			throw new HerdrProtocolError(operation, `an invalid pane.${field}`);
		}
	}
	if (value.focused !== undefined && typeof value.focused !== "boolean") {
		throw new HerdrProtocolError(operation, "an invalid pane.focused");
	}
	return {
		paneId: value.pane_id,
		...(typeof value.tab_id === "string" ? { tabId: value.tab_id } : {}),
		...(typeof value.workspace_id === "string" ? { workspaceId: value.workspace_id } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(typeof value.label === "string" ? { label: value.label } : {}),
		...(typeof value.focused === "boolean" ? { focused: value.focused } : {}),
	};
}

function parseAgent(value: unknown, operation: string): HerdrAgent {
	if (!isRecord(value) || typeof value.pane_id !== "string" || !value.pane_id.trim()) {
		throw new HerdrProtocolError(operation, "an invalid agent object");
	}
	for (const [field, candidate] of [
		["name", value.name],
		["agent", value.agent],
		["agent_status", value.agent_status],
	] as const) {
		if (candidate !== undefined && candidate !== null && typeof candidate !== "string") {
			throw new HerdrProtocolError(operation, `an invalid agent.${field}`);
		}
	}
	return {
		paneId: value.pane_id,
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(typeof value.agent === "string" ? { agent: value.agent } : {}),
		...(typeof value.agent_status === "string" ? { status: value.agent_status } : {}),
	};
}

function optionalPid(value: unknown, operation: string, field: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new HerdrProtocolError(operation, `an invalid process_info.${field}`);
	}
	return value as number;
}

function parsePaneProcess(value: unknown, operation: string): HerdrPaneProcess {
	if (!isRecord(value)) throw new HerdrProtocolError(operation, "an invalid foreground process");
	const pid = optionalPid(value.pid, operation, "foreground_processes.pid");
	if (!pid) throw new HerdrProtocolError(operation, "an invalid foreground process pid");
	for (const [field, candidate] of [
		["name", value.name],
		["cmdline", value.cmdline],
		["cwd", value.cwd],
	] as const) {
		if (candidate !== undefined && candidate !== null && typeof candidate !== "string") {
			throw new HerdrProtocolError(operation, `an invalid foreground process ${field}`);
		}
	}
	if (value.argv !== undefined &&
		(!Array.isArray(value.argv) || !value.argv.every((item) => typeof item === "string"))) {
		throw new HerdrProtocolError(operation, "an invalid foreground process argv");
	}
	return {
		pid,
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(typeof value.cmdline === "string" ? { cmdline: value.cmdline } : {}),
		...(Array.isArray(value.argv) ? { argv: [...value.argv] as string[] } : {}),
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
	};
}

function parsePaneProcessInfo(value: unknown, operation: string): HerdrPaneProcessInfo {
	if (!isRecord(value) || typeof value.pane_id !== "string" || !value.pane_id.trim() ||
		!Array.isArray(value.foreground_processes)) {
		throw new HerdrProtocolError(operation, "an invalid process_info object");
	}
	const shellPid = optionalPid(value.shell_pid, operation, "shell_pid");
	const foregroundProcessGroupId = optionalPid(
		value.foreground_process_group_id,
		operation,
		"foreground_process_group_id",
	);
	return {
		paneId: value.pane_id,
		...(shellPid ? { shellPid } : {}),
		...(foregroundProcessGroupId ? { foregroundProcessGroupId } : {}),
		foregroundProcesses: value.foreground_processes.map((process) => parsePaneProcess(process, operation)),
	};
}

interface PaneOutputLines {
	lines: string[];
	trailingNewline: boolean;
}

function splitPaneOutput(text: string): PaneOutputLines {
	const normalized = text.replace(/\r\n/g, "\n");
	const trailingNewline = normalized.endsWith("\n");
	const lines = normalized.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, trailingNewline };
}

/** Append the viewport after scrollback while removing their largest exact line overlap. */
export function mergePaneOutput(recent: string, visible: string): string {
	if (!recent) return visible;
	if (!visible) return recent;
	const recentOutput = splitPaneOutput(recent);
	const visibleOutput = splitPaneOutput(visible);
	let overlap = Math.min(recentOutput.lines.length, visibleOutput.lines.length);
	for (; overlap > 0; overlap -= 1) {
		const recentStart = recentOutput.lines.length - overlap;
		if (visibleOutput.lines.slice(0, overlap).every((line, index) =>
			line === recentOutput.lines[recentStart + index])) break;
	}
	const appended = visibleOutput.lines.slice(overlap);
	const combined = [...recentOutput.lines, ...appended].join("\n");
	const trailingNewline = appended.length > 0
		? visibleOutput.trailingNewline
		: recentOutput.trailingNewline;
	return trailingNewline ? `${combined}\n` : combined;
}

function boundedReadLines(lines: number): number {
	if (!Number.isInteger(lines) || lines < 1) throw new Error("pane read lines must be a positive integer");
	return Math.min(lines, DEFAULT_MAX_LINES);
}

export function isMissingPaneError(error: unknown): boolean {
	return error instanceof HerdrCommandError && error.missingPane;
}

export class HerdrClient {
	constructor(
		private readonly executor: HerdrExecutor,
		private readonly command = "herdr",
	) {}

	private async execute(args: string[], timeout: number, signal?: AbortSignal): Promise<ExecResult> {
		signal?.throwIfAborted();
		const result = await this.executor(this.command, args, { timeout, ...(signal ? { signal } : {}) });
		if (result.code !== 0 || result.killed) throw new HerdrCommandError(args, result);
		return result;
	}

	private async executeJson(args: string[], timeout: number, operation: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const result = await this.execute(args, timeout, signal);
		return parseEnvelope(result.stdout, operation);
	}

	async splitPane(options: SplitPaneOptions, signal?: AbortSignal): Promise<HerdrPane> {
		const target = options.target ?? "current";
		const args = [
			"pane",
			"split",
			...(target === "current" ? ["--current"] : ["--pane", target]),
			"--direction",
			options.direction,
			...(options.ratio === undefined ? [] : ["--ratio", String(options.ratio)]),
			"--cwd",
			options.cwd,
			...Object.entries(options.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
			options.focus ? "--focus" : "--no-focus",
		];
		const result = await this.executeJson(args, 10_000, "pane split", signal);
		return parsePane(result.pane, "pane split");
	}

	async listPanes(signal?: AbortSignal): Promise<HerdrPane[]> {
		const result = await this.executeJson(["pane", "list"], 5_000, "pane list", signal);
		if (!Array.isArray(result.panes)) throw new HerdrProtocolError("pane list", "an invalid panes array");
		return result.panes.map((pane) => parsePane(pane, "pane list"));
	}

	async getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPane> {
		const result = await this.executeJson(["pane", "get", paneId], 5_000, "pane get", signal);
		return parsePane(result.pane, "pane get");
	}

	async getPaneProcessInfo(paneId: string, signal?: AbortSignal): Promise<HerdrPaneProcessInfo> {
		const result = await this.executeJson(
			["pane", "process-info", "--pane", paneId],
			5_000,
			"pane process-info",
			signal,
		);
		return parsePaneProcessInfo(result.process_info, "pane process-info");
	}

	async renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
		await this.executeJson(["pane", "rename", paneId, label], 5_000, "pane rename", signal);
	}

	/** `pane run` intentionally has no JSON stdout on Herdr 0.7.5–0.8.x. */
	async runPane(paneId: string, command: string, signal?: AbortSignal): Promise<void> {
		await this.execute(["pane", "run", paneId, command], 5_000, signal);
	}

	async waitOutput(paneId: string, options: WaitOutputOptions, signal?: AbortSignal): Promise<string> {
		if ((options.match ? 1 : 0) + (options.regex ? 1 : 0) !== 1) {
			throw new Error("waitOutput requires exactly one of match or regex");
		}
		const args = [
			"pane",
			"wait-output",
			paneId,
			...(options.match ? ["--match", options.match] : ["--regex", options.regex as string]),
			"--source",
			"recent-unwrapped",
			"--lines",
			String(options.lines ?? 2_000),
			"--timeout",
			String(options.timeoutMs),
		];
		const result = await this.executeJson(args, options.timeoutMs + 2_000, "pane wait-output", signal);
		if (typeof result.matched_line !== "string") {
			throw new HerdrProtocolError("pane wait-output", "an invalid matched_line");
		}
		return result.matched_line;
	}

	/** `pane read` writes plain text, not a JSON envelope. */
	async readPane(paneId: string, lines: number, signal?: AbortSignal): Promise<string> {
		const boundedLines = boundedReadLines(lines);
		const readSource = async (source: "recent-unwrapped" | "visible"): Promise<string> => {
			const result = await this.execute([
				"pane",
				"read",
				paneId,
				"--source",
				source,
				"--lines",
				String(boundedLines),
				"--format",
				"text",
			], 5_000, signal);
			return result.stdout;
		};

		let recent: string | undefined;
		let recentError: unknown;
		try {
			recent = await readSource("recent-unwrapped");
		} catch (error) {
			if (isMissingPaneError(error) || signal?.aborted) throw error;
			recentError = error;
		}

		let visible: string | undefined;
		let visibleError: unknown;
		try {
			visible = await readSource("visible");
		} catch (error) {
			if (isMissingPaneError(error) || signal?.aborted) throw error;
			visibleError = error;
		}

		if (recent === undefined && visible === undefined) throw visibleError ?? recentError;
		return mergePaneOutput(recent ?? "", visible ?? "");
	}

	async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
		await this.executeJson(["pane", "close", paneId], 5_000, "pane close", signal);
	}

	async startAgent(options: StartAgentOptions, signal?: AbortSignal): Promise<void> {
		await this.executeJson([
			"agent",
			"start",
			options.name,
			"--kind",
			options.kind,
			"--pane",
			options.paneId,
			"--timeout",
			String(options.timeoutMs ?? 30_000),
			"--",
			...options.args,
		], (options.timeoutMs ?? 30_000) + 5_000, "agent start", signal);
	}

	async getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgent> {
		const result = await this.executeJson(["agent", "get", target], 5_000, "agent get", signal);
		return parseAgent(result.agent, "agent get");
	}

	async focusAgent(target: string, signal?: AbortSignal): Promise<void> {
		await this.executeJson(["agent", "focus", target], 5_000, "agent focus", signal);
	}
}
