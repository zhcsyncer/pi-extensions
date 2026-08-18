import assert from "node:assert/strict";
import test from "node:test";

import { isInternalDoc, needsFullCheck } from "./ci-scope.mjs";

test("internal docs do not require the full package check", () => {
	assert.equal(isInternalDoc("AGENTS.md"), true);
	assert.equal(isInternalDoc("BACKLOG.md"), true);
	assert.equal(isInternalDoc("RELEASING.md"), true);
	assert.equal(isInternalDoc(".changeset/README.md"), true);
	assert.equal(isInternalDoc("docs/pi-meter/quota-status.md"), true);
	assert.equal(needsFullCheck(["AGENTS.md", "BACKLOG.md", "docs/README.md"]), false);
});

test("user-facing or executable paths still require the full package check", () => {
	assert.equal(isInternalDoc("README.md"), false);
	assert.equal(isInternalDoc("packages/pi-glance/README.md"), false);
	assert.equal(isInternalDoc(".changeset/cool-stone.md"), false);
	assert.equal(isInternalDoc(".github/workflows/ci.yml"), false);
	assert.equal(isInternalDoc("scripts/ci-scope.mjs"), false);
	assert.equal(needsFullCheck(["AGENTS.md", "packages/pi-glance/README.md"]), true);
	assert.equal(needsFullCheck([]), true);
});
