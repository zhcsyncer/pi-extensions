import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runIsolated } from "./run-isolated.mjs";

function fixture(factory, callback) {
	const root = mkdtempSync("/var/tmp/pi-loader-contract-");
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loader-contract", pi: { extensions: ["./index.ts"] } }));
		writeFileSync(join(root, "index.ts"), factory);
		callback(runIsolated(process.execPath, [fileURLToPath(new URL("./check-loader.mjs", import.meta.url)), "--child", root], { encoding: "utf8" }));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("real target loader supplies both TypeBox names to a package with no dependencies", () => {
	fixture(`import { Type } from 'typebox';
		import { Type as Legacy } from '@sinclair/typebox';
		export default function(pi) {
			if (Type !== Legacy) throw new Error('duplicate schema modules');
			pi.registerTool({ name: 'fixture', label: 'fixture', description: 'fixture', parameters: Type.Object({}), execute: async () => ({content: [], details: undefined}) });
		}`, (result) => {
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).entries[0].tools, ["fixture"]);
	});
});

test("a factory error cannot pass the registration smoke", () => {
	fixture(`export default function() { throw new Error('fixture-load-failure'); }`, (result) => {
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /fixture-load-failure/);
	});
});
