import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { renderGlanceLine } from "../status-line.js";
import { testState } from "./helpers.js";
import type { GlanceConfig, GlanceState } from "../types.js";

type SegmentConfigLike = { id: string; enabled: boolean };
type ThroughputPrecision = "auto" | 0 | 1;

type ThroughputTurnFixture = {
	startedAtMs: number;
	endedAtMs: number;
	elapsedMs: number;
	tokensPerSecond: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		assistantMessages: number;
	};
};

function setSegments(config: GlanceConfig, segments: SegmentConfigLike[]): GlanceConfig {
	(config as unknown as { segments: SegmentConfigLike[] }).segments = segments;
	return config;
}

function setPrecision(config: GlanceConfig, precision: ThroughputPrecision): GlanceConfig {
	(config as unknown as { throughput: { precision: ThroughputPrecision } }).throughput = { precision };
	return config;
}

function withThroughput(state: GlanceState, lastTurn: ThroughputTurnFixture | null, currentRun: ThroughputTurnFixture | null = null): GlanceState {
	(state as unknown as { throughput: { lastTurn: ThroughputTurnFixture | null; currentRun: ThroughputTurnFixture | null } }).throughput = { lastTurn, currentRun };
	return state;
}

function plain(state: GlanceState, config: GlanceConfig, width: number): string {
	return stripControls(renderGlanceLine(state, config, width));
}

function plainPreservingSpaces(state: GlanceState, config: GlanceConfig, width: number): string {
	return renderGlanceLine(state, config, width)
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.trim();
}

const sample: ThroughputTurnFixture = {
	startedAtMs: 1_000,
	endedAtMs: 3_500,
	elapsedMs: 2_500,
	tokensPerSecond: 20,
	usage: {
		input: 10,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 60,
		assistantMessages: 1,
	},
};

function turn(rate: number): ThroughputTurnFixture {
	return {
		...sample,
		endedAtMs: sample.startedAtMs + 1_000,
		elapsedMs: 1_000,
		tokensPerSecond: rate,
		usage: { ...sample.usage, output: rate, totalTokens: rate },
	};
}

{
	const config = defaultConfig();
	const state = withThroughput(testState(), sample);
	assert.equal(
		plain(state, config, 120),
		"$ $0.000 · spd 20 tok/s · ctx 23% 47k/200k · ai GPT 5.5",
		"default status line should show finalized Reply speed between Cost and Context while keeping Model last",
	);
	assert.deepEqual(
		(config.segments as unknown as SegmentConfigLike[]),
		[
			{ id: "git", enabled: true },
			{ id: "cost", enabled: true },
			{ id: "throughput", enabled: true },
			{ id: "context", enabled: true },
			{ id: "tokens", enabled: false },
			{ id: "model", enabled: true },
		],
		"default segments should use the curated order Git, Cost, Reply speed, Context, Tokens, Model",
	);
}

{
	const config = defaultConfig();
	assert.equal(
		plain(withThroughput(testState(), null), config, 120),
		"$ $0.000 · spd ? tok/s · ctx 23% 47k/200k · ai GPT 5.5",
		"enabled Reply speed should show an unknown placeholder until a trusted measurement exists",
	);
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: false }]);
	assert.equal(plain(withThroughput(testState(), null), config, 120), "", "explicitly disabled throughput segment should render nothing, including no placeholder");
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: true }]);
	assert.equal(plain(withThroughput(testState(), null), config, 120), "spd ? tok/s", "enabled throughput full status should render unknown ? placeholder when both slots are null");
	assert.equal(plain(withThroughput(testState(), null), config, 80), "spd ?/s", "enabled throughput compact status should render compact ?/s placeholder");
	assert.equal(plain(withThroughput(testState(), null), config, 48), "spd ?/s", "enabled throughput minimal status should render compact ?/s placeholder");

	const nerdConfig = setSegments({ ...defaultConfig(), icons: "nerd" }, [{ id: "throughput", enabled: true }]);
	assert.equal(plainPreservingSpaces(withThroughput(testState(), null), nerdConfig, 120), "  ? tok/s", "nerd Reply speed icon should keep extra visual spacing before the placeholder");
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: true }]);
	const state = withThroughput(testState(), sample);
	assert.equal(plain(state, config, 120), "spd 20 tok/s", "enabled throughput full status should render final plain icon plus tok/s copy");
	assert.equal(plain(state, config, 80), "spd 20/s", "enabled throughput compact status should render final compact /s copy");
	assert.equal(plain(state, config, 48), "spd 20/s", "enabled throughput minimal status should render final compact /s copy");
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: true }]);
	const current = turn(42);
	const state = withThroughput(testState(), sample, current);
	assert.equal(plain(state, config, 120), "spd ~42 tok/s", "currentRun should win over lastTurn and render with a provisional ~ marker in full width");
	assert.equal(plain(state, config, 80), "spd ~42/s", "currentRun should render with a provisional ~ marker in compact width");
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: true }]);
	const invalidCurrent = turn(0);
	const invalidFinal = turn(Number.NaN);
	assert.equal(plain(withThroughput(testState(), sample, invalidCurrent), config, 120), "spd 20 tok/s", "invalid currentRun should fall back to a valid final lastTurn");
	assert.equal(plain(withThroughput(testState(), invalidFinal, invalidCurrent), config, 120), "spd ? tok/s", "invalid currentRun and invalid lastTurn should fall back to the unknown placeholder");
}

