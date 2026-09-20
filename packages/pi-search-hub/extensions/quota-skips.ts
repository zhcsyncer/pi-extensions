/**
 * Hosted-search quota skips. The provider error has no reset time, so skip
 * for the Codex-like 5h window instead of retrying every search.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NoticeSink } from "./diagnostics.js";
import { getQuotaSkipsPath } from "./paths.js";

/** Codex primary windows are ~5h. Weekly caps still only retry a few times a day. */
export const HOSTED_QUOTA_SKIP_MS = 5 * 60 * 60 * 1000;

const memory = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQuotaExhaustedError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /usage[_ ]limit|usage_not_included|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit|insufficient_quota|out of budget|quota exceeded/i.test(text);
}

function parseSkipState(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const state: Record<string, number> = {};
	for (const [backend, entry] of Object.entries(value)) {
		if (typeof entry === "number" && Number.isFinite(entry)) {
			state[backend] = entry;
			continue;
		}
		if (isRecord(entry) && typeof entry.until === "number" && Number.isFinite(entry.until)) {
			state[backend] = entry.until;
		}
	}
	return state;
}

function readSkipState(file: string): Record<string, number> {
	if (!existsSync(file)) return {};
	try {
		return parseSkipState(JSON.parse(readFileSync(file, "utf8")) as unknown);
	} catch {
		return {};
	}
}

function writeSkipState(file: string, state: Record<string, number>): void {
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function quotaSkipUntil(backend: string, now = Date.now()): number | undefined {
	const until = memory.get(backend) ?? readSkipState(getQuotaSkipsPath())[backend];
	if (until === undefined || until <= now) {
		memory.delete(backend);
		return undefined;
	}
	return until;
}

export function markHostedQuotaSkip(backend: string, now = Date.now()): number {
	const until = now + HOSTED_QUOTA_SKIP_MS;
	memory.set(backend, until);
	try {
		const file = getQuotaSkipsPath();
		const state = readSkipState(file);
		state[backend] = until;
		for (const [name, expiry] of Object.entries(state)) {
			if (expiry <= now) delete state[name];
		}
		writeSkipState(file, state);
	} catch {
		// Same-process skip still holds. A later search can persist.
	}
	return until;
}

export function filterQuotaSkipped(
	backends: readonly string[],
	onNotice?: NoticeSink,
	now = Date.now(),
): string[] {
	const usable: string[] = [];
	for (const backend of backends) {
		const until = quotaSkipUntil(backend, now);
		if (until === undefined) {
			usable.push(backend);
			continue;
		}
		onNotice?.(
			`Search Hub ${backend}: quota exhausted, skipping until ${new Date(until).toISOString()}.`,
		);
	}
	return usable;
}

export function clearQuotaSkipsForTests(): void {
	memory.clear();
}
