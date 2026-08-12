import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessShell } from "../config.ts";
import { getCompanionProcessScriptDir } from "../config-paths.ts";

const DEFAULT_STALE_SCRIPT_MS = 24 * 60 * 60 * 1_000;
const SCRIPT_NAME_PATTERN = /^process-[0-9a-f-]{36}\.sh$/;

export interface PreparedPaneCommand {
	paneCommand: string;
	cleanup(): Promise<void>;
}

export interface ProcessCommandPreparer {
	prepare(command: string, shell: ProcessShell): Promise<PreparedPaneCommand>;
}

export interface ProcessCommandTransportOptions {
	scriptDirectory?: string;
	bashExecutable?: string;
	staleScriptMs?: number;
	now?: () => number;
}

function defaultBashExecutable(): string {
	return process.platform !== "win32" && existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Quote one argument for the common Bash, Fish, and Zsh pane shells. */
export function quotePaneShellWord(value: string): string {
	if (value.includes("\0")) throw new Error("pane shell argument must not contain NUL bytes");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatExecutable(value: string): string {
	if (!value || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error("bash executable must be a non-empty single-line command or path");
	}
	return /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : quotePaneShellWord(value);
}

/**
 * Keep arbitrary model-authored Bash out of the pane's interactive shell parser.
 * The generated script unlinks itself as soon as Bash opens it, while the outer
 * pane shell stays alive so exited-process logs and ownership remain observable.
 */
export class ProcessCommandTransport implements ProcessCommandPreparer {
	private readonly scriptDirectory: string;
	private readonly bashExecutable: string;
	private readonly staleScriptMs: number;
	private readonly now: () => number;

	constructor(options: ProcessCommandTransportOptions = {}) {
		this.scriptDirectory = options.scriptDirectory ?? getCompanionProcessScriptDir();
		this.bashExecutable = options.bashExecutable ?? defaultBashExecutable();
		this.staleScriptMs = options.staleScriptMs ?? DEFAULT_STALE_SCRIPT_MS;
		this.now = options.now ?? Date.now;
	}

	async prepare(command: string, shell: ProcessShell): Promise<PreparedPaneCommand> {
		if (shell === "pane") {
			return { paneCommand: command, cleanup: async () => undefined };
		}
		if (process.platform === "win32") {
			throw new Error("Bash script transport is not supported on Windows; use shell=pane");
		}

		await mkdir(this.scriptDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.scriptDirectory, 0o700);
		await this.cleanupStaleScripts();

		const path = join(this.scriptDirectory, `process-${randomUUID()}.sh`);
		const cleanup = async (): Promise<void> => {
			await rm(path, { force: true });
		};
		const source = [
			"#!/usr/bin/env bash",
			'command rm -f -- "${BASH_SOURCE[0]}" 2>/dev/null || :',
			command,
			"",
		].join("\n");
		try {
			await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await chmod(path, 0o600);
		} catch (error) {
			await cleanup().catch(() => undefined);
			throw error;
		}

		return {
			paneCommand: `${formatExecutable(this.bashExecutable)} ${quotePaneShellWord(path)}`,
			cleanup,
		};
	}

	private async cleanupStaleScripts(): Promise<void> {
		const entries = await readdir(this.scriptDirectory, { withFileTypes: true });
		await Promise.all(entries.map(async (entry) => {
			if (!entry.isFile() || !SCRIPT_NAME_PATTERN.test(entry.name)) return;
			const path = join(this.scriptDirectory, entry.name);
			try {
				const metadata = await stat(path);
				if (this.now() - metadata.mtimeMs >= this.staleScriptMs) await rm(path, { force: true });
			} catch (error) {
				if (!isMissing(error)) return;
			}
		}));
	}
}
