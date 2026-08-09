import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RuntimeSnapshot } from "../runtime.ts";
import {
	LAUNCH_STATE_FILE,
	MERGE_ACK_FILE,
	MERGE_REQUEST_FILE,
	MERGE_STATE_FILE,
	ackMatchesRequest,
	isLaunchState,
	isMergeAck,
	isMergeRequest,
	isMergeState,
	type LaunchState,
	type MergeAck,
	type MergeRequest,
	type MergeState,
} from "./protocol.ts";
import { isBtwPayload, type BtwPayload } from "./types.ts";

const PAYLOAD_FILE = "payload.json";
const LAUNCH_PREFIX = "launch-";
const DELIVERY_LOCK_FILE = ".delivery.lock";
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MAILBOX_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
export const DEFAULT_STALE_LAUNCH_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwner(uid: number, path: string): void {
	const expected = currentUid();
	if (expected !== undefined && uid !== expected) throw new Error(`Refusing state not owned by the current user: ${path}`);
}

function assertPrivate(mode: number, path: string): void {
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new Error(`Refusing state with group or other permissions: ${path}`);
	}
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export function defaultBtwStateRoot(runtime: RuntimeSnapshot, agentDir = getAgentDir()): string {
	const namespace = createHash("sha256")
		.update(runtime.socketPath ?? "outside-herdr")
		.digest("hex")
		.slice(0, 16);
	return join(agentDir, "extension-data", "pi-herdr-companion", "btw", namespace);
}

export type PaneLiveness = true | false | "unknown";

export interface StaleCleanupOptions {
	maxAgeMs?: number;
	now?: number;
	isPaneLive(paneId: string): Promise<PaneLiveness>;
}

export class BtwContextStore {
	readonly root: string;
	private canonicalRoot?: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	async create(payload: BtwPayload): Promise<string> {
		if (!isBtwPayload(payload)) throw new Error("Invalid /btw payload");
		if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
			throw new Error(`Parent context exceeds the private /btw payload limit (${MAX_PAYLOAD_BYTES} bytes)`);
		}
		const root = await this.ensureRoot(true);
		if (!root) throw new Error("Could not create /btw state root");
		const launchDir = await mkdtemp(join(root, LAUNCH_PREFIX));
		try {
			await chmod(launchDir, 0o700);
			const payloadPath = join(launchDir, PAYLOAD_FILE);
			await this.writeAtomicInDirectory(launchDir, PAYLOAD_FILE, payload);
			await this.writeAtomicInDirectory(launchDir, LAUNCH_STATE_FILE, {
				version: 1,
				launchId: payload.launchId,
				status: "payload_created",
				updatedAt: new Date().toISOString(),
			} satisfies LaunchState);
			return payloadPath;
		} catch (error) {
			await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async listLaunchPayloadPaths(): Promise<string[]> {
		const root = await this.ensureRoot(false);
		if (!root) return [];
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(LAUNCH_PREFIX))
			.map((entry) => join(root, entry.name, PAYLOAD_FILE));
	}

	async read(payloadPath: string): Promise<BtwPayload> {
		const value = await this.readLaunchJson(payloadPath, PAYLOAD_FILE, MAX_PAYLOAD_BYTES);
		if (!isBtwPayload(value)) throw new Error("Invalid or unsupported /btw payload");
		return value;
	}

	async writeLaunchState(payloadPath: string, state: LaunchState): Promise<void> {
		if (!isLaunchState(state)) throw new Error("Invalid /btw launch state");
		await this.writeLaunchJson(payloadPath, LAUNCH_STATE_FILE, state);
	}

	async readLaunchState(payloadPath: string): Promise<LaunchState | undefined> {
		const value = await this.readOptionalLaunchJson(payloadPath, LAUNCH_STATE_FILE);
		if (value === undefined) return undefined;
		if (!isLaunchState(value)) throw new Error("Invalid /btw launch state");
		return value;
	}

	async createMergeRequest(payloadPath: string, request: MergeRequest): Promise<void> {
		if (!isMergeRequest(request)) throw new Error("Invalid /btw merge request");
		await this.withDeliveryLock(payloadPath, async () => {
			const current = await this.readOptionalLaunchJson(payloadPath, MERGE_REQUEST_FILE);
			const ack = await this.readOptionalLaunchJson(payloadPath, MERGE_ACK_FILE);
			if (current !== undefined && !ackMatchesRequest(ack, current)) {
				throw new Error("A merge request is already pending for this side thread");
			}
			const launchDir = await this.validateLaunchDir(payloadPath, false);
			if (!launchDir) throw new Error("Missing /btw launch directory");
			await Promise.all([
				rm(join(launchDir, MERGE_STATE_FILE), { force: true }),
				rm(join(launchDir, MERGE_ACK_FILE), { force: true }),
			]);
			await this.writeAtomicInDirectory(launchDir, MERGE_REQUEST_FILE, request);
		});
	}

