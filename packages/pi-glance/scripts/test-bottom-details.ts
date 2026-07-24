import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bottomDetailsBudget, renderBottomDetails } from "../bottom-details.js";
import { defaultConfig } from "../config.js";
import { resolveBuiltInGlanceStyles } from "../theme-adapter.js";
import { planSurfaceBottomFrame, renderSurfaceChunks } from "../surface-layout.js";
import { testState } from "./helpers.js";

function progressConfig() {
	const config = defaultConfig();
	config.context.display = "progress";
	return config;
}

function track(width: number): string {
	return `╶${"─".repeat(Math.max(0, width - 2))}╴`;
}

const state = testState({
	context: { tokens: 46_800, window: 200_000, percent: 23.4 },
	runtime: { autoCompactEnabled: true },
});
const standardDetailsBudget = bottomDetailsBudget(78);

{
	const config = defaultConfig();
	assert.equal(renderBottomDetails(state, config, 200), "auto", "text context modes should leave only auto-compaction at bottom-right");
}

{
	const config = progressConfig();
	assert.equal(standardDetailsBudget, 26, "80-column surfaces should reserve one third of their 78-column inner width for details");
	assert.equal(
		renderBottomDetails(state, config, standardDetailsBudget),
		`${track(15)} 23% · auto`,
		"progress mode should adapt its border-aligned track to the one-third details budget",
	);
}

{
	const config = progressConfig();
	config.icons = "nerd";
	assert.equal(
		renderBottomDetails(state, config, standardDetailsBudget),
		`${track(13)} 23% · 󰁄 auto`,
		"bottom progress should omit the context icon while Nerd Font mode labels auto-compaction",
	);
}

{
	const config = progressConfig();
	config.bottomDetails.showAutoCompact = false;
	assert.equal(
		renderBottomDetails(state, config, standardDetailsBudget),
		`${track(22)} 23%`,
		"context track should expand into the available details budget when auto-compaction is hidden",
	);
	assert.equal(
		renderBottomDetails(testState({ runtime: { autoCompactEnabled: false } }), config, standardDetailsBudget).includes("auto"),
		false,
		"inactive auto-compaction should not render",
	);
}

{
	const config = progressConfig();
	config.segments = config.segments.map((segment) => segment.id === "context" ? { ...segment, enabled: false } : segment);
	assert.equal(renderBottomDetails(state, config, 200), "auto", "disabled context segment should not reappear in bottom details");
}

{
	const config = progressConfig();
	const unknown = testState({ context: { tokens: null, percent: null, window: 200_000 } });
	assert.equal(
		renderBottomDetails(unknown, config, standardDetailsBudget),
		`${track(17)} ? · auto`,
		"show-unknown mode should render a dim border-aligned track",
	);
	config.context.unknown = "hide";
	assert.equal(renderBottomDetails(unknown, config, standardDetailsBudget), "auto", "hide-unknown mode should suppress bottom-right context");
}

{
	const config = progressConfig();
	assert.equal(renderBottomDetails(state, config, 18), `${track(7)} 23% · auto`, "responsive fitting should shrink the border-aligned track before dropping facts");
	assert.equal(renderBottomDetails(state, config, 10), "23% · auto", "very narrow fitting should retain context percent and auto when both fit");
	assert.equal(renderBottomDetails(state, config, 6), "23%", "context should take priority over auto-compaction on the narrowest surfaces");
	for (const width of [1, 4, 6, 10, 18, 40, 80]) {
		assert.ok(visibleWidth(renderBottomDetails(state, config, width)) <= width, `bottom details should fit width ${width}`);
	}
	for (const innerWidth of [54, 78, 118]) {
		const budget = bottomDetailsBudget(innerWidth);
		assert.equal(visibleWidth(renderBottomDetails(state, config, budget)), budget, `context and auto should fill one-third details budget ${budget}`);
	}
}

{
	const config = progressConfig();
	config.icons = "nerd";
	const styles = resolveBuiltInGlanceStyles("dark");
	const highlighted = renderBottomDetails(state, config, standardDetailsBudget, { styles });
	assert.ok(highlighted.includes(styles.success("󰁄 auto")), "Nerd Font auto-compaction marker should use the semantic success highlight");
	assert.ok(highlighted.includes(styles.segments.context.fg("╶──")), "filled context track should use the context highlight");
	assert.ok(highlighted.includes(styles.dim(`${"─".repeat(9)}╴`)), "remaining context track should use the dim style");
	assert.ok(highlighted.includes(styles.text("23%")), "context percentage should use normal text instead of competing with the track highlight");
	assert.equal(highlighted.includes("󰍛"), false, "bottom progress should omit the context icon");
	const dimmed = renderBottomDetails(state, config, standardDetailsBudget, { styles, dimmed: true });
	assert.ok(dimmed.includes(styles.dim("╶──")), "unfocused context track should follow dimmed chrome");
	assert.ok(dimmed.includes(styles.dim("23%")), "unfocused context percentage should follow dimmed chrome");
	assert.ok(dimmed.includes(styles.dim("󰁄 auto")), "unfocused auto-compaction should follow dimmed chrome");
	assert.equal(dimmed.includes(styles.success("󰁄 auto")), false, "unfocused auto-compaction should not keep the active highlight");
}

{
	const plan = planSurfaceBottomFrame({ width: 20, status: "auto" });
	assert.equal(renderSurfaceChunks(plan.chunks, {}), "╰─────────── auto ─╯", "bottom frame should right-align details inside border chrome");
	assert.equal(plan.width, 20, "bottom frame with details should preserve exact surface width");
	assert.equal(plan.status.text, "auto", "bottom frame plan should expose fitted status text");
}

console.log("✓ bottom-right context/auto details checks passed");
