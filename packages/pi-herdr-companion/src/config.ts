import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withCandidateLock } from "./candidate-lock.ts";
import { getCompanionConfigPath } from "./config-paths.ts";

export { getCompanionConfigPath } from "./config-paths.ts";

export type SplitDirection = "down" | "right";
export type ProcessLifetime = "session" | "persistent";
export const PROCESS_SHELLS = ["bash", "pane"] as const;
export type ProcessShell = (typeof PROCESS_SHELLS)[number];
export const DEFAULT_PROCESS_SHELL: ProcessShell = process.platform === "win32" ? "pane" : "bash";

export interface BlockedSourceRule {
	name: string;
	label: string;
}

export interface CompanionConfig {
	runtime: {
		injectSystemPrompt: boolean;
	};
	process: {
		defaultDirection: SplitDirection;
		defaultRatio: number;
		readyTimeoutMs: number;
		defaultLifetime: ProcessLifetime;
		defaultShell: ProcessShell;
	};
	blocked: {
		events: BlockedSourceRule[];
		tools: BlockedSourceRule[];
	};
}

export const DEFAULT_BLOCKED_TOOL_RULE: Readonly<BlockedSourceRule> = Object.freeze({
	name: "ask_user_question",
	label: "question",
});

export const DEFAULT_CONFIG: Readonly<CompanionConfig> = Object.freeze({
	runtime: Object.freeze({ injectSystemPrompt: true }),
	process: Object.freeze({
		defaultDirection: "down",
		defaultRatio: 0.35,
		readyTimeoutMs: 60_000,
		defaultLifetime: "session",
		defaultShell: DEFAULT_PROCESS_SHELL,
	}),
	blocked: Object.freeze({
		events: Object.freeze([]) as unknown as BlockedSourceRule[],
		tools: Object.freeze([DEFAULT_BLOCKED_TOOL_RULE]) as unknown as BlockedSourceRule[],
	}),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const known = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !known.has(key));
	if (unknown) throw new Error(`${field}.${unknown} is not supported`);
}

function cloneRules(rules: readonly BlockedSourceRule[]): BlockedSourceRule[] {
	return rules.map((rule) => ({ ...rule }));
}

export function cloneCompanionConfig(config: Readonly<CompanionConfig> = DEFAULT_CONFIG): CompanionConfig {
	return {
		runtime: { ...config.runtime },
		process: { ...config.process },
		blocked: {
			events: cloneRules(config.blocked.events),
			tools: cloneRules(config.blocked.tools),
		},
	};
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${field} must be true or false`);
	return value;
}

function requireDirection(value: unknown, field: string): SplitDirection {
	if (value !== "down" && value !== "right") throw new Error(`${field} must be down or right`);
	return value;
}

function requireFiniteRange(value: unknown, field: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${field} must be a finite number between ${minimum} and ${maximum}`);
	}
	return value;
}

function parseBlockedRules(value: unknown, field: string, kind: "event" | "tool"): BlockedSourceRule[] {
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	const seen = new Set<string>();
	return value.map((candidate, index) => {
		if (!isRecord(candidate)) throw new Error(`${field}[${index}] must be an object`);
		const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
		const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
		if (!name || /[\s\0]/.test(name)) throw new Error(`${field}[${index}].name must be a non-empty name without whitespace`);
		if (kind === "tool" && !/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new Error(`${field}[${index}].name must use letters, digits, underscores, or hyphens`);
		}
		if (kind === "event" && name === "herdr:blocked") {
			throw new Error(`${field}[${index}].name must not proxy herdr:blocked into itself`);
		}
		if (!label || /[\r\n\0]/.test(label) || label.length > 80) {
			throw new Error(`${field}[${index}].label must be 1..80 characters on one line`);
		}
		if (seen.has(name)) throw new Error(`${field} contains duplicate source ${name}`);
		seen.add(name);
		return { name, label };
	});
}

