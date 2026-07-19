import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyShipManifest } from "./test-fixtures.js";

function makePackage(directory: string, files: string[], tree: string[]): void {
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture", files }));
	for (const relativePath of tree) {
		const absolutePath = join(directory, relativePath);
		mkdirSync(join(absolutePath, ".."), { recursive: true });
		writeFileSync(absolutePath, "export {};\n");
	}
}

describe("verifyShipManifest", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-todo-manifest-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("covers nested files via a trailing-slash directory entry", () => {
		makePackage(directory, ["index.ts", "runner/"], ["index.ts", "runner/runner.ts", "runner/step.ts"]);
		expect(verifyShipManifest(directory).missing).toEqual([]);
	});

	it("covers nested files via a bare directory entry", () => {
		makePackage(directory, ["index.ts", "runner"], ["index.ts", "runner/runner.ts", "runner/step.ts"]);
		expect(verifyShipManifest(directory).missing).toEqual([]);
	});

	it("does not cover a sibling file that only shares a directory prefix", () => {
		makePackage(directory, ["load"], ["load/cache.ts", "loader.ts"]);
		expect(verifyShipManifest(directory).missing).toEqual(["loader.ts"]);
	});

	it("flags a production file omitted from the files array", () => {
		makePackage(directory, ["index.ts"], ["index.ts", "iterate.ts"]);
		expect(verifyShipManifest(directory).missing).toEqual(["iterate.ts"]);
	});

	it("ignores tests and package-local test fixtures", () => {
		makePackage(directory, ["index.ts"], ["index.ts", "index.test.ts", "test-fixtures.ts"]);
		expect(verifyShipManifest(directory).missing).toEqual([]);
	});

	it("flags files entries with no corresponding path", () => {
		makePackage(directory, ["index.ts", "ghost.ts", "phantom/"], ["index.ts"]);
		expect(verifyShipManifest(directory).stale).toEqual(["ghost.ts", "phantom/"]);
	});

	it("accepts existing non-TypeScript asset entries", () => {
		makePackage(directory, ["index.ts", "README.md", "load"], ["index.ts", "README.md", "load/cache.ts"]);
		expect(verifyShipManifest(directory).stale).toEqual([]);
	});
});
