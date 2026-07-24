const RELEASE_LEVELS = Object.freeze({
	patch: 0,
	minor: 1,
	major: 2,
});

export const ROOT_PACKAGE = "@zhcsyncer/pi-extensions";
export const CHILD_PACKAGES = Object.freeze([
	"@zhcsyncer/pi-recap",
	"@zhcsyncer/pi-tool-display-intent",
	"@zhcsyncer/pi-todo",
	"@zhcsyncer/pi-glance",
]);

/**
 * Validate the directional release relationship for the aggregate package.
 * Child packages remain independent, but every child release must also release
 * the root package because its npm tarball embeds all child package sources.
 *
 * @param {{ releases?: Array<{ name: string, type: string }> } | Array<{ name: string, type: string }>} status
 * @returns {string[]}
 */
export function validateReleasePolicy(status) {
	const releases = Array.isArray(status) ? status : (status.releases ?? []);
	const releaseByName = new Map(releases.map((release) => [release.name, release]));
	const rootRelease = releaseByName.get(ROOT_PACKAGE);
	const violations = [];

	for (const childPackage of CHILD_PACKAGES) {
		const childRelease = releaseByName.get(childPackage);
		if (!childRelease) continue;

		if (!rootRelease) {
			violations.push(
				`${childPackage} has a ${childRelease.type} release, but ${ROOT_PACKAGE} is missing from the release plan.`,
			);
			continue;
		}

		const childLevel = RELEASE_LEVELS[childRelease.type];
		const rootLevel = RELEASE_LEVELS[rootRelease.type];
		if (childLevel === undefined || rootLevel === undefined) {
			violations.push(
				`Unknown release type while comparing ${childPackage} (${childRelease.type}) with ${ROOT_PACKAGE} (${rootRelease.type}).`,
			);
			continue;
		}

		if (rootLevel < childLevel) {
			violations.push(
				`${ROOT_PACKAGE} has a ${rootRelease.type} release, which is lower than ${childPackage}'s ${childRelease.type} release.`,
			);
		}
	}

	return violations;
}
