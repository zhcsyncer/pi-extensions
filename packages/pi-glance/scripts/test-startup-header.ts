import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { GlanceStartupHeader, STARTUP_TIPS, selectStartupTip } from "../startup-header.js";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

const colorCodes: Record<string, number> = {
	accent: 36,
	error: 31,
	success: 32,
	warning: 33,
	muted: 90,
};

let accentCode = colorCodes.accent!;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "accent" ? accentCode : colorCodes[color] ?? 39}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Theme;

assert.equal(selectStartupTip(() => 0), STARTUP_TIPS[0], "zero random value should select the first startup tip");
assert.equal(selectStartupTip(() => 0.999999), STARTUP_TIPS.at(-1), "high random value should select the final startup tip");
assert.equal(selectStartupTip(() => Number.NaN), STARTUP_TIPS[0], "non-finite random values should safely select the first tip");

const chosenTip = STARTUP_TIPS[1]!;
const header = new GlanceStartupHeader(theme, chosenTip);
for (const width of [1, 8, 11, 12, 24, 35, 36, 56, 71, 72, 100, 140]) {
	const lines = header.render(width);
	assert.ok(lines.length > 0, `startup header should render at width ${width}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= Math.max(1, width), `startup header line should fit width ${width}: ${stripAnsi(line)}`);
	}
	const plain = lines.map(stripAnsi).join("\n");
	if (width >= 13) assert.ok(plain.includes("Pi · Glance"), `startup header should keep full brand copy at width ${width}`);
	else assert.ok(plain.length > 0, `extremely narrow startup header should keep a visible fallback at width ${width}`);
	if (width >= 12) assert.ok(plain.includes("Tip"), `startup header should keep a tip label at width ${width}`);
	if (width >= 2 && width < 36) assert.ok(plain.includes("◌"), `narrow startup header should use the compact logo mark at width ${width}`);
	if (width >= 36) assert.ok(plain.includes("██"), `medium and wide startup header should render the block Pi logo at width ${width}`);
}

const wideRaw = header.render(100).join("\n");
for (const code of [colorCodes.error, colorCodes.success, colorCodes.warning]) {
	assert.ok(wideRaw.includes(`\x1b[${code}m██\x1b[0m`), `wide Pi logo should use semantic color code ${code}`);
}
assert.ok(wideRaw.includes(`\x1b[${accentCode}m██\x1b[0m`), "wide Pi logo should use the accent semantic token");
assert.ok(stripAnsi(wideRaw).includes(chosenTip), "wide startup header should show the once-selected tip unchanged");

accentCode = 35;
const rethemedRaw = header.render(100).join("\n");
assert.ok(rethemedRaw.includes("\x1b[35m██\x1b[0m"), "render-time theme access should update the logo after Pi theme changes");
assert.equal(rethemedRaw.includes("\x1b[36m██\x1b[0m"), false, "theme changes should not reuse stale accent bytes");
assert.ok(stripAnsi(rethemedRaw).includes(chosenTip), "theme changes should not reshuffle the session tip");

const source = await readFile("startup-header.ts", "utf8");
for (const forbidden of ["setTimeout(", "setInterval(", "NodeJS.Timeout", "unref("]) {
	assert.equal(source.includes(forbidden), false, `startup header should stay static and timer-free: ${forbidden}`);
}

console.log("✓ startup header checks passed");
