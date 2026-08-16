import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

export async function ensurePrivateDir(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function writeFileAtomically(file: string, contents: string): Promise<void> {
	const directory = dirname(file);
	await ensurePrivateDir(directory);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function readTextFile(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

export async function withDirectoryLock<T>(directory: string, name: string, fn: () => Promise<T>): Promise<T> {
	await ensurePrivateDir(directory);
	const lockPath = join(directory, name);
	const deadline = Date.now() + 2_000;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
					await unlink(lockPath);
					continue;
				}
			} catch (statError) {
				if (isMissingFile(statError)) continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}
