import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { defaultConfig, normalizeConfig } from "../config.js";
import { GLANCE_THEMES } from "../themes.js";

const readme = await readFile("README.md", "utf8");
const readmeZh = await readFile("README.zh-CN.md", "utf8");

function assertReadmeIncludes(fragment: string, message: string): void {
	assert.ok(readme.includes(fragment), message);
}

function assertReadmeExcludes(fragment: string, message: string): void {
	assert.equal(readme.includes(fragment), false, message);
}

assertReadmeIncludes("maintained fork", "README should identify this package as a maintained fork");
assertReadmeIncludes("pi install npm:@zhcsyncer/pi-glance", "README should install the scoped fork package");
assertReadmeIncludes("Pi 0.80 or newer", "README should document the supported Pi baseline");
assertReadmeIncludes("Other extensions' `ctx.ui.setStatus()` values remain visible", "README should document preserved extension statuses");
assertReadmeIncludes("**Bottom details**", "README should document the remaining bottom-details settings category");
assertReadmeIncludes("`progress bar`", "README should document the bottom-right context progress mode");
assertReadmeIncludes("standalone `track` or a progress-aware `border`", "README should document both context progress styles");
assertReadmeIncludes("unused cells stay light `─`, used cells become heavy `━`, and `╼` joins them", "README should document the border progress glyph encoding");
assertReadmeIncludes("The percentage keeps normal text color", "README should document the quieter percentage hierarchy");
assertReadmeIncludes("bottom progress omits the context icon", "README should document the icon-free bottom progress design");
assertReadmeIncludes("Nerd Font text modes still use `󰍛`", "README should document where the Nerd Font context icon remains visible");
assertReadmeIncludes("Nerd Font mode shows the highlighted `󰁄 auto` marker", "README should document the labeled auto-compaction Nerd Font marker");
assertReadmeIncludes("all `remaining` bottom-border space", "README should document the remaining-width mode");
assertReadmeIncludes("below 70%", "README should document the normal context risk range");
assertReadmeIncludes("at 85% or higher", "README should document the context error threshold");
assertReadmeExcludes('"showDefaultStatus"', "README should not document a removed Pi status-row switch");
assertReadmeExcludes('"enabled": true,\n    "showSession"', "README should not document the removed bottom-details master and session switches");
assert.equal("footer" in defaultConfig(), false, "README footer behavior should stay aligned with config removal");
assert.deepEqual(defaultConfig().bottomDetails, { showAutoCompact: true }, "README bottom-details JSON should stay aligned with defaultConfig");
assert.deepEqual(defaultConfig().context, { display: "percent+tokens", unknown: "show", progressStyle: "border", progressWidth: "third" }, "README context progress defaults should stay aligned with defaultConfig");
assert.ok(readmeZh.includes("pi install npm:@zhcsyncer/pi-glance"), "Chinese README should document scoped install");
assert.ok(readmeZh.includes("Footer 组合"), "Chinese README should document footer composition");
assert.ok(readmeZh.includes("右下角详情"), "Chinese README should document bottom-right details");
assert.ok(readmeZh.includes("progress bar"), "Chinese README should document context progress mode");
assert.ok(readmeZh.includes("未用部分保持细线 `─`，已用部分变为粗线 `━`"), "Chinese README should document border progress glyphs");
assert.ok(readmeZh.includes("70%（含）到 85%（不含）使用 warning，85% 及以上使用 error"), "Chinese README should document fixed context risk thresholds");
assertReadmeIncludes("Icons default to `plain`", "README should state that icons default to plain");
assertReadmeIncludes("`nerd` icons are opt-in", "README should state that nerd icons are opt-in");
assertReadmeIncludes("/glance` → **General** → `Icons`", "README should point users to /glance General Icons");
assertReadmeIncludes("Nerd icons need a Nerd Font or Symbols Nerd Font fallback", "README should explain Nerd Font fallback requirement");
assertReadmeIncludes("If icons look like boxes, choose `plain`", "README should explain the plain fallback when icons render as boxes");
assertReadmeIncludes("does not auto-detect, install, or bundle terminal fonts", "README should avoid implying font detection/install/bundling");

assert.equal(GLANCE_THEMES.length, 22, "README theme copy should describe the curated 22-theme collection");
assertReadmeIncludes("22 built-in Glance palettes", "README should describe the curated 22-theme fallback collection");
assertReadmeIncludes("`Color source` → `Follow Pi`", "README should document the new-install Follow Pi setting");
assertReadmeIncludes("`Light palette` and `Dark palette`", "README should document the split fallback palette rows");
assertReadmeIncludes("Both browsers contain all 22 palettes", "README should state both palette slots can choose all built-ins");
assertReadmeIncludes("matching tone listed first", "README should document slot-aware preferred ordering without filtering");
assertReadmeIncludes("pi-glance is not a Pi theme manager", "README should avoid implying Pi theme management");
assertReadmeIncludes("never enumerates, switches, or installs Pi themes", "README should explicitly rule out Pi theme enumeration/switching");
assertReadmeIncludes("maps Glance text, status, warning, error, title, and detail roles to Pi semantic theme tokens", "README should document Follow Pi semantic styling");
assertReadmeIncludes('"colorSource": "pi"', "README should document the new-install color source default");
assertReadmeIncludes('"startupHeader": true', "README should document the new-install Header default");
assertReadmeIncludes('"theme": {\n    "light": "light",\n    "dark": "dark"\n  }', "README should document the fallback theme pair default");
assert.equal(defaultConfig().colorSource, "pi", "README color-source copy should stay aligned with defaultConfig");
assert.equal(defaultConfig().startupHeader, true, "README Header copy should stay aligned with defaultConfig");
assert.deepEqual(defaultConfig().theme, { light: "light", dark: "dark" }, "README fallback theme copy should stay aligned with defaultConfig");
assert.deepEqual(normalizeConfig({ version: 10 }).colorSource, "glance", "README legacy color-source migration should stay aligned with config normalization");
assert.equal(normalizeConfig({ version: 10 }).startupHeader, false, "README legacy Header migration should stay aligned with config normalization");
assert.deepEqual(normalizeConfig({ theme: "tokyo-night" }).theme, { light: "tokyo-night", dark: "tokyo-night" }, "README old string theme migration should stay aligned with config normalization");
assertReadmeIncludes("focused frame uses Pi's active editor border color", "README should document native thinking/Bash border behavior");
assertReadmeIncludes("Long input height, internal scrolling", "README should document inherited Pi editor behavior");
assertReadmeIncludes("Pi's separate Context/Skills/Prompts/Extensions summary", "README should document preserved native resource summary ownership");
assert.ok(readmeZh.includes('"colorSource": "pi"'), "Chinese README should document Follow Pi defaults");
assert.ok(readmeZh.includes("响应式 Pi Logo"), "Chinese README should document the responsive Startup Header logo");
assert.ok(readmeZh.includes("Context、Skills、Prompts、Extensions"), "Chinese README should document preserved Pi resource summaries");

console.log("✓ README copy checks passed");
