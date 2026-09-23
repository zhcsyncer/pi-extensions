import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildScopedRevdiffConfig, resolveRevdiffBinary, revdiffConfigPath, reviewDiffWithRevdiff,
	type DiffReviewAdapters,
} from "../diff-review.js";
import type { DiffTarget } from "../diff-target.js";

const worktree: DiffTarget = { description: "Working tree", revisions: [], includeUntracked: true };
const committed: DiffTarget = { description: "Committed", revisions: ["a".repeat(40), "b".repeat(40)], includeUntracked: false };
assert.equal(revdiffConfigPath("/repo", { XDG_CONFIG_HOME: "/ignored" }, "/home/test"), "/home/test/.config/revdiff/config");
assert.equal(revdiffConfigPath("/repo", { REVDIFF_CONFIG: "" }, "/home/test"), "/home/test/.config/revdiff/config");
assert.equal(revdiffConfigPath("/repo", { REVDIFF_CONFIG: "settings/revdiff.ini" }), "/repo/settings/revdiff.ini");
assert.equal(revdiffConfigPath("/repo", { REVDIFF_CONFIG: "/custom/config" }), "/custom/config");
const source = "[Application Options]\nstaged = true\nwrap = true\n[color options]\ncolor-accent = #abcdef";
for (const includeUntracked of [true, false]) {
	assert.equal(buildScopedRevdiffConfig(source, includeUntracked), `${source}\n[Application Options]\nstaged = false\nuntracked = ${includeUntracked}\nexit-code-on-annotations = true\n`, "scope must end in its own Application Options section without rewriting user preferences");
}

function testContext() {
	let handoffs = 0;
	const ctx = {
		mode: "tui", isIdle: () => true,
		ui: {
			custom: async <T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: T) => void) => unknown) => {
				handoffs++;
				let result: T | undefined;
				factory({ stop() {}, start() {}, requestRender() {} }, {}, {}, (value) => { result = value; });
				return result as T;
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, get handoffs() { return handoffs; } };
}

