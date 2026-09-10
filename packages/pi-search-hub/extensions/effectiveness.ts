/**
 * Local call-effectiveness tracking. Records search/read outcomes per backend
 * and warns when that backend starts failing. Does not estimate quota.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NoticeSink } from "./diagnostics.js";
import { getEffectivenessPath } from "./paths.js";

export type SearchHubOp = "search" | "read";
export type ErrorClass = "timeout" | "http_429" | "http_402" | "http_5xx" | "http_4xx" | "aborted" | "other";

export interface EffectivenessAttempt {
	t: number;
	ok: boolean;
	latencyMs: number;
	resultCount?: number;
	errorClass?: string;
}

export const MAX_ATTEMPTS_PER_KEY = 50;
export const CONSECUTIVE_FAILURE_ALERT = 3;
export const ROLLING_WINDOW = 10;
export const ROLLING_MIN_SAMPLES = 8;
export const ROLLING_SUCCESS_FLOOR = 0.5;

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;

type EffectivenessState = Record<string, EffectivenessAttempt[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "";
}

export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted);
}

export function classifyError(error: unknown): ErrorClass {
	const name = errorName(error);
	const message = errorMessage(error);
	if (name === "TimeoutError" || /timeout/i.test(message)) return "timeout";
	if (name === "AbortError" || /aborted/i.test(message)) return "aborted";
	const status = message.match(/\b(429|402|5\d\d|4\d\d)\b/);
	if (status) {
		const code = Number(status[1]);
		if (code === 429) return "http_429";
		if (code === 402) return "http_402";
		if (code >= 500) return "http_5xx";
		return "http_4xx";
	}
	return "other";
}

function successRate(attempts: EffectivenessAttempt[]): number {
	if (attempts.length === 0) return 1;
	return attempts.filter((attempt) => attempt.ok).length / attempts.length;
}

export function attemptKey(backend: string, op: SearchHubOp): string {
	return `${backend}:${op}`;
}

export function evaluateDegradation(
	label: string,
	op: SearchHubOp,
	attempts: EffectivenessAttempt[],
): string | null {
	if (attempts.length === 0) return null;
	const last = attempts[attempts.length - 1]!;
	if (last.ok) return null;

	let streak = 0;
	for (let index = attempts.length - 1; index >= 0; index--) {
		if (attempts[index]!.ok) break;
		streak++;
	}
	if (streak === CONSECUTIVE_FAILURE_ALERT) {
		const reason = last.errorClass ? ` (${last.errorClass})` : "";
		return `Search Hub: ${label} ${op} failed ${CONSECUTIVE_FAILURE_ALERT} times in a row${reason}.`;
	}
	if (streak > CONSECUTIVE_FAILURE_ALERT) return null;

	const window = attempts.slice(-ROLLING_WINDOW);
	if (window.length < ROLLING_MIN_SAMPLES) return null;
	const newRate = successRate(window);
	if (newRate >= ROLLING_SUCCESS_FLOOR) return null;
	const previous = attempts.slice(0, -1).slice(-ROLLING_WINDOW);
	if (previous.length >= ROLLING_MIN_SAMPLES && successRate(previous) < ROLLING_SUCCESS_FLOOR) return null;
	return `Search Hub: ${label} ${op} success rate ${Math.round(newRate * 100)}% over the last ${window.length} calls.`;
}

function parseAttempt(value: unknown): EffectivenessAttempt | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.t !== "number" || !Number.isFinite(value.t)) return undefined;
	if (typeof value.ok !== "boolean") return undefined;
	if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) return undefined;
	const attempt: EffectivenessAttempt = {
		t: value.t,
		ok: value.ok,
		latencyMs: Math.floor(value.latencyMs),
	};
	if (typeof value.resultCount === "number" && Number.isFinite(value.resultCount) && value.resultCount >= 0) {
		attempt.resultCount = Math.floor(value.resultCount);
	}
	if (typeof value.errorClass === "string" && value.errorClass) attempt.errorClass = value.errorClass;
	return attempt;
}

function parseState(text: string): EffectivenessState {
	const value = JSON.parse(text) as unknown;
	if (!isRecord(value)) return {};
	const root = isRecord(value.keys) ? value.keys : value;
	const state: EffectivenessState = {};
	for (const [key, entries] of Object.entries(root)) {
		if (!Array.isArray(entries)) continue;
		const attempts = entries.map(parseAttempt).filter((attempt): attempt is EffectivenessAttempt => Boolean(attempt));
		if (attempts.length > 0) state[key] = attempts.slice(-MAX_ATTEMPTS_PER_KEY);
	}
	return state;
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function atomicWrite(file: string, state: EffectivenessState): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify({ keys: state }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
	const target = getEffectivenessPath();
	const directory = dirname(target);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, ".effectiveness.lock");
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

export async function recordEffectiveness(input: {
	backend: string;
	label: string;
	op: SearchHubOp;
	ok: boolean;
	latencyMs: number;
	resultCount?: number;
	errorClass?: string;
}): Promise<string | null> {
	return await withLock(async () => {
		const path = getEffectivenessPath();
		let state: EffectivenessState = {};
		if (await exists(path)) {
			try {
				state = parseState(await readFile(path, "utf8"));
			} catch {
				return null;
			}
		}
		const key = attemptKey(input.backend, input.op);
		const attempts = [...(state[key] ?? [])];
		const next: EffectivenessAttempt = {
			t: Date.now(),
			ok: input.ok,
			latencyMs: Math.max(0, Math.floor(input.latencyMs)),
		};
		if (input.ok && input.resultCount !== undefined) next.resultCount = Math.max(0, Math.floor(input.resultCount));
		if (!input.ok && input.errorClass) next.errorClass = input.errorClass;
		attempts.push(next);
		state[key] = attempts.slice(-MAX_ATTEMPTS_PER_KEY);
		await atomicWrite(path, state);
		return evaluateDegradation(input.label, input.op, state[key]);
	});
}

export async function reportEffectiveness(input: {
	backend: string;
	label: string;
	op: SearchHubOp;
	ok: boolean;
	latencyMs: number;
	resultCount?: number;
	error?: unknown;
	signal?: AbortSignal;
	onNotice?: NoticeSink;
}): Promise<void> {
	try {
		if (!input.ok && isUserAbort(input.error, input.signal)) return;
		const warning = await recordEffectiveness({
			backend: input.backend,
			label: input.label,
			op: input.op,
			ok: input.ok,
			latencyMs: input.latencyMs,
			resultCount: input.resultCount,
			errorClass: input.ok ? undefined : classifyError(input.error),
		});
		if (warning) input.onNotice?.(warning);
	} catch {
		// Effectiveness tracking must not fail search or read.
	}
}
