import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_CANDIDATE_BYTES = 4 * 1024;

interface LockCandidate {
	name: string;
	ticket: bigint;
}

export interface CandidateLockOptions {
	prefix: string;
	waitMs: number;
	staleMs: number;
	retryMs?: number;
	isProcessAlive?(pid: number): boolean | "unknown" | Promise<boolean | "unknown">;
	/** Test seam after this process publishes its unique candidate and before election. */
	beforeElection?(): void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function candidatePid(name: string, prefix: string): number | undefined {
	const value = Number(name.slice(prefix.length).split(".", 1)[0]);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function defaultProcessAlive(pid: number): boolean | "unknown" {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ESRCH") return false;
		if (isRecord(error) && error.code === "EPERM") return true;
		return "unknown";
	}
}

async function readTicket(path: string): Promise<bigint> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isRecord(value) && typeof value.ticket === "string" ? BigInt(value.ticket) : 0n;
	} catch {
		// A fresh incomplete or malformed candidate blocks safely until its
		// uniquely named file becomes reclaimable after the owner process dies.
		return 0n;
	}
}

async function activeCandidates(
	directory: string,
	ownName: string,
	options: CandidateLockOptions,
): Promise<LockCandidate[]> {
	const candidates: LockCandidate[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.name.startsWith(options.prefix)) continue;
		const path = join(directory, entry.name);
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) {
				throw new Error(`Refusing unsafe lock candidate: ${path}`);
			}
			const uid = currentUid();
			if (uid !== undefined && info.uid !== uid) throw new Error(`Refusing lock candidate owned by another user: ${path}`);
			if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
				throw new Error(`Refusing group- or other-accessible lock candidate: ${path}`);
			}
			if (info.size > MAX_CANDIDATE_BYTES) throw new Error(`Refusing oversized lock candidate: ${path}`);

			if (entry.name !== ownName && Date.now() - info.mtimeMs > options.staleMs) {
				const pid = candidatePid(entry.name, options.prefix);
				const alive = pid === undefined
					? "unknown"
					: await (options.isProcessAlive?.(pid) ?? defaultProcessAlive(pid));
				if (alive === false) {
					// Candidate names include a UUID and are never reused. Removing this
					// exact stale name cannot unlink a successor's lock.
					await rm(path, { force: true });
					continue;
				}
			}
			candidates.push({ name: entry.name, ticket: await readTicket(path) });
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
	}
	return candidates.sort((left, right) =>
		left.ticket < right.ticket ? -1 : left.ticket > right.ticket ? 1 : left.name.localeCompare(right.name));
}

/**
 * Cross-process bakery lock backed by uniquely named candidate files.
 *
 * A crashed owner leaves only its UUID-bearing candidate. Recovery removes that
 * exact immutable name after the lease and a confirmed-dead PID, then reruns the
 * election; it never performs stat(fixed-path) -> unlink(fixed-path).
 */
export async function withCandidateLock<T>(
	directory: string,
	options: CandidateLockOptions,
	operation: () => Promise<T>,
): Promise<T> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const name = `${options.prefix}${process.pid}.${randomUUID()}`;
	const path = join(directory, name);
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify({
			pid: process.pid,
			ticket: process.hrtime.bigint().toString(),
			createdAt: new Date().toISOString(),
		})}\n`);
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}
	try {
		await handle.close();
	} catch (error) {
		await rm(path, { force: true }).catch(() => undefined);
		throw error;
	}

	const deadline = Date.now() + options.waitMs;
	const retryMs = options.retryMs ?? 25;
	try {
		await options.beforeElection?.();
		// Let candidates published in the same burst reach one deterministic election.
		await sleep(retryMs);
		for (;;) {
			const candidates = await activeCandidates(directory, name, options);
			if (candidates[0]?.name === name) return await operation();
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock in ${directory}`);
			await sleep(retryMs);
		}
	} finally {
		await rm(path, { force: true }).catch(() => undefined);
	}
}
