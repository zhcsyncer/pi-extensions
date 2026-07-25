import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const WORKSPACE_PARENT_DIRECTORIES = ["packages", "providers"];

async function readManifest(directory) {
	const manifestPath = join(directory, "package.json");
	try {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (!manifest.name || !manifest.version) return undefined;
		return {
			name: manifest.name,
			version: manifest.version,
			private: manifest.private === true,
			publishConfig: manifest.publishConfig,
			directory,
			manifestPath,
		};
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw new Error(`Failed to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function discoverWorkspacePackages(repositoryRoot) {
	const root = resolve(repositoryRoot);
	const directories = [root];
	for (const parentName of WORKSPACE_PARENT_DIRECTORIES) {
		const parent = join(root, parentName);
		let entries;
		try {
			entries = await readdir(parent, { withFileTypes: true });
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) directories.push(join(parent, entry.name));
		}
	}

	const packages = (await Promise.all(directories.map(readManifest))).filter(Boolean);
	return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function selectBootstrapPackage(packages, requestedName) {
	if (!requestedName?.trim() || requestedName !== requestedName.trim()) {
		throw new Error("Provide one exact workspace package name.");
	}
	const selected = packages.find((pkg) => pkg.name === requestedName);
	if (!selected) throw new Error(`Unknown workspace package: ${requestedName}`);
	if (selected.private) throw new Error(`${requestedName} is private and cannot be published.`);
	return selected;
}

export function registryPackageUrl(packageName, registry = process.env.npm_config_registry || "https://registry.npmjs.org") {
	const base = registry.endsWith("/") ? registry : `${registry}/`;
	return new URL(encodeURIComponent(packageName), base).toString();
}

export async function packageExistsOnRegistry(packageName, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
	const response = await fetchImpl(registryPackageUrl(packageName, options.registry), {
		headers: { Accept: "application/json", "User-Agent": "pi-extensions-release-check" },
	});
	if (response.status === 200) return true;
	if (response.status === 404) return false;
	const body = await response.text().catch(() => "");
	throw new Error(
		`npm registry lookup failed for ${packageName}: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
	);
}

export async function findUnbootstrappedPackages(packages, options = {}) {
	const publicPackages = packages.filter((pkg) => !pkg.private);
	const states = await Promise.all(publicPackages.map(async (pkg) => ({
		pkg,
		exists: await packageExistsOnRegistry(pkg.name, options),
	})));
	return states.filter((state) => !state.exists).map((state) => state.pkg);
}

export function assertVersionPrApplied(pkg, changelogContent) {
	if (pkg.version === "0.0.0") {
		throw new Error(`${pkg.name} is still at 0.0.0. Merge its Changesets version PR before bootstrap publishing.`);
	}
	const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## ${escapedVersion}(?:\\s|$)`, "m");
	if (!heading.test(changelogContent)) {
		throw new Error(
			`${pkg.name}@${pkg.version} is missing a matching CHANGELOG.md entry. Merge its Changesets version PR first.`,
		);
	}
}