{
	const config = setSegments(defaultConfig(), [{ id: "throughput", enabled: true }]);
	assert.equal(plain(withThroughput(testState(), turn(7.04)), setPrecision(config, "auto"), 120), "spd 7.0 tok/s", "precision auto should keep one decimal below 10 tok/s");
	assert.equal(plain(withThroughput(testState(), turn(42.4)), setPrecision(defaultConfig(), "auto"), 120), "$ $0.000 · spd 42 tok/s · ctx 23% 47k/200k · ai GPT 5.5", "precision auto should round integer-rate values at normal widths");
}

{
	const config = setSegments(setPrecision(defaultConfig(), 1), [{ id: "throughput", enabled: true }]);
	assert.equal(plain(withThroughput(testState(), turn(7)), config, 120), "spd 7.0 tok/s", "precision=1 should force one decimal for low rates");
	assert.equal(plain(withThroughput(testState(), turn(42)), config, 120), "spd 42.0 tok/s", "precision=1 should force one decimal for normal rates");
	assert.equal(plain(withThroughput(testState(), turn(1_234)), config, 120), "spd 1.2k tok/s", "precision=1 should apply to compact k mantissas for large rates");
	assert.equal(plain(withThroughput(testState(), turn(1_234_567)), config, 120), "spd 1.2M tok/s", "precision=1 should apply to compact M mantissas for very large rates");
}

{
	const config = setSegments(setPrecision(defaultConfig(), 0), [{ id: "throughput", enabled: true }]);
	assert.equal(plain(withThroughput(testState(), turn(7.4)), config, 120), "spd 7 tok/s", "precision=0 should round to integer for low rates");
	assert.equal(plain(withThroughput(testState(), turn(42.4)), config, 120), "spd 42 tok/s", "precision=0 should round to integer for normal rates");
	assert.equal(plain(withThroughput(testState(), turn(1_234)), config, 120), "spd 1k tok/s", "precision=0 should apply to compact k mantissas for large rates");
}

{
	const config = defaultConfig();
	const richState = withThroughput(
		testState({
			git: { ...testState().git, repo: true, branch: "main", status: "dirty", dirty: true, unstaged: 1 },
			model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "high" },
			context: { tokens: 46_800, window: 200_000, percent: 23.4 },
			usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0.042 },
		}),
		sample,
	);
	const roomy = plain(richState, config, 160);
	assert.ok(roomy.includes("git main *"), "roomy default-order status should include Git when available");
	assert.ok(roomy.includes("spd 20 tok/s"), "roomy default-order status should include Reply speed by default");
	assert.ok(roomy.includes("ai GPT 5.5 high"), "roomy default-order status should include Model");
	assert.ok(roomy.indexOf("$ $0.042") < roomy.indexOf("spd 20 tok/s"), "Cost should render before Reply speed by default");
	assert.ok(roomy.indexOf("spd 20 tok/s") < roomy.indexOf("ctx 23% 47k/200k"), "Reply speed should render before Context by default");
	assert.ok(roomy.indexOf("ctx 23% 47k/200k") < roomy.indexOf("ai GPT 5.5 high"), "Context should render before final Model by default");

	const withTokens = defaultConfig();
	withTokens.segments = withTokens.segments.map((segment) => segment.id === "tokens" ? { ...segment, enabled: true } : segment);
	const tokenLine = plain(richState, withTokens, 180);
	assert.ok(tokenLine.indexOf("ctx 23% 47k/200k") < tokenLine.indexOf("tok ↑12k ↓3.1k R800 W20"), "enabled Tokens should render after Context by default");
	assert.ok(tokenLine.indexOf("tok ↑12k ↓3.1k R800 W20") < tokenLine.indexOf("ai GPT 5.5 high"), "Model should stay last when Tokens are enabled");

	const narrow = plain(richState, config, 48);
	assert.ok(visibleWidth(narrow) <= 48, "fitted status line should stay within width budget");
}

console.log("✓ throughput status-line checks passed");
