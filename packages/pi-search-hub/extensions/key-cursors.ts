/**
 * Persistent per-backend API key rotation cursors.
 * Fingerprint is a hash of the resolved key list so secrets never hit disk.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getKeyCursorsPath } from "./paths.js";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface CursorEntry {
	index: number;
	fingerprint: string;
}

type CursorState = Record<string, CursorEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fingerprintKeyList(keys: readonly string[]): string {
	return createHash("sha256").update(keys.join("\0")).digest("hex");
}

function parseCursorState(value: unknown): CursorState {
	if (!isRecord(value)) return {};
	const state: CursorState = {};
	for (const [backend, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.index !== "number" || !Number.isInteger(entry.index) || entry.index < 0) continue;
		if (typeof entry.fingerprint !== "string" || entry.fingerprint.length === 0) continue;
		state[backend] = { index: entry.index, fingerprint: entry.fingerprint };
	}
	return state;
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function withLock<T>(directory: string, fn: () => T): T {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, ".key-cursors.lock");
	const deadline = Date.now() + LOCK_WAIT_MS;
	let descriptor: number | undefined;
	while (descriptor === undefined) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for key-cursor lock ${lockPath}`);
			sleepSync(LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
	}
}

function writeCursorState(file: string, state: CursorState): void {
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

function readCursorState(file: string): CursorState {
	if (!existsSync(file)) return {};
	try {
		return parseCursorState(JSON.parse(readFileSync(file, "utf8")) as unknown);
	} catch {
		return {};
	}
}

export function readKeyCursor(backend: string, keys: readonly string[]): number {
	if (keys.length === 0) return 0;
	const file = getKeyCursorsPath();
	const fingerprint = fingerprintKeyList(keys);
	const entry = readCursorState(file)[backend];
	if (!entry || entry.fingerprint !== fingerprint) return 0;
	return entry.index % keys.length;
}

export function writeKeyCursor(backend: string, keys: readonly string[], index: number): void {
	if (keys.length === 0) return;
	const file = getKeyCursorsPath();
	const fingerprint = fingerprintKeyList(keys);
	const nextIndex = ((index % keys.length) + keys.length) % keys.length;
	withLock(dirname(file), () => {
		const state = readCursorState(file);
		state[backend] = { index: nextIndex, fingerprint };
		writeCursorState(file, state);
	});
}