	async readMergeRequest(payloadPath: string): Promise<unknown> {
		return this.readOptionalLaunchJson(payloadPath, MERGE_REQUEST_FILE);
	}

	async writeMergeState(payloadPath: string, state: MergeState): Promise<void> {
		if (!isMergeState(state)) throw new Error("Invalid /btw merge state");
		await this.writeLaunchJson(payloadPath, MERGE_STATE_FILE, state);
	}

	async readMergeState(payloadPath: string): Promise<MergeState | undefined> {
		const value = await this.readOptionalLaunchJson(payloadPath, MERGE_STATE_FILE);
		if (value === undefined) return undefined;
		if (!isMergeState(value)) throw new Error("Invalid /btw merge state");
		return value;
	}

	async writeMergeAck(payloadPath: string, ack: MergeAck): Promise<void> {
		if (!isMergeAck(ack)) throw new Error("Invalid /btw merge acknowledgement");
		await this.writeLaunchJson(payloadPath, MERGE_ACK_FILE, ack);
	}

	async readMergeAck(payloadPath: string): Promise<MergeAck | undefined> {
		const value = await this.readOptionalLaunchJson(payloadPath, MERGE_ACK_FILE);
		if (value === undefined) return undefined;
		if (!isMergeAck(value)) throw new Error("Invalid /btw merge acknowledgement");
		return value;
	}

