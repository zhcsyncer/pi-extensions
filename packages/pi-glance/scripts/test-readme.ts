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
assertReadmeIncludes("adaptive border-aligned track", "README should document the border-native adaptive progress track");
assertReadmeIncludes("percentage uses normal text", "README should document the quieter percentage hierarchy");
assertReadmeIncludes("Bottom progress deliberately omits the context icon", "README should document the icon-free bottom progress design");
assertReadmeIncludes("Nerd Font text modes still use the `󰍛` memory icon", "README should document where the Nerd Font context icon remains visible");
assertReadmeIncludes("Nerd Font mode shows the highlighted `󰁄 auto` marker", "README should document the labeled auto-compaction Nerd Font marker");
assertReadmeIncludes("one third of the input surface's inner width", "README should document the shared one-third bottom-details budget");
assertReadmeExcludes('"showDefaultStatus"', "README should not document a removed Pi status-row switch");
assertReadmeExcludes('"enabled": true,\n    "showSession"', "README should not document the removed bottom-details master and session switches");
assert.equal("footer" in defaultConfig(), false, "README footer behavior should stay aligned with config removal");
assert.deepEqual(defaultConfig().bottomDetails, { showAutoCompact: true }, "README bottom-details JSON should stay aligned with defaultConfig");
assert.ok(readmeZh.includes("pi install npm:@zhcsyncer/pi-glance"), "Chinese README should document scoped install");
assert.ok(readmeZh.includes("Footer 组合"), "Chinese README should document footer composition");
assert.ok(readmeZh.includes("右下角详情"), "Chinese README should document bottom-right details");
assert.ok(readmeZh.includes("progress bar"), "Chinese README should document context progress mode");
assertReadmeIncludes("Icons default to `plain`", "README should state that icons default to plain");
assertReadmeIncludes("`nerd` icons are opt-in", "README should state that nerd icons are opt-in");
assertReadmeIncludes("/glance` → **General** → `Icons`", "README should point users to /glance General Icons");
assertReadmeIncludes("Nerd icons need a Nerd Font or Symbols Nerd Font fallback", "README should explain Nerd Font fallback requirement");
assertReadmeIncludes("If icons look like boxes, choose `plain`", "README should explain the plain fallback when icons render as boxes");
assertReadmeIncludes("does not auto-detect, install, or bundle terminal fonts", "README should avoid implying font detection/install/bundling");

assert.equal(GLANCE_THEMES.length, 22, "README theme copy should describe the curated 22-theme collection");
assertReadmeIncludes("22 built-in palettes", "README should describe the curated 22-theme count");
assertReadmeIncludes("/glance` → **General** → `Light theme` or `Dark theme`", "README should document the split /glance theme rows");
assertReadmeIncludes("press Enter, preview palettes in the browser", "README should describe the theme browser flow");
assertReadmeIncludes("Both rows can choose from all 22 built-in Glance palettes", "README should state both theme slots can choose all built-in palettes");
assertReadmeIncludes("Light theme browser lists light-toned palettes first", "README should document light-slot preferred ordering");
assertReadmeIncludes("Dark theme browser lists dark-toned palettes first", "README should document dark-slot preferred ordering");
assertReadmeIncludes("neither browser filters the catalog", "README should state slot ordering is not filtering");
assertReadmeIncludes(
	"Built-ins: Light, Dark, Catppuccin Latte/Mocha/Frappé/Macchiato, Nord, Tokyo Night, Gruvbox Light/Dark, Solarized Light/Dark, Rosé Pine/Dawn, One Light/Dark, Kanagawa Wave/Lotus, Everforest Light/Dark, and High Contrast Light/Dark.",
	"README should keep the curated built-in theme expression",
);
assertReadmeIncludes("pi-glance uses its own curated 22 built-in Glance palettes", "README should clarify themes are pi-glance-owned palettes");
assertReadmeIncludes("It is not a Pi theme manager", "README should avoid implying Pi theme management");
assertReadmeIncludes("does not enumerate, switch, or install Pi UI themes", "README should explicitly rule out Pi theme enumeration/switching");
assertReadmeIncludes("does not render with Pi theme token colors", "README should explicitly rule out Pi token color rendering");
assertReadmeIncludes("theme: { light: GlanceThemeName, dark: GlanceThemeName }", "README should document the supported theme pair config model");
assertReadmeIncludes('"theme": {\n    "light": "light",\n    "dark": "dark"\n  }', "README should document the new-install theme pair default");
assert.deepEqual(defaultConfig().theme, { light: "light", dark: "dark" }, "README default theme copy should stay aligned with defaultConfig");
assertReadmeIncludes('{ "theme": "x" }', "README should document old string theme migration input");
assertReadmeIncludes('{ "theme": { "light": "x", "dark": "x" } }', "README should document conservative old string theme migration output");
assert.deepEqual(normalizeConfig({ theme: "tokyo-night" }).theme, { light: "tokyo-night", dark: "tokyo-night" }, "README migration copy should stay aligned with config normalization");
assertReadmeIncludes("exact `light` selects `theme.light`", "README should document exact light ambient tone slot selection");
assertReadmeIncludes("exact `dark` selects `theme.dark`", "README should document exact dark ambient tone slot selection");
assertReadmeIncludes("unknown or custom Pi theme names fall back to `theme.light`", "README should document unknown/custom ambient tone fallback");

console.log("✓ README copy checks passed");
