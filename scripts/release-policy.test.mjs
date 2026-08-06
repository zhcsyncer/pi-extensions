import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHILD_PACKAGES, validateReleasePolicy } from "./release-policy.mjs";

const ROOT = "@zhcsyncer/pi-extensions";
const RECAP = "@zhcsyncer/pi-recap";
const INTENT = "@zhcsyncer/pi-tool-display-intent";
const TODO = "@zhcsyncer/pi-todo";
const GLANCE = "@zhcsyncer/pi-glance";
const PLAN_MODE = "@zhcsyncer/pi-plan-mode";
const CONTEXT7 = "@zhcsyncer/pi-context7";
const ASK_USER_QUESTION = "@zhcsyncer/pi-ask-user-question";
const AGENT_PLAN = "pi-provider-volcengine-agent-plan";

function releases(...entries) {
	return {
		releases: entries.map(([name, type]) => ({ name, type })),
	};
}

test("release reconciliation covers every bundled child package", () => {
	const script = readFileSync(new URL("./reconcile-release.sh", import.meta.url), "utf8");
	for (const childPackage of CHILD_PACKAGES) {
		assert.match(script, new RegExp(childPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("allows an empty release plan", () => {
	assert.deepEqual(validateReleasePolicy(releases()), []);
});

test("allows the root package to release independently", () => {
	assert.deepEqual(validateReleasePolicy(releases([ROOT, "patch"])), []);
});

test("allows the standalone Agent Plan provider to release without the root", () => {
	assert.deepEqual(validateReleasePolicy(releases([AGENT_PLAN, "patch"])), []);
});

test("requires the root package when recap releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([RECAP, "patch"])), [
		`${RECAP} has a patch release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when intent releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([INTENT, "minor"])), [
		`${INTENT} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when todo releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([TODO, "minor"])), [
		`${TODO} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when Glance releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([GLANCE, "minor"])), [
		`${GLANCE} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when Plan Mode releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([PLAN_MODE, "minor"])), [
		`${PLAN_MODE} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when Context7 releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([CONTEXT7, "minor"])), [
		`${CONTEXT7} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("requires the root package when Ask User Question releases", () => {
	assert.deepEqual(validateReleasePolicy(releases([ASK_USER_QUESTION, "minor"])), [
		`${ASK_USER_QUESTION} has a minor release, but ${ROOT} is missing from the release plan.`,
	]);
});

test("allows unchanged sibling packages to remain unreleased", () => {
	assert.deepEqual(
		validateReleasePolicy(releases([ROOT, "minor"], [INTENT, "minor"])),
		[],
	);
});

test("allows a root bump higher than a child bump", () => {
	assert.deepEqual(
		validateReleasePolicy(releases([ROOT, "minor"], [RECAP, "patch"])),
		[],
	);
});

test("rejects a root bump lower than a child bump", () => {
	assert.deepEqual(
		validateReleasePolicy(releases([ROOT, "patch"], [INTENT, "minor"])),
		[
			`${ROOT} has a patch release, which is lower than ${INTENT}'s minor release.`,
		],
	);
});

test("compares the root against every changed child", () => {
	assert.deepEqual(
		validateReleasePolicy(
			releases([ROOT, "minor"], [RECAP, "patch"], [INTENT, "major"], [TODO, "minor"], [PLAN_MODE, "patch"]),
		),
		[
			`${ROOT} has a minor release, which is lower than ${INTENT}'s major release.`,
		],
	);
});
