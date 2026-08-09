import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
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

function boundedTail(value: string, maxCharacters = 4_000): string {
	if (value.length <= maxCharacters) return value;
	return `…${value.slice(-maxCharacters)}`;
}

function parseErrorPayload(stderr: string, stdout: string): { code?: string; message: string } {
	const raw = stderr.trim() || stdout.trim() || "Herdr command failed";
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined;
			const message = typeof parsed.error.message === "string" && parsed.error.message.trim()
				? parsed.error.message.trim()
				: raw;
			return { code, message: boundedTail(message) };
		}
	} catch {
		// Preserve a bounded tail of non-JSON diagnostics.
	}
	return { message: boundedTail(raw) };
}

export class HerdrCommandError extends Error {
	readonly args: readonly string[];
	readonly exitCode: number;
	readonly killed: boolean;
	readonly herdrCode?: string;
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: readonly string[], result: ExecResult) {
		const parsed = parseErrorPayload(result.stderr, result.stdout);
		super(`herdr ${args.join(" ")}: ${parsed.message}`);
		this.name = "HerdrCommandError";
		this.args = [...args];
		this.exitCode = result.code;
		this.killed = result.killed;
		this.herdrCode = parsed.code;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
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

export function isMissingPaneError(error: unknown): boolean {
	if (!(error instanceof HerdrCommandError)) return false;
	if (error.herdrCode && ["pane_not_found", "not_found", "unknown_pane"].includes(error.herdrCode)) return true;
	return /pane[^\n]*(?:not found|does not exist|closed)/i.test(error.message);
}

export class HerdrClient {
	constructor(
		private readonly executor: HerdrExecutor,
		private readonly command = "herdr",
	) {}

	private async execute(args: string[], timeout: number, signal?: AbortSignal): Promise<ExecResult> {
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
		const result = await this.execute([
			"pane",
			"read",
			paneId,
			"--source",
			"recent-unwrapped",
			"--lines",
			String(lines),
			"--format",
			"text",
		], 5_000, signal);
		return result.stdout;
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

	async focusAgent(target: string, signal?: AbortSignal): Promise<void> {
		await this.executeJson(["agent", "focus", target], 5_000, "agent focus", signal);
	}
}
