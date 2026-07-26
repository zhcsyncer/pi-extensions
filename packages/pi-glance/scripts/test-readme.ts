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
assertReadmeIncludes("maps the Header, frame, text, status, warning, error, title, and detail roles to Pi semantic theme tokens", "README should document Follow Pi semantic styling");
assertReadmeIncludes('"colorSource": "pi"', "README should document the new-install color source default");
assertReadmeIncludes('"startupHeader": true', "README should document the new-install Header default");
assertReadmeIncludes('"theme": {\n    "light": "light",\n    "dark": "dark"\n  }', "README should document the fallback theme pair default");
assert.equal(defaultConfig().colorSource, "pi", "README color-source copy should stay aligned with defaultConfig");
assert.equal(defaultConfig().startupHeader, true, "README Header copy should stay aligned with defaultConfig");
assert.deepEqual(defaultConfig().theme, { light: "light", dark: "dark" }, "README fallback theme copy should stay aligned with defaultConfig");
assert.deepEqual(normalizeConfig({ version: 10 }).colorSource, "glance", "README legacy color-source migration should stay aligned with config normalization");
assert.equal(normalizeConfig({ version: 10 }).startupHeader, false, "README legacy Header migration should stay aligned with config normalization");
assert.deepEqual(normalizeConfig({ theme: "tokyo-night" }).theme, { light: "tokyo-night", dark: "tokyo-night" }, "README old string theme migration should stay aligned with config normalization");
assertReadmeIncludes("static responsive Claude-style box", "README should document the approved boxed Startup Header style");
assertReadmeIncludes("`Ask Pi to build it`", "README should document the Claude-style getting-started prompt");
assertReadmeIncludes("pinned `/glance`, and up to three real commands selected from the current Pi session", "README should document real session command Tips");
assertReadmeIncludes("Model, thinking, and cwd remain only in the Editor instead of being repeated in the Header", "README should document removal of duplicate Editor facts");
assertReadmeIncludes("B1 `Resources` row is a compact startup snapshot", "README should document the Header resource snapshot");
assertReadmeIncludes("Extension count ending in `+` is a lower bound", "README should explain the public command-catalog limitation");
assertReadmeIncludes("focused frame uses the selected Color source border and does not change with thinking level", "README should document stable normal frame coloring");
assertReadmeIncludes("Bash is the only dynamic exception", "README should document the Bash-only border exception");
assertReadmeIncludes("Glance palette` uses the selected light/dark built-in pair for the Header, frame, segments, and context progress", "README should document palette-wide styling");
assertReadmeIncludes("Filled and unused border colors come from the selected Color source", "README should document context progress source consistency");
assertReadmeIncludes("Long input height, internal scrolling", "README should document inherited Pi editor behavior");
assertReadmeIncludes("Pi's separate Context/Skills/Prompts/Extensions area remains authoritative", "README should document preserved native resource ownership");
assertReadmeIncludes("grouped by project/user/path", "README should document native Extensions scope grouping");
assertReadmeIncludes("`npm:`/`git:` package sources and local file paths", "README should document native Extensions installation-source detail");
assert.ok(readmeZh.includes('"colorSource": "pi"'), "Chinese README should document Follow Pi defaults");
assert.ok(readmeZh.includes("Claude 风格响应式圆角盒"), "Chinese README should document the responsive boxed Startup Header");
assert.ok(readmeZh.includes("当前 Pi 会话真实命令中抽取的最多 3 条 Tips"), "Chinese README should document real session command Tips");
assert.ok(readmeZh.includes("只留在 Editor，不再在 Header 重复"), "Chinese README should document removal of duplicate Editor facts");
assert.ok(readmeZh.includes("Extensions 数量后的 `+` 表示下限"), "Chinese README should document the resource snapshot limitation");
assert.ok(readmeZh.includes("不再跟随 thinking level"), "Chinese README should document stable normal frame coloring");
assert.ok(readmeZh.includes("Context、Skills、Prompts、Extensions"), "Chinese README should document preserved Pi resource summaries");
assert.ok(readmeZh.includes("project/user/path"), "Chinese README should document native Extensions scope grouping");
assert.ok(readmeZh.includes("`npm:`/`git:` 包来源和本地文件路径"), "Chinese README should document native Extensions installation sources");

console.log("✓ README copy checks passed");