export function parseCompanionConfig(value: unknown): CompanionConfig {
	if (!isRecord(value)) throw new Error("herdr-companion config must be a JSON object");
	assertKnownKeys(value, ["runtime", "process", "blocked"], "config");
	const config = cloneCompanionConfig();

	if ("runtime" in value) {
		if (!isRecord(value.runtime)) throw new Error("runtime must be an object");
		assertKnownKeys(value.runtime, ["injectSystemPrompt"], "runtime");
		if ("injectSystemPrompt" in value.runtime) {
			config.runtime.injectSystemPrompt = requireBoolean(value.runtime.injectSystemPrompt, "runtime.injectSystemPrompt");
		}
	}

	if ("process" in value) {
		if (!isRecord(value.process)) throw new Error("process must be an object");
		assertKnownKeys(value.process, ["defaultDirection", "defaultRatio", "readyTimeoutMs", "defaultLifetime", "defaultShell"], "process");
		if ("defaultDirection" in value.process) {
			config.process.defaultDirection = requireDirection(value.process.defaultDirection, "process.defaultDirection");
		}
		if ("defaultRatio" in value.process) {
			config.process.defaultRatio = requireFiniteRange(value.process.defaultRatio, "process.defaultRatio", 0.1, 0.9);
		}
		if ("readyTimeoutMs" in value.process) {
			config.process.readyTimeoutMs = Math.floor(requireFiniteRange(value.process.readyTimeoutMs, "process.readyTimeoutMs", 100, 600_000));
		}
		if ("defaultLifetime" in value.process) {
			if (value.process.defaultLifetime !== "session" && value.process.defaultLifetime !== "persistent") {
				throw new Error("process.defaultLifetime must be session or persistent");
			}
			config.process.defaultLifetime = value.process.defaultLifetime;
		}
		if ("defaultShell" in value.process) {
			if (!PROCESS_SHELLS.includes(value.process.defaultShell as ProcessShell)) {
				throw new Error("process.defaultShell must be bash or pane");
			}
			config.process.defaultShell = value.process.defaultShell as ProcessShell;
		}
	}

	if ("blocked" in value) {
		if (!isRecord(value.blocked)) throw new Error("blocked must be an object");
		assertKnownKeys(value.blocked, ["events", "tools"], "blocked");
		if ("events" in value.blocked) config.blocked.events = parseBlockedRules(value.blocked.events, "blocked.events", "event");
		if ("tools" in value.blocked) config.blocked.tools = parseBlockedRules(value.blocked.tools, "blocked.tools", "tool");
	}

	return config;
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function readConfig(path: string): Promise<CompanionConfig> {
	try {
		return parseCompanionConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch (error) {
		throw new Error(`Invalid Herdr Companion config at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

async function writeVerified(path: string, config: CompanionConfig): Promise<CompanionConfig> {
	const validated = parseCompanionConfig(config);
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		const roundTrip = await readConfig(path);
		if (!isDeepStrictEqual(validated, roundTrip)) throw new Error(`semantic round-trip verification failed for ${path}`);
		return roundTrip;
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export class CompanionConfigStore {
	constructor(readonly path = getCompanionConfigPath()) {}

	private withLock<T>(operation: () => Promise<T>): Promise<T> {
		return withCandidateLock(dirname(this.path), {
			prefix: ".config.lock.",
			waitMs: 1_000,
			staleMs: 30_000,
		}, operation);
	}

	async load(): Promise<CompanionConfig> {
		return await exists(this.path) ? readConfig(this.path) : cloneCompanionConfig();
	}

	async save(config: CompanionConfig): Promise<CompanionConfig> {
		const validated = parseCompanionConfig(config);
		return this.withLock(() => writeVerified(this.path, validated));
	}

	async reset(): Promise<CompanionConfig> {
		await this.withLock(() => rm(this.path, { force: true }));
		return cloneCompanionConfig();
	}
}
