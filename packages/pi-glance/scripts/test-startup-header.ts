import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PALETTES, fg } from "../palette.js";
import {
	GlanceStartupHeader,
	PINNED_STARTUP_COMMAND,
	STARTUP_PROMPT,
	STARTUP_TAGLINE,
	selectStartupCommandTips,
	summarizeStartupResources,
	type StartupHeaderCommand,
	type StartupHeaderInfo,
} from "../startup-header.js";
import { resolveBuiltInGlanceStyles, resolvePiThemeStyles, type ResolvedGlanceStyles } from "../theme-adapter.js";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function command(name: string, source: StartupHeaderCommand["source"], path: string): StartupHeaderCommand {
	return { name, source, sourceInfo: { path } };
}

const theme = {
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Pick<Theme, "bold">;

assert.deepEqual(
	selectStartupCommandTips(["review", "/commit", "plan", "test"], () => 0),
	[PINNED_STARTUP_COMMAND, "/review", "/commit", "/plan"],
	"zero random values should select stable real commands after the pinned /glance command",
);
assert.deepEqual(
	selectStartupCommandTips(["glance", "review", "review", "commit"], () => Number.NaN),
	[PINNED_STARTUP_COMMAND, "/review", "/commit"],
	"command Tips should normalize slashes, de-duplicate commands, and tolerate non-finite random values",
);
assert.deepEqual(selectStartupCommandTips([], () => 0), [PINNED_STARTUP_COMMAND], "Header should retain /glance when Pi exposes no other commands");

const commands: StartupHeaderCommand[] = [
	command("glance", "extension", "/extensions/pi-glance.ts"),
	command("todo", "extension", "/extensions/pi-todo.ts"),
	command("todo:next", "extension", "/extensions/pi-todo.ts"),
	command("review", "skill", "/skills/review/SKILL.md"),
	command("test", "skill", "/skills/test/SKILL.md"),
	command("commit", "prompt", "/prompts/commit.md"),
];
const resources = summarizeStartupResources(3, commands);
assert.deepEqual(
	resources,
	{ context: 3, skills: 2, prompts: 1, extensions: 2, extensionsAreLowerBound: true },
	"resource summary should count canonical source paths and mark command-visible Extensions as a lower bound",
);
assert.equal(summarizeStartupResources(Number.NaN, []).context, 0, "invalid Context counts should safely normalize to zero");

const commandTips = ["/glance", "/review", "/commit", "/todo"];
let styles: ResolvedGlanceStyles = resolveBuiltInGlanceStyles("dark");
let info: StartupHeaderInfo = {
	version: "0.82.1",
	resources,
};
const header = new GlanceStartupHeader(theme, {
	commandTips,
	getStyles: () => styles,
	getInfo: () => info,
});

for (const width of [1, 8, 11, 12, 15, 16, 23, 24, 35, 48, 49, 72, 100, 140]) {
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
		assert.ok(plain.includes("Resources"), `boxed startup header should include its compact resource section at width ${width}`);
	}
}

const wideRaw = header.render(100).join("\n");
const widePlain = stripAnsi(wideRaw);
assert.ok(widePlain.includes(STARTUP_TAGLINE), "wide Header should keep the Claude-style left-column tagline");
assert.ok(widePlain.includes("Getting started"), "wide Header should show the Getting started section");
assert.ok(widePlain.includes(STARTUP_PROMPT), "wide Header should show the stable getting-started prompt");
assert.ok(widePlain.includes("Commands"), "wide Header should show the Commands section");
for (const commandTip of commandTips) assert.ok(widePlain.includes(commandTip), `wide Header should show the selected real command Tip ${commandTip}`);
assert.ok(widePlain.includes("Context 3 · Skills 2 · Prompts 1 · Extensions 2+"), "wide Header should show the B1 compact resource summary");
assert.equal(widePlain.includes("test-provider/test-model"), false, "Header should not repeat the Editor model");
assert.equal(widePlain.includes("high effort"), false, "Header should not repeat the Editor thinking level");
assert.equal(widePlain.includes("/root/develop"), false, "Header should not repeat the Editor workspace path");
assert.ok(widePlain.split("\n").some((line) => line.includes("│") && line.indexOf("│") !== line.lastIndexOf("│")), "wide Header should render the internal two-column divider");

const singlePlain = stripAnsi(header.render(48).join("\n"));
assert.ok(singlePlain.includes("Getting started"), "single-column Header should retain the getting-started section");
assert.ok(singlePlain.includes(STARTUP_PROMPT), "single-column Header should retain the getting-started prompt");
assert.ok(singlePlain.includes("Commands"), "single-column Header should retain the Commands section");
for (const commandTip of commandTips) assert.ok(singlePlain.includes(commandTip), `single-column Header should retain ${commandTip}`);
assert.ok(singlePlain.includes("C3 · S2 · P1 · E2+"), "single-column Header should compact all four resource counts without dropping a category");
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
for (const commandTip of commandTips) assert.ok(stripAnsi(lightRaw).includes(commandTip), "palette changes should not reshuffle session command Tips");

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

info = {
	version: "0.82.2",
	resources: { context: 4, skills: 3, prompts: 2, extensions: 1, extensionsAreLowerBound: true },
};
const updatedPlain = stripAnsi(header.render(100).join("\n"));
assert.ok(updatedPlain.includes("Pi v0.82.2"), "Header should re-read Pi version info on later renders");
assert.ok(updatedPlain.includes("Context 4 · Skills 3 · Prompts 2 · Extensions 1+"), "Header should re-read resource summary info on later renders");
for (const commandTip of commandTips) assert.ok(updatedPlain.includes(commandTip), "resource updates should preserve session command Tips");

const source = await readFile("startup-header.ts", "utf8");
for (const forbidden of ["setTimeout(", "setInterval(", "NodeJS.Timeout", "unref(", "getExtensions(", "getSkills(", "getPrompts(", "loadProjectContextFiles("]) {
	assert.equal(source.includes(forbidden), false, `startup Header should stay static and consume only its injected resource snapshot: ${forbidden}`);
}
for (const duplicateField of ["model?:", "thinking?:", "cwd?:", "process.env.HOME"]) {
	assert.equal(source.includes(duplicateField), false, `startup Header should not duplicate Editor session facts: ${duplicateField}`);
}

console.log("✓ startup header checks passed");
