import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const BTW_TOOL_MODES = ["inherit", "all", "read-only", "none"] as const;
export type BtwToolMode = (typeof BTW_TOOL_MODES)[number];
export type SplitDirection = "down" | "right";
export type ProcessLifetime = "session" | "persistent";

export interface CompanionConfig {
	runtime: {
		injectSystemPrompt: boolean;
	};
	process: {
		defaultDirection: SplitDirection;
		defaultRatio: number;
		readyTimeoutMs: number;
		defaultLifetime: ProcessLifetime;
	};
	btw: {
		autoSubmit: boolean;
		model: "inherit" | string;
		thinking: "inherit" | ThinkingLevel;
		tools: BtwToolMode;
		split: SplitDirection;
	};
	blocked: {
		askUserQuestion: boolean;
	};
}

export const DEFAULT_CONFIG: Readonly<CompanionConfig> = Object.freeze({
	runtime: Object.freeze({ injectSystemPrompt: true }),
	process: Object.freeze({
		defaultDirection: "down",
		defaultRatio: 0.35,
		readyTimeoutMs: 60_000,
		defaultLifetime: "session",
	}),
	btw: Object.freeze({
		autoSubmit: false,
		model: "inherit",
		thinking: "inherit",
		tools: "inherit",
		split: "down",
	}),
	blocked: Object.freeze({ askUserQuestion: true }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaults(): CompanionConfig {
	return {
		runtime: { ...DEFAULT_CONFIG.runtime },
		process: { ...DEFAULT_CONFIG.process },
		btw: { ...DEFAULT_CONFIG.btw },
		blocked: { ...DEFAULT_CONFIG.blocked },
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

export function isModelName(value: string): boolean {
	return /^[^/\s]+\/\S+$/.test(value);
}

export function parseCompanionConfig(value: unknown): CompanionConfig {
	if (!isRecord(value)) throw new Error("herdr-companion config must be a JSON object");
	const config = cloneDefaults();

	if ("runtime" in value) {
		if (!isRecord(value.runtime)) throw new Error("runtime must be an object");
		if ("injectSystemPrompt" in value.runtime) {
			config.runtime.injectSystemPrompt = requireBoolean(value.runtime.injectSystemPrompt, "runtime.injectSystemPrompt");
		}
	}

	if ("process" in value) {
		if (!isRecord(value.process)) throw new Error("process must be an object");
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
	}

	if ("btw" in value) {
		if (!isRecord(value.btw)) throw new Error("btw must be an object");
		if ("autoSubmit" in value.btw) config.btw.autoSubmit = requireBoolean(value.btw.autoSubmit, "btw.autoSubmit");
		if ("model" in value.btw) {
			if (value.btw.model !== "inherit" && (typeof value.btw.model !== "string" || !isModelName(value.btw.model))) {
				throw new Error("btw.model must be inherit or provider/model");
			}
			config.btw.model = value.btw.model;
		}
		if ("thinking" in value.btw) {
			if (value.btw.thinking !== "inherit" && !THINKING_LEVELS.includes(value.btw.thinking as ThinkingLevel)) {
				throw new Error(`btw.thinking must be inherit or one of: ${THINKING_LEVELS.join(", ")}`);
			}
			config.btw.thinking = value.btw.thinking as "inherit" | ThinkingLevel;
		}
		if ("tools" in value.btw) {
			if (!BTW_TOOL_MODES.includes(value.btw.tools as BtwToolMode)) {
				throw new Error("btw.tools must be inherit, all, read-only, or none");
			}
			config.btw.tools = value.btw.tools as BtwToolMode;
		}
		if ("split" in value.btw) config.btw.split = requireDirection(value.btw.split, "btw.split");
	}

	if ("blocked" in value) {
		if (!isRecord(value.blocked)) throw new Error("blocked must be an object");
		if ("askUserQuestion" in value.blocked) {
			config.blocked.askUserQuestion = requireBoolean(value.blocked.askUserQuestion, "blocked.askUserQuestion");
		}
	}

	return config;
}

export function getCompanionConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "herdr-companion.json");
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export class CompanionConfigStore {
	constructor(readonly path = getCompanionConfigPath()) {}

	async load(): Promise<CompanionConfig> {
		try {
			return parseCompanionConfig(JSON.parse(await readFile(this.path, "utf8")) as unknown);
		} catch (error) {
			if (isMissing(error)) return cloneDefaults();
			throw error;
		}
	}

	async save(config: CompanionConfig): Promise<CompanionConfig> {
		const validated = parseCompanionConfig(config);
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const temporary = join(directory, `.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(temporary, 0o600);
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
			return validated;
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	async reset(): Promise<CompanionConfig> {
		await rm(this.path, { force: true });
		return cloneDefaults();
	}
}
