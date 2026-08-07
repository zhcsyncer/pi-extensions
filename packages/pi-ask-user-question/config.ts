import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	getAskUserQuestionConfigPath,
	getLegacyAskUserQuestionConfigPaths,
} from "./config-paths.js";

/** Key spec for the questionnaire collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
}

type ConfigRead =
	| { ok: true; config: AskUserQuestionConfig; source: string }
	| { ok: false; reason: string };

const emittedConfigNotices = new Set<string>();
const LOCK_FILE_PREFIX = ".config-migration.lock.";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function emitConfigNotice(message: string): void {
	if (emittedConfigNotices.has(message)) return;
	emittedConfigNotices.add(message);
	console.warn(message);
}

function readConfigFile(path: string): ConfigRead {
	try {
		const source = readFileSync(path, "utf8");
		const parsed = JSON.parse(source) as unknown;
		if (!isRecord(parsed)) return { ok: false, reason: "the root value must be a JSON object" };
		return { ok: true, config: parsed as AskUserQuestionConfig, source };
	} catch (error) {
		return { ok: false, reason: errorMessage(error) };
	}
}

function normalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJsonValue);
	if (isRecord(value)) {
		const normalized = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value).sort()) normalized[key] = normalizeJsonValue(value[key]);
		return normalized;
	}
	return typeof value === "number" && Object.is(value, -0) ? 0 : value;
}

function configsEqual(left: AskUserQuestionConfig, right: AskUserQuestionConfig): boolean {
	return isDeepStrictEqual(normalizeJsonValue(left), normalizeJsonValue(right));
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

interface LockCandidate {
	name: string;
	ticket: bigint;
}

function readLockTicket(path: string): bigint {
	try {
		const metadata = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(metadata) && typeof metadata.ticket === "string" ? BigInt(metadata.ticket) : 0n;
	} catch {
		// An incomplete or malformed fresh candidate blocks safely.
		return 0n;
	}
}

function lockOwnerIsAlive(name: string): boolean {
	const rawPid = name.slice(LOCK_FILE_PREFIX.length).split(".", 1)[0];
	const pid = Number(rawPid);
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(isRecord(error) && error.code === "ESRCH");
	}
}

function activeLockCandidates(directory: string, ownName: string, now: number): LockCandidate[] {
	const candidates: LockCandidate[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(LOCK_FILE_PREFIX)) continue;
		const path = join(directory, name);
		try {
			if (
				name !== ownName &&
				now - statSync(path).mtimeMs > LOCK_STALE_MS &&
				!lockOwnerIsAlive(name)
			) {
				// Candidate names contain a UUID and are never reused. Reclaim only
				// after its PID is gone, so a paused owner cannot resume concurrently.
				unlinkSync(path);
				continue;
			}
			candidates.push({ name, ticket: readLockTicket(path) });
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			throw error;
		}
	}
	return candidates.sort((left, right) =>
		left.ticket < right.ticket ? -1 : left.ticket > right.ticket ? 1 : left.name.localeCompare(right.name),
	);
}

function withConfigLock<T>(directory: string, fn: () => T): T {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockName = `${LOCK_FILE_PREFIX}${process.pid}.${randomUUID()}`;
	const lockPath = join(directory, lockName);
	const descriptor = openSync(lockPath, "wx", 0o600);
	const ticket = process.hrtime.bigint();
	try {
		writeFileSync(
			descriptor,
			`${JSON.stringify({ pid: process.pid, ticket: ticket.toString(), createdAt: new Date().toISOString() })}\n`,
		);
	} catch (error) {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
		throw error;
	}
	closeSync(descriptor);
	const deadline = Date.now() + LOCK_WAIT_MS;

	try {
		// Let simultaneously created candidates enter the same deterministic
		// election before the oldest monotonic ticket starts the critical section.
		sleepSync(LOCK_RETRY_MS);
		while (true) {
			const candidates = activeLockCandidates(directory, lockName, Date.now());
			if (candidates[0]?.name === lockName) return fn();
			if (Date.now() >= deadline) throw new Error(`timed out waiting for config lock in ${directory}`);
			sleepSync(LOCK_RETRY_MS);
		}
	} finally {
		rmSync(lockPath, { force: true });
	}
}

function writeConfigAtomically(path: string, source: string): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, source, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function removeUnverifiedCanonical(path: string, verificationError: Error): never {
	try {
		unlinkSync(path);
	} catch (rollbackError) {
		throw new Error(
			`${verificationError.message}; could not remove the unverified canonical file (${errorMessage(rollbackError)})`,
			{ cause: verificationError },
		);
	}
	throw verificationError;
}

function reconcileLegacyFiles(
	targetPath: string,
	canonical: AskUserQuestionConfig,
	legacyPaths: readonly string[],
): void {
	for (const legacyPath of legacyPaths) {
		if (!existsSync(legacyPath)) continue;
		const legacy = readConfigFile(legacyPath);
		if (!legacy.ok) {
			emitConfigNotice(
				`[pi-ask-user-question] Legacy config at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
				`canonical config at ${targetPath} remains active and the legacy file was preserved.`,
			);
			continue;
		}
		if (!configsEqual(canonical, legacy.config)) {
			emitConfigNotice(
				`[pi-ask-user-question] Ignoring conflicting legacy config at ${legacyPath}; canonical config is ${targetPath}. ` +
				"The legacy file was preserved.",
			);
			continue;
		}
		const verified = readConfigFile(targetPath);
		if (!verified.ok || !configsEqual(canonical, verified.config)) {
			emitConfigNotice(
				`[pi-ask-user-question] Could not semantically re-read canonical config at ${targetPath}; ` +
				`equivalent legacy config at ${legacyPath} was preserved.`,
			);
			continue;
		}
		try {
			unlinkSync(legacyPath);
			emitConfigNotice(
				`[pi-ask-user-question] Removed equivalent legacy config at ${legacyPath}; canonical config is ${targetPath}.`,
			);
		} catch (error) {
			emitConfigNotice(
				`[pi-ask-user-question] Could not remove equivalent legacy config at ${legacyPath} (${errorMessage(error)}); ` +
				"the canonical file remains active and the legacy file was preserved.",
			);
		}
	}
}

function readCanonical(targetPath: string): AskUserQuestionConfig {
	const canonical = readConfigFile(targetPath);
	if (canonical.ok) return canonical.config;
	emitConfigNotice(
		`[pi-ask-user-question] Could not read canonical config at ${targetPath} (${canonical.reason}); ` +
		"legacy config was not used or removed.",
	);
	return {};
}

function loadConfigUnderLock(targetPath: string, legacyPaths: readonly string[]): AskUserQuestionConfig {
	if (existsSync(targetPath)) {
		const canonical = readConfigFile(targetPath);
		if (!canonical.ok) {
			emitConfigNotice(
				`[pi-ask-user-question] Could not read canonical config at ${targetPath} (${canonical.reason}); ` +
				"legacy config was not used or removed.",
			);
			return {};
		}
		reconcileLegacyFiles(targetPath, canonical.config, legacyPaths);
		return canonical.config;
	}

	const legacyPath = legacyPaths.find((path) => existsSync(path));
	if (!legacyPath) return {};
	const legacy = readConfigFile(legacyPath);
	if (!legacy.ok) {
		emitConfigNotice(
			`[pi-ask-user-question] Legacy config at ${legacyPath} is unreadable or malformed (${legacy.reason}); ` +
			"it was preserved and no lower-priority legacy file was used.",
		);
		return {};
	}

	// Preserve the valid legacy JSON bytes instead of stringify-parsing them.
	// JSON.parse accepts values such as 1e400 that JSON.stringify would silently
	// rewrite to null, violating the existing raw-object semantics.
	writeConfigAtomically(targetPath, legacy.source);
	const verified = readConfigFile(targetPath);
	if (!verified.ok || !configsEqual(legacy.config, verified.config)) {
		removeUnverifiedCanonical(
			targetPath,
			new Error(`semantic round-trip verification failed for ${targetPath}`),
		);
	}
	unlinkSync(legacyPath);
	emitConfigNotice(`[pi-ask-user-question] Migrated config from ${legacyPath} to ${targetPath}.`);
	reconcileLegacyFiles(targetPath, verified.config, legacyPaths.filter((path) => path !== legacyPath));
	return verified.config;
}

/**
 * Load Ask User Question configuration synchronously. The canonical path
 * always wins; legacy XDG/~/.config data is migrated once when safe and
 * remains a fallback only when the canonical write cannot be completed.
 */
