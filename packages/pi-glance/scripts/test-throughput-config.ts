import { strict as assert } from "node:assert";
import { cloneConfig, configFromText, configToText, defaultConfig, normalizeConfig } from "../config.js";
import { THROUGHPUT_PRECISION_DESCRIPTOR } from "../config-schema.js";

type SegmentLike = { id: string; enabled: boolean };
type ThroughputPrecision = "auto" | 0 | 1;

function segmentSummary(config: { segments: readonly SegmentLike[] }): SegmentLike[] {
	return config.segments.map((segment) => ({ id: segment.id, enabled: segment.enabled }));
}

function assertSegments(actual: readonly SegmentLike[], expected: readonly SegmentLike[], message: string): void {
	assert.deepEqual(segmentSummary({ segments: actual }), expected, message);
}

function precisionOf(config: unknown): ThroughputPrecision | undefined {
	return (config as { throughput?: { precision?: ThroughputPrecision } }).throughput?.precision;
}

const defaults = defaultConfig();

assert.equal(defaults.version, 10, "configurable context progress should bump CONFIG_VERSION to 10");
assert.equal(normalizeConfig({ version: 0 }).version, 10, "old raw versions should normalize to schema version 10");
assert.equal(normalizeConfig({ version: 999 }).version, 10, "future raw versions should normalize to current schema version 10");
assert.equal(defaults.throughput.precision, THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, "defaultConfig should use descriptor throughput precision default");
assert.deepEqual((defaults as unknown as { throughput?: unknown }).throughput, { precision: THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue }, "defaultConfig should include throughput.precision=auto");

for (const precision of THROUGHPUT_PRECISION_DESCRIPTOR.values) {
	assert.equal(precisionOf(normalizeConfig({ throughput: { precision } })), precision, `${precision} should normalize as a valid throughput precision`);
}
for (const precision of ["1", "0", "manual", 2, -1, Number.NaN, null, undefined, true, false]) {
	assert.equal(precisionOf(normalizeConfig({ throughput: { precision } })), THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, `${JSON.stringify(precision)} should fall back to throughput precision auto`);
}
assert.equal(precisionOf(normalizeConfig({ throughput: null })), THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, "non-object throughput config should fall back to default precision");
assert.equal(precisionOf(normalizeConfig({})), THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue, "missing throughput config should fall back to default precision");

{
	const config = normalizeConfig({ throughput: { precision: 1 } });
	const cloned = cloneConfig(config);
	assert.deepEqual(cloned, config, "cloneConfig should preserve throughput config");
	assert.notEqual((cloned as unknown as { throughput: unknown }).throughput, (config as unknown as { throughput: unknown }).throughput, "cloneConfig should deep-clone throughput config");
	(cloned as unknown as { throughput: { precision: ThroughputPrecision } }).throughput.precision = 0;
	assert.equal(precisionOf(config), 1, "mutating cloned throughput config should not mutate source config");
}

assertSegments(
	defaults.segments,
	[
		{ id: "git", enabled: true },
		{ id: "cost", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "context", enabled: true },
		{ id: "tokens", enabled: false },
		{ id: "model", enabled: true },
	],
	"default segment order should put enabled throughput between Cost and Context while keeping Model last",
);

assertSegments(
	normalizeConfig({
		version: 3,
		segments: [
			{ id: "git", enabled: false },
			{ id: "context", enabled: true },
			{ id: "cost", enabled: false },
			{ id: "tokens", enabled: true },
			{ id: "model", enabled: false },
		],
	}).segments,
	[
		{ id: "git", enabled: false },
		{ id: "cost", enabled: false },
		{ id: "throughput", enabled: true },
		{ id: "context", enabled: true },
		{ id: "tokens", enabled: true },
		{ id: "model", enabled: false },
	],
	"v3 default-order saved configs should migrate to the curated Reply speed order while preserving existing enabled flags",
);

assertSegments(
	normalizeConfig({
		version: 2,
		segments: [
			{ id: "git", enabled: false },
			{ id: "tokens", enabled: true },
		],
	}).segments,
	[
		{ id: "git", enabled: false },
		{ id: "tokens", enabled: true },
		{ id: "cost", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "context", enabled: true },
		{ id: "model", enabled: true },
	],
	"old customized config migration with a git anchor should append missing defaults with throughput enabled by default",
);

const v4Config = normalizeConfig({
	version: 4,
	throughput: { precision: 1 },
	segments: [
		{ id: "git", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "model", enabled: false },
	],
});
assertSegments(
	v4Config.segments,
	[
		{ id: "git", enabled: true },
		{ id: "throughput", enabled: true },
		{ id: "model", enabled: false },
		{ id: "cost", enabled: true },
		{ id: "context", enabled: true },
		{ id: "tokens", enabled: false },
	],
	"schema v4 configs should preserve an explicitly enabled throughput segment and append other missing defaults after user order",
);
assert.equal(precisionOf(v4Config), 1, "schema v4 configs should migrate to current schema while preserving valid throughput precision if present");

assertSegments(
	normalizeConfig({
		segments: [
			{ id: "context", enabled: false },
			{ id: "tokens", enabled: true },
		],
	}).segments,
	segmentSummary(defaults),
	"legacy/ambiguous segment lists without git should fall back to curated defaults including enabled throughput",
);

const encoded = configToText(normalizeConfig({ throughput: { precision: 0 } }));
assert.equal(JSON.parse(encoded).version, 10, "configToText should serialize schema version 10");
assert.deepEqual(JSON.parse(encoded).throughput, { precision: 0 }, "configToText should serialize throughput precision");
assert.deepEqual(configFromText(encoded), normalizeConfig({ throughput: { precision: 0 } }), "current schema config text should round-trip through configFromText/configToText");

console.log("✓ throughput config checks passed");
