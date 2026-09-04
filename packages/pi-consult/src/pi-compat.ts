/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Host-version-tolerant loader for pi-ai's streamSimple, plus the runtime
 * facade bridge on ModelRegistry so OAuth providers keep credential-derived
 * fields such as Copilot's baseUrl.
 */

type StreamSimpleFn = typeof import("@earendil-works/pi-ai/compat").streamSimple;

export function getRuntimeStreamSimple(modelRegistry: unknown): StreamSimpleFn | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		const streamSimple = (runtime as { streamSimple?: unknown }).streamSimple;
		return typeof streamSimple === "function" ? (streamSimple.bind(runtime) as StreamSimpleFn) : undefined;
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

export async function loadStreamSimple(): Promise<StreamSimpleFn> {
	let mod: { streamSimple?: StreamSimpleFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { streamSimple?: StreamSimpleFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err;
		mod = (await import("@earendil-works/pi-ai")) as { streamSimple?: StreamSimpleFn };
	}
	const streamSimple = mod.streamSimple;
	if (typeof streamSimple !== "function") {
		throw new Error(
			"pi-ai does not expose streamSimple on /compat or the package root — unsupported host pi-ai version",
		);
	}
	return streamSimple;
}
