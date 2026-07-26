import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PALETTES, fg } from "../palette.js";
import { GlanceStartupHeader, STARTUP_COMMANDS, STARTUP_TIPS, selectStartupTip, type StartupHeaderInfo } from "../startup-header.js";
import { resolveBuiltInGlanceStyles, resolvePiThemeStyles, type ResolvedGlanceStyles } from "../theme-adapter.js";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

const theme = {
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Pick<Theme, "bold">;

assert.equal(selectStartupTip(() => 0), STARTUP_TIPS[0], "zero random value should select the first startup tip");
assert.equal(selectStartupTip(() => 0.999999), STARTUP_TIPS.at(-1), "high random value should select the final startup tip");
assert.equal(selectStartupTip(() => Number.NaN), STARTUP_TIPS[0], "non-finite random values should safely select the first tip");
assert.deepEqual(STARTUP_COMMANDS, ["/glance", "/model", "/settings", "/hotkeys"], "Header should keep the approved fixed command list");

const chosenTip = STARTUP_TIPS[0]!;
let styles: ResolvedGlanceStyles = resolveBuiltInGlanceStyles("dark");
let info: StartupHeaderInfo = {
	version: "0.82.1",
	model: "openai-codex/gpt-5.6-sol",
	thinking: "high",
	cwd: "/root/develop/ai/pi-agent-cases",
};
const header = new GlanceStartupHeader(theme, {
	tip: chosenTip,
	getStyles: () => styles,
	getInfo: () => info,
});

for (const width of [1, 8, 11, 12, 23, 24, 35, 48, 49, 72, 100, 140]) {
	const lines = header.render(width);
	assert.ok(lines.length > 0, `startup header should render at width ${width}`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= Math.max(1, width), `startup header line should fit width ${width}: ${stripAnsi(line)}`);
	}
	const plain = lines.map(stripAnsi).join("\n");
	if (width >= 13) assert.ok(plain.includes("Pi · Glance"), `startup header should keep full brand copy at width ${width}`);
	else assert.ok(plain.length > 0, `extremely narrow startup header should keep a visible fallback at width ${width}`);
	if (width < 24 && width >= 2) assert.ok(plain.includes("◌"), `compact startup header should use the compact mark at width ${width}`);
	if (width >= 24) {
		assert.ok(plain.includes("╭") && plain.includes("╯"), `boxed startup header should keep rounded frame at width ${width}`);
		assert.ok(plain.includes("Pi v0.82.1"), `boxed startup header should show Pi version at width ${width}`);
		assert.ok(plain.includes("██"), `boxed startup header should render the static block Pi logo at width ${width}`);
	}
}

const wideRaw = header.render(100).join("\n");
const widePlain = stripAnsi(wideRaw);
assert.ok(widePlain.includes("Getting started"), "wide Header should show the Getting started section");
assert.ok(widePlain.includes(chosenTip), "wide Header should show the once-selected Tip unchanged");
assert.ok(widePlain.includes("Commands"), "wide Header should show the Commands section");
for (const command of STARTUP_COMMANDS) assert.ok(widePlain.includes(command), `wide Header should show ${command}`);
assert.ok(widePlain.includes("openai-codex/gpt-5.6-sol · high effort"), "wide Header should show current model and thinking effort");
assert.ok(widePlain.includes("~/develop/ai/pi-agent-cases"), "wide Header should shorten cwd under HOME");
assert.ok(widePlain.split("\n").some((line) => line.includes("│") && line.indexOf("│") !== line.lastIndexOf("│")), "wide Header should render the internal two-column divider");

const singlePlain = stripAnsi(header.render(48).join("\n"));
assert.ok(singlePlain.includes("Getting started"), "single-column Header should retain the Tip section");
assert.ok(singlePlain.includes("Commands"), "single-column Header should retain a compact Commands line");
assert.equal(singlePlain.split("\n").some((line) => (line.match(/│/g) ?? []).length >= 3), false, "single-column Header should omit the internal divider");

assert.ok(wideRaw.includes(fg(PALETTES.dark.border, "╭─── ")), "Glance palette Header frame should use the selected palette border");
assert.ok(wideRaw.includes(fg(PALETTES.dark.title, "Pi")), "Glance palette Header title should use the selected palette title color");
assert.ok(wideRaw.includes(fg(PALETTES.dark.error, "██")), "Glance palette Logo should use the selected palette error color");
assert.ok(wideRaw.includes(fg(PALETTES.dark.segments.git.fg, "██")), "Glance palette Logo should use the selected palette success color");
assert.ok(wideRaw.includes(fg(PALETTES.dark.warn, "██")), "Glance palette Logo should use the selected palette warning color");

styles = resolveBuiltInGlanceStyles("light");
const lightRaw = header.render(100).join("\n");
assert.ok(lightRaw.includes(fg(PALETTES.light.border, "╭─── ")), "later palette changes should update Header border bytes");
assert.equal(lightRaw.includes(fg(PALETTES.dark.border, "╭─── ")), false, "later palette changes should not reuse stale Header border bytes");
assert.ok(stripAnsi(lightRaw).includes(chosenTip), "palette changes should not reshuffle the session Tip");

const piCodes: Record<string, number> = {
	accent: 31,
	border: 32,
	success: 33,
	error: 34,
	warning: 35,
	muted: 36,
	dim: 90,
	text: 37,
};
styles = resolvePiThemeStyles({
	name: "header-pi",
	fg: (token, text) => `\x1b[${piCodes[token] ?? 39}m${text}\x1b[0m`,
});
const piRaw = header.render(100).join("\n");
assert.ok(piRaw.includes("\x1b[32m╭─── \x1b[0m"), "Follow Pi Header frame should use the Pi border token");
assert.ok(piRaw.includes("\x1b[31mPi\x1b[0m"), "Follow Pi Header title should use the Pi accent token");
assert.ok(piRaw.includes("\x1b[34m██\x1b[0m"), "Follow Pi Logo should use the Pi error token");
assert.ok(piRaw.includes("\x1b[33m██\x1b[0m"), "Follow Pi Logo should use the Pi success token");
assert.ok(piRaw.includes("\x1b[35m██\x1b[0m"), "Follow Pi Logo should use the Pi warning token");

info = { version: "0.82.2", model: "anthropic/claude", thinking: "low", cwd: "/tmp/next" };
const updatedPlain = stripAnsi(header.render(100).join("\n"));
assert.ok(updatedPlain.includes("Pi v0.82.2"), "Header should re-read Pi version info on later renders");
assert.ok(updatedPlain.includes("anthropic/claude · low effort"), "Header should re-read model and thinking info on later renders");
assert.ok(updatedPlain.includes("/tmp/next"), "Header should re-read cwd info on later renders");
assert.ok(updatedPlain.includes(chosenTip), "runtime info updates should keep the once-selected session Tip");

const source = await readFile("startup-header.ts", "utf8");
for (const forbidden of ["setTimeout(", "setInterval(", "NodeJS.Timeout", "unref(", "getExtensions(", "getSkills(", "getPrompts("]) {
	assert.equal(source.includes(forbidden), false, `startup header should stay static and resource-agnostic: ${forbidden}`);
}
for (const resourceLabel of ["Context", "Skills", "Prompts", "Extensions"]) {
	assert.equal(source.includes(`\"${resourceLabel}\"`), false, `startup Header should not duplicate Pi's native ${resourceLabel} section`);
}

console.log("✓ startup header checks passed");
