import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inputHasText } from "./input-stash.js";

export function getInputStashPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", "pi-glance", "state", "input-stash.json");
}

export interface InputStashStore {
	get(sessionFile: string | undefined): string | undefined;
	set(sessionFile: string | undefined, text: string): void;
	clear(sessionFile: string | undefined): void;
	has(sessionFile: string | undefined): boolean;
	refresh(): void;
}

export interface InputStashStoreOptions {
	readonly getAgentDir?: () => string;
	readonly persist?: boolean;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStashMap(raw: unknown): Record<string, string> {
	if (!isRecordValue(raw)) return {};
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && inputHasText(value)) next[key] = value;
	}
	return next;
}

function writeStashMap(file: string, map: Record<string, string>): void {
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (Object.keys(map).length === 0) {
		rmSync(file, { force: true });
		return;
	}
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(map)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
		chmodSync(file, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function readStashMap(file: string): Record<string, string> {
	try {
		if (!existsSync(file)) return {};
		return parseStashMap(JSON.parse(readFileSync(file, "utf8")) as unknown);
	} catch {
		return {};
	}
}

class MemoryInputStashStore implements InputStashStore {
	private readonly values = new Map<string, string>();

	private key(sessionFile: string | undefined): string {
		return sessionFile ?? "";
	}

	get(sessionFile: string | undefined): string | undefined {
		return this.values.get(this.key(sessionFile));
	}

	set(sessionFile: string | undefined, text: string): void {
		if (!inputHasText(text)) {
			this.clear(sessionFile);
			return;
		}
		this.values.set(this.key(sessionFile), text);
	}

	clear(sessionFile: string | undefined): void {
		this.values.delete(this.key(sessionFile));
	}

	has(sessionFile: string | undefined): boolean {
		return this.values.has(this.key(sessionFile));
	}

	refresh(): void {}
}

class FileInputStashStore implements InputStashStore {
	private ephemeral: string | undefined;
	private cache: Record<string, string> | undefined;

	constructor(private readonly resolveAgentDir: () => string) {}

	private path(): string {
		return getInputStashPath(this.resolveAgentDir());
	}

	private snapshot(): Record<string, string> {
		return readStashMap(this.path());
	}

	private commit(map: Record<string, string>): void {
		this.cache = map;
		try {
			writeStashMap(this.path(), map);
		} catch {
			this.cache = undefined;
		}
	}

	refresh(): void {
		this.cache = undefined;
	}

	get(sessionFile: string | undefined): string | undefined {
		if (!sessionFile) return this.ephemeral;
		this.cache = this.snapshot();
		return this.cache[sessionFile];
	}

	set(sessionFile: string | undefined, text: string): void {
		if (!inputHasText(text)) {
			this.clear(sessionFile);
			return;
		}
		if (!sessionFile) {
			this.ephemeral = text;
			return;
		}
		this.commit({ ...this.snapshot(), [sessionFile]: text });
	}

	clear(sessionFile: string | undefined): void {
		if (!sessionFile) {
			this.ephemeral = undefined;
			return;
		}
		const current = { ...this.snapshot() };
		if (!(sessionFile in current)) return;
		delete current[sessionFile];
		this.commit(current);
	}

	has(sessionFile: string | undefined): boolean {
		return inputHasText(this.get(sessionFile));
	}
}

export function createInputStashStore(options: InputStashStoreOptions = {}): InputStashStore {
	if (options.persist === false) return new MemoryInputStashStore();
	return new FileInputStashStore(options.getAgentDir ?? getAgentDir);
}
