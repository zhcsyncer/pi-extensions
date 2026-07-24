import { strict as assert } from "node:assert";
import { defaultConfig } from "../config.js";
import { getSettingsCategories, getSettingsRows } from "../settings-catalog.js";
import type { GlanceConfig } from "../types.js";

type SegmentConfigLike = { id: string; enabled: boolean };
type ThroughputPrecision = "auto" | 0 | 1;

function clone(config: GlanceConfig): GlanceConfig {
	return JSON.parse(JSON.stringify(config)) as GlanceConfig;
}

function rowSummary(row: { id: string; label: string; value: string; hint: string; kind: string }): Record<string, string> {
	return {
		id: row.id,
		label: row.label,
		value: row.value,
		hint: row.hint,
		kind: row.kind,
	};
}

function setPrecision(config: GlanceConfig, precision: ThroughputPrecision): GlanceConfig {
	(config as unknown as { throughput: { precision: ThroughputPrecision } }).throughput = { precision };
	return config;
}

function precisionOf(config: GlanceConfig): ThroughputPrecision | undefined {
	return (config as unknown as { throughput?: { precision?: ThroughputPrecision } }).throughput?.precision;
}

const config = defaultConfig();
const categories = getSettingsCategories(config).map(({ id, label, enabled }) => ({ id, label, enabled }));
assert.deepEqual(
	categories,
	[
		{ id: "general", label: "General", enabled: undefined },
		{ id: "git", label: "Git", enabled: true },
		{ id: "cost", label: "Cost", enabled: true },
		{ id: "throughput", label: "Reply speed", enabled: true },
		{ id: "context", label: "Context", enabled: true },
		{ id: "tokens", label: "Tokens", enabled: false },
		{ id: "model", label: "Model", enabled: true },
		{ id: "details", label: "Bottom details", enabled: undefined },
	],
	"settings categories should expose Reply speed between Cost and Context while keeping Bottom details after segments",
);

const rows = getSettingsRows(config, "throughput" as never);
assert.deepEqual(
	rows.map(rowSummary),
	[
		{
			id: "throughput.enabled",
			label: "Enabled",
			value: "on",
			hint: "Show or hide this segment.",
			kind: "toggle",
		},
		{
			id: "throughput.precision",
			label: "Precision",
			value: "auto",
			hint: "Decimals for tok/s; wall time, not a benchmark.",
			kind: "cycle",
		},
	],
	"Reply speed settings should be exactly Enabled + Precision",
);

assert.equal(rows.some((row) => /notify/i.test(`${row.id} ${row.label} ${row.hint}`)), false, "Reply speed settings should not expose a notify row");
assert.equal(rows.some((row) => /Metric|Window|Includes/.test(row.label)), false, "Reply speed settings should remove old Metric/Window/Includes info rows");
assert.equal(rows[0]?.apply !== undefined, true, "Reply speed Enabled row should be editable");
assert.equal(rows[1]?.apply !== undefined, true, "Reply speed Precision row should be editable");

const before = clone(config);
const afterToggle = rows[0]!.apply!(config) as GlanceConfig;
assert.deepEqual(config, before, "Reply speed Enabled row should not mutate the input config");
assert.equal(afterToggle.segments.find((segment) => (segment as SegmentConfigLike).id === "throughput")?.enabled, false, "Reply speed Enabled row should toggle throughput segment off");
assert.equal(getSettingsRows(afterToggle, "throughput" as never)[0]?.value, "off", "Reply speed Enabled row value should reflect disabled state after toggle");

const autoToOne = rows[1]!.apply!(config) as GlanceConfig;
assert.equal(precisionOf(autoToOne), 1, "Reply speed Precision should cycle auto -> 1 digit");
assert.equal(getSettingsRows(autoToOne, "throughput" as never)[1]?.value, "1 digit", "Precision row should label precision=1 as 1 digit");
const oneConfig = setPrecision(defaultConfig(), 1);
const oneToZero = getSettingsRows(oneConfig, "throughput" as never)[1]!.apply!(oneConfig) as GlanceConfig;
assert.equal(precisionOf(oneToZero), 0, "Reply speed Precision should cycle 1 digit -> 0 digits");
assert.equal(getSettingsRows(oneToZero, "throughput" as never)[1]?.value, "0 digits", "Precision row should label precision=0 as 0 digits");
const zeroConfig = setPrecision(defaultConfig(), 0);
const zeroToAuto = getSettingsRows(zeroConfig, "throughput" as never)[1]!.apply!(zeroConfig) as GlanceConfig;
assert.equal(precisionOf(zeroToAuto), "auto", "Reply speed Precision should cycle 0 digits -> auto");

console.log("✓ throughput settings catalog checks passed");