	async withDeliveryLock<T>(payloadPath: string, operation: () => Promise<T>): Promise<T> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error("Missing /btw launch directory");
		const lockPath = join(launchDir, DELIVERY_LOCK_FILE);
		const deadline = Date.now() + LOCK_WAIT_MS;
		const token = randomUUID();
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(lockPath, "wx", 0o600);
				await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
				await handle.sync();
			} catch (error) {
				if (!isRecord(error) || error.code !== "EEXIST") throw error;
				const info = await lstat(lockPath).catch(() => undefined);
				if (info) {
					if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe /btw delivery lock: ${lockPath}`);
					assertOwner(info.uid, lockPath);
					assertPrivate(info.mode, lockPath);
					if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
						await rm(lockPath, { force: true });
						continue;
					}
				}
				if (Date.now() >= deadline) throw new Error("Timed out waiting for /btw delivery lock");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		try {
			return await operation();
		} finally {
			await handle.close();
			try {
				const current = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
				if (isRecord(current) && current.token === token) await rm(lockPath, { force: true });
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}

	async removeIfNoPendingMerge(payloadPath: string): Promise<boolean> {
		const request = await this.readMergeRequest(payloadPath).catch(() => undefined);
		if (request !== undefined) {
			const ack = await this.readMergeAck(payloadPath).catch(() => undefined);
			if (!ackMatchesRequest(ack, request)) return false;
		}
		await this.remove(payloadPath);
		return true;
	}

	async remove(payloadPath: string): Promise<void> {
		const launchDir = await this.validateLaunchDir(payloadPath, true);
		if (launchDir) await rm(launchDir, { recursive: true, force: true });
	}

	/** Remove only stale launches that have neither a live/unknown pane nor an unacknowledged request. */
	async removeStale(options: StaleCleanupOptions): Promise<string[]> {
		const root = await this.ensureRoot(false);
		if (!root) return [];
		const now = options.now ?? Date.now();
		const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_LAUNCH_MS;
		const removed: string[] = [];
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.name.startsWith(LAUNCH_PREFIX) || !entry.isDirectory()) continue;
			const launchDir = join(root, entry.name);
			const info = await lstat(launchDir).catch(() => undefined);
			if (!info?.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= now - maxAgeMs) continue;
			try {
				assertOwner(info.uid, launchDir);
				assertPrivate(info.mode, launchDir);
				const payloadPath = join(launchDir, PAYLOAD_FILE);
				const request = await this.readMergeRequest(payloadPath);
				const ack = await this.readMergeAck(payloadPath).catch(() => undefined);
				if (request !== undefined && !ackMatchesRequest(ack, request)) continue;
				const launchState = await this.readLaunchState(payloadPath).catch(() => undefined);
				if (launchState?.paneId) {
					const live = await options.isPaneLive(launchState.paneId).catch(() => "unknown" as const);
					if (live !== false) continue;
				}
				await rm(launchDir, { recursive: true, force: true });
				removed.push(payloadPath);
			} catch {
				// One unsafe/corrupt launch must not authorize deletion or abort the rest.
			}
		}
		return removed;
	}

	private async writeLaunchJson(payloadPath: string, fileName: string, value: unknown): Promise<void> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error("Missing /btw launch directory");
		await this.writeAtomicInDirectory(launchDir, fileName, value);
	}

	private async writeAtomicInDirectory(directory: string, fileName: string, value: unknown): Promise<void> {
		const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
			await handle.sync();
			await handle.close();
			handle = undefined;
			await chmod(temporary, 0o600);
			await rename(temporary, join(directory, fileName));
			await chmod(join(directory, fileName), 0o600);
			// Best-effort directory fsync makes the rename durable across host crashes
			// on filesystems that support syncing directory handles.
			const directoryHandle = await open(directory, "r").catch(() => undefined);
			if (directoryHandle) {
				await directoryHandle.sync().catch(() => undefined);
				await directoryHandle.close();
			}
		} finally {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async readOptionalLaunchJson(payloadPath: string, fileName: string): Promise<unknown> {
		const path = await this.validateLaunchFile(payloadPath, fileName, true);
		if (!path) return undefined;
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	}

	private async readLaunchJson(payloadPath: string, fileName: string, maximumBytes: number): Promise<unknown> {
		const path = await this.validateLaunchFile(payloadPath, fileName, false, maximumBytes);
		if (!path) throw new Error(`Missing /btw state file: ${fileName}`);
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	}

	private async validateLaunchFile(
		payloadPath: string,
		fileName: string,
		optional: boolean,
		maximumBytes = MAX_MAILBOX_BYTES,
	): Promise<string | undefined> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error("Missing /btw launch directory");
		const candidate = join(launchDir, fileName);
		let info;
		try {
			info = await lstat(candidate);
		} catch (error) {
			if (optional && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe /btw state file: ${candidate}`);
		assertOwner(info.uid, candidate);
		assertPrivate(info.mode, candidate);
		if (info.size > maximumBytes) throw new Error(`Refusing oversized /btw state file: ${candidate}`);
		const canonical = await realpath(candidate);
		const root = await this.ensureRoot(false);
		if (!root || !isInside(root, canonical)) throw new Error(`Refusing /btw state outside private root: ${candidate}`);
		return canonical;
	}

	private async validateLaunchDir(payloadPath: string, allowMissing: boolean): Promise<string | undefined> {
		const root = await this.ensureRoot(false);
		if (!root) {
			if (allowMissing) return undefined;
			throw new Error(`Missing /btw state root: ${this.root}`);
		}
		const absolutePayload = resolve(payloadPath);
		const launchDir = dirname(absolutePayload);
		if (basename(absolutePayload) !== PAYLOAD_FILE || !basename(launchDir).startsWith(LAUNCH_PREFIX) || !isInside(root, launchDir)) {
			throw new Error(`Refusing invalid /btw payload path: ${payloadPath}`);
		}
		let info;
		try {
			info = await lstat(launchDir);
		} catch (error) {
			if (allowMissing && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe /btw launch directory: ${launchDir}`);
		assertOwner(info.uid, launchDir);
		assertPrivate(info.mode, launchDir);
		const canonical = await realpath(launchDir);
		if (!isInside(root, canonical)) throw new Error(`Refusing /btw launch outside private root: ${launchDir}`);
		return canonical;
	}

	private async ensureRoot(create: boolean): Promise<string | undefined> {
		if (this.canonicalRoot) return this.canonicalRoot;
		if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
		let info;
		try {
			info = await lstat(this.root);
		} catch (error) {
			if (!create && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing unsafe /btw state root: ${this.root}`);
		assertOwner(info.uid, this.root);
		if (create) {
			await chmod(this.root, 0o700);
			info = await lstat(this.root);
		}
		assertPrivate(info.mode, this.root);
		const canonical = await realpath(this.root);
		const canonicalInfo = await stat(canonical);
		assertOwner(canonicalInfo.uid, canonical);
		assertPrivate(canonicalInfo.mode, canonical);
		this.canonicalRoot = canonical;
		return canonical;
	}
}