export function loadConfig(): AskUserQuestionConfig {
	const targetPath = getAskUserQuestionConfigPath();
	const legacyPaths = getLegacyAskUserQuestionConfigPaths();
	const hasLegacy = legacyPaths.some((path) => existsSync(path));

	if (!existsSync(targetPath) && !hasLegacy) return {};
	if (existsSync(targetPath) && !hasLegacy) return readCanonical(targetPath);

	try {
		return withConfigLock(dirname(targetPath), () => loadConfigUnderLock(targetPath, legacyPaths));
	} catch (error) {
		emitConfigNotice(
			`[pi-ask-user-question] Failed to migrate or reconcile config at ${targetPath} (${errorMessage(error)}); ` +
			"legacy files were preserved.",
		);
		if (existsSync(targetPath)) return readCanonical(targetPath);
		const fallbackPath = legacyPaths.find((path) => existsSync(path));
		if (fallbackPath) {
			const fallback = readConfigFile(fallbackPath);
			if (fallback.ok) return fallback.config;
		}
		// A competing migrator publishes canonical before deleting legacy. Recheck
		// after a missing legacy read so that transition cannot look like no config.
		if (existsSync(targetPath)) return readCanonical(targetPath);
		return {};
	}
}

export function resetAskUserQuestionConfigNoticesForTests(): void {
	emittedConfigNotices.clear();
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` could match every bare `]`.
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

export { validateGuidanceFields };