const originalConfig = process.env.REVDIFF_CONFIG;
try {
	delete process.env.REVDIFF_CONFIG;
	// These tests run even when CI has no revdiff binary.
	for (const failure of ["default-missing", "explicit-missing", "read", "write", "validate", "busy"] as const) {
		const test = testContext();
		let cleaned = false;
		let written: string | undefined;
		if (failure === "explicit-missing") process.env.REVDIFF_CONFIG = "missing.ini";
		else delete process.env.REVDIFF_CONFIG;
		const adapters: DiffReviewAdapters = {
			resolveBinary: () => "/fake/revdiff", makeTempDirectory: async () => "/fake/review",
			readConfig: async () => {
				if (failure === "read") throw Object.assign(new Error("config access denied"), { code: "EACCES" });
				if (failure.endsWith("missing")) throw Object.assign(new Error("config missing"), { code: "ENOENT" });
				return source;
			},
			writeConfig: async (_path, content) => {
				if (failure === "write") throw new Error("config write failed");
				written = content;
			},
			validateConfig: async () => {
				if (failure === "validate") throw new Error("config parse warning");
				if (failure === "busy") test.ctx.isIdle = () => false;
			},
			spawn: (() => ({ status: 0, signal: null }) as SpawnSyncReturns<Buffer>) as never,
			readAnnotations: async () => "", writeTerminal: () => {},
			removeTempDirectory: async () => { cleaned = true; },
		};
		const result = await reviewDiffWithRevdiff(test.ctx, "/repo", worktree, adapters);
		assert.equal(cleaned, true, `${failure}: temporary config must be cleaned even on errors`);
		if (failure === "default-missing") {
			assert.equal(result.kind, "clean");
			assert.equal(written, buildScopedRevdiffConfig("", true), "missing default config should use an empty source");
		} else {
			assert.equal(result.kind, failure === "busy" ? "unsupported" : "error");
			assert.equal(test.handoffs, 0, `${failure}: unvalidated config must never hand off the terminal`);
		}
	}

	const binary = resolveRevdiffBinary();
	if (!binary) {
		console.log("SKIP: native revdiff config integration (binary not installed); pure scope/path/error contracts passed");
	} else {
		const directory = await mkdtemp(join(tmpdir(), "glance-revdiff-config-test-"));
		const sourcePath = join(directory, "native.ini");
		const markerPath = join(directory, "post-flush-ran");
		try {
			// Exercise production source resolution, read/write, validation, argv and cleanup.
			process.env.REVDIFF_CONFIG = "native.ini";
			for (const target of [worktree, committed]) {
				const nativeSource = `[Application Options]\nstaged = true\nuntracked = ${!target.includeUntracked}\nexit-code-on-annotations = false\ncompact = true\nwrap = true\ntheme = dracula\ninclude = src/\nexclude = vendor/\npost-flush-command = touch ${markerPath}\n[color options]\ncolor-accent = #abcdef\n`;
				await writeFile(sourcePath, nativeSource);
				const test = testContext();
				let tempDirectory = "";
				let effective = "";
				let launchedConfig = "";
				const result = await reviewDiffWithRevdiff(test.ctx, directory, target, {
					resolveBinary: () => binary,
					makeTempDirectory: async () => { tempDirectory = await mkdtemp(join(directory, "review-")); return tempDirectory; },
					writeTerminal: () => {},
					spawn: ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
						const configArg = args.find((arg) => arg.startsWith("--config="));
						assert.ok(configArg, "production handoff must explicitly select the generated config");
						launchedConfig = configArg.slice("--config=".length);
						assert.equal(launchedConfig, join(tempDirectory, "config"));
						assert.notEqual(launchedConfig, sourcePath);
						// Real-file dump only: no stdin config, no TTY and no invocation of run().
						const native = spawnSync(command, [...args, "--dump-config"], {
							cwd: options.cwd, env: options.env, encoding: "utf8", stdio: "pipe", timeout: 10_000,
						});
						assert.equal(native.error, undefined);
						assert.equal(native.status, 0, native.stderr);
						assert.equal(native.stderr, "");
						effective = native.stdout;
						return { status: native.status, signal: native.signal } as SpawnSyncReturns<Buffer>;
					}) as never,
				});
				assert.equal(result.kind, "clean", JSON.stringify(result));
				for (const [key, value] of Object.entries({ staged: "false", untracked: String(target.includeUntracked), "exit-code-on-annotations": "true", compact: "true", wrap: "true", theme: "dracula", "color-accent": "#abcdef", include: "src/", exclude: "vendor/" })) {
					assert.match(effective, new RegExp(`^(?:; )?${key} = ${value}$`, "m"), `native effective config must preserve ${key}=${value}`);
				}
				assert.equal(await readFile(sourcePath, "utf8"), nativeSource, "user config must remain byte-for-byte unchanged");
				assert.equal(existsSync(launchedConfig), false);
				assert.equal(existsSync(tempDirectory), false, "successful review must remove the temporary scoped config");
				assert.equal(existsSync(markerPath), false, "dump validation must not execute post-flush commands");
			}
			for (const invalid of ["[Application Options]\nstaged = true\nnot-a-revdiff-option = true\n", "[Application Options\nstaged = true\n", "[Application Options]\ndump-keys = true\n"]) {
				await writeFile(sourcePath, invalid);
				const test = testContext();
				let tempDirectory = "";
				const result = await reviewDiffWithRevdiff(test.ctx, directory, worktree, {
					resolveBinary: () => binary,
					makeTempDirectory: async () => { tempDirectory = await mkdtemp(join(directory, "invalid-")); return tempDirectory; },
				});
				assert.equal(result.kind, "error", "native warnings/invalid INI must not silently bypass the appended scope");
				assert.match(result.kind === "error" ? result.message : "", /Cannot prepare a safe revdiff scope/);
				assert.equal(test.handoffs, 0);
				assert.equal(existsSync(tempDirectory), false, "native validation failure must clean up");
				assert.equal(await readFile(sourcePath, "utf8"), invalid);
			}
			console.log("✓ real revdiff scoped config integration: worktree/committed scope, preferences, filters, source preservation and invalid-config cleanup");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
} finally {
	if (originalConfig === undefined) delete process.env.REVDIFF_CONFIG;
	else process.env.REVDIFF_CONFIG = originalConfig;
}
console.log("✓ revdiff scoped config pure/path/error contracts passed");
