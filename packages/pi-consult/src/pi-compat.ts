/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Host-version-tolerant loader for pi-ai's completeSimple, plus the runtime
 * facade bridge on ModelRegistry so OAuth providers keep credential-derived
 * fields such as Copilot's baseUrl.
 */

type CompleteSimpleFn = typeof import("@earendil-works/pi-ai/compat").completeSimple;

export function getRuntimeCompleteSimple(modelRegistry: unknown): CompleteSimpleFn | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		const completeSimple = (runtime as { completeSimple?: unknown }).completeSimple;
		return typeof completeSimple === "function" ? (completeSimple.bind(runtime) as CompleteSimpleFn) : undefined;
	} catch {
		return undefined;
	}
}

const MODULE_NOT_FOUND_CODES = new Set(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

function isModuleNotFound(err: unknown): boolean {
	for (
		let current: unknown = err, depth = 0;
		current != null && depth < 16;
		current = (current as { cause?: unknown }).cause, depth++
	) {
		if (typeof current === "object" && MODULE_NOT_FOUND_CODES.has((current as { code?: unknown }).code as string)) {
			return true;
		}
	}
	return false;
}

export async function loadCompleteSimple(): Promise<CompleteSimpleFn> {
	let mod: { completeSimple?: CompleteSimpleFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { completeSimple?: CompleteSimpleFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err;
		mod = (await import("@earendil-works/pi-ai")) as { completeSimple?: CompleteSimpleFn };
	}
	const completeSimple = mod.completeSimple;
	if (typeof completeSimple !== "function") {
		throw new Error(
			"pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version",
		);
	}
	return completeSimple;
}
