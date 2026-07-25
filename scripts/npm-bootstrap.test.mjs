import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	assertVersionPrApplied,
	discoverWorkspacePackages,
	findUnbootstrappedPackages,
	packageExistsOnRegistry,
	registryPackageUrl,
	selectBootstrapPackage,
} from "./npm-bootstrap-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function writeManifest(directory, manifest) {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
}

test("discovers root, package, and provider manifests while retaining private state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bootstrap-discovery-"));
	try {
		await writeManifest(root, { name: "root-package", version: "1.0.0" });
		await writeManifest(join(root, "packages", "public"), { name: "public-package", version: "0.1.0" });
		await writeManifest(join(root, "packages", "private"), { name: "private-package", version: "0.1.0", private: true });
		await writeManifest(join(root, "providers", "provider"), { name: "provider-package", version: "0.2.0" });
		await mkdir(join(root, "packages", "without-manifest"), { recursive: true });

		const packages = await discoverWorkspacePackages(root);
		assert.deepEqual(packages.map((pkg) => [pkg.name, pkg.private]), [
			["private-package", true],
			["provider-package", false],
			["public-package", false],
			["root-package", false],
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selects only an exact public workspace package", () => {
	const packages = [
		{ name: "public-package", private: false },
		{ name: "private-package", private: true },
	];
	assert.equal(selectBootstrapPackage(packages, "public-package").name, "public-package");
	assert.throws(() => selectBootstrapPackage(packages, " public-package"), /exact workspace package name/);
	assert.throws(() => selectBootstrapPackage(packages, "missing"), /Unknown workspace package/);
	assert.throws(() => selectBootstrapPackage(packages, "private-package"), /private/);
});

test("encodes scoped package names for registry lookup", () => {
	assert.equal(
		registryPackageUrl("@scope/package", "https://registry.example.test"),
		"https://registry.example.test/%40scope%2Fpackage",
	);
});

test("distinguishes existing, missing, and failed registry lookups", async () => {
	assert.equal(await packageExistsOnRegistry("exists", {
		fetchImpl: async () => ({ status: 200 }),
	}), true);
	assert.equal(await packageExistsOnRegistry("missing", {
		fetchImpl: async () => ({ status: 404 }),
	}), false);
	await assert.rejects(
		packageExistsOnRegistry("broken", {
			fetchImpl: async () => ({ status: 503, text: async () => "unavailable" }),
		}),
		/HTTP 503 unavailable/,
	);
});

test("preflight reports only missing public packages", async () => {
	const packages = [
		{ name: "existing", private: false },
		{ name: "missing", private: false },
		{ name: "private", private: true },
	];
	const missing = await findUnbootstrappedPackages(packages, {
		fetchImpl: async (url) => ({ status: url.endsWith("missing") ? 404 : 200 }),
		registry: "https://registry.example.test",
	});
	assert.deepEqual(missing.map((pkg) => pkg.name), ["missing"]);
});

test("isolates token auth to the protected manual bootstrap workflow", async () => {
	const releaseWorkflow = await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
	const bootstrapWorkflow = await readFile(
		join(repositoryRoot, ".github", "workflows", "bootstrap-npm-package.yml"),
		"utf8",
	);
	const publishScript = await readFile(join(repositoryRoot, "scripts", "publish-packages.sh"), "utf8");

	assert.doesNotMatch(releaseWorkflow, /NPM_(?:BOOTSTRAP_)?TOKEN|NODE_AUTH_TOKEN/);
	assert.match(bootstrapWorkflow, /environment: npm-bootstrap/);
	assert.match(bootstrapWorkflow, /secrets\.NPM_BOOTSTRAP_TOKEN/);
	assert.match(publishScript, /check-unbootstrapped-packages\.mjs/);
	assert.doesNotMatch(publishScript, /NPM_BOOTSTRAP_TOKEN|ACTIONS_ID_TOKEN_REQUEST/);
});

test("requires a Changesets-produced version and matching changelog entry", () => {
	assert.throws(
		() => assertVersionPrApplied({ name: "new-package", version: "0.0.0" }, "## 0.0.0\n"),
		/Merge its Changesets version PR/,
	);
	assert.throws(
		() => assertVersionPrApplied({ name: "new-package", version: "0.1.0" }, "## 0.0.0\n"),
		/missing a matching CHANGELOG/,
	);
	assert.doesNotThrow(() => assertVersionPrApplied(
		{ name: "new-package", version: "0.1.0" },
		"# Changelog\n\n## 0.1.0\n\n- Initial release\n",
	));
});
