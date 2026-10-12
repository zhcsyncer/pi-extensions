import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runIsolated } from "./run-isolated.mjs";

function fixture(factory, callback, { manifest = {}, prepare = () => {}, entry = "index.ts" } = {}) {
	const root = mkdtempSync("/var/tmp/pi-loader-contract-");
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loader-contract", pi: { extensions: [`./${entry}`] }, ...manifest }));
		writeFileSync(join(root, entry), factory);
		prepare(root);
		callback(runIsolated(process.execPath, [fileURLToPath(new URL("./check-loader.mjs", import.meta.url)), "--child", root], { encoding: "utf8" }), root);
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

test("a direct host dependency is rejected with the real target loader warning", () => {
	fixture(`export default function(pi) { pi.registerCommand('fixture', {handler: async () => {}}); }`, (result) => {
		assert.notEqual(result.status, 0);
		const report = JSON.parse(result.stdout);
		assert.deepEqual(report.errors, []);
		assert.equal(report.directManifestViolations[0].name, "typebox");
		assert.match(report.hostWarnings[0].warning, /typebox/);
		assert.deepEqual(report.privateNativeLoads, []);
	}, { manifest: { dependencies: { typebox: "1.3.27" } } });
});

test("a native private runtime load fails even without a direct manifest warning", () => {
	fixture(`import { Type } from 'typebox';
		export default function(pi) { pi.registerTool({ name: 'native', label: 'native', description: 'native', parameters: Type.Object({}), execute: async () => ({content: [], details: undefined}) }); }`, (result, root) => {
		assert.notEqual(result.status, 0, result.stdout);
		const report = JSON.parse(result.stdout);
		assert.deepEqual(report.errors, []);
		assert.deepEqual(report.directManifestViolations, []);
		assert.deepEqual(report.hostWarnings, []);
		assert.equal(report.privateNativeLoads[0].name, "typebox");
		assert.equal(report.privateNativeLoads[0].root, join(root, "node_modules/typebox"));
		assert.match(result.stderr, /native private host module bypass/);
	}, { entry: "index.mjs", prepare(root) {
		mkdirSync(join(root, "node_modules"));
		cpSync(realpathSync(dirname(findPackageJSON("typebox", import.meta.url))), join(root, "node_modules/typebox"), { recursive: true, dereference: true });
		assert.equal(realpathSync(join(root, "node_modules/typebox")), join(root, "node_modules/typebox"));
	} });
});
