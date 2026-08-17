import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { defaultConfig, normalizeConfig } from "../config.js";
import { GLANCE_THEMES } from "../themes.js";

const readme = await readFile("README.md", "utf8");
const readmeZh = await readFile("README.zh-CN.md", "utf8");
const upstreamSource = await readFile("UPSTREAM_SOURCE.md", "utf8");

function assertReadmeIncludes(fragment: string, message: string): void {
	assert.ok(readme.includes(fragment), message);
}

function assertReadmeExcludes(fragment: string, message: string): void {
	assert.equal(readme.includes(fragment), false, message);
}

assertReadmeIncludes("maintained fork", "README should identify this package as a maintained fork");
assertReadmeIncludes("./assets/demo.png", "README should use the local Glance demo screenshot");
assertReadmeExcludes("LinYS77/pi-glance/main/assets/demo.gif", "README should not keep the upstream demo gif as the user-facing screenshot");
assertReadmeIncludes("pi install npm:@zhcsyncer/pi-glance", "README should install the scoped fork package");
assertReadmeIncludes("Pi 0.80.4 or newer", "README should document the agent_settled-compatible Pi baseline");
assertReadmeIncludes("Other extensions' `ctx.ui.setStatus()` values remain visible", "README should document preserved extension statuses");
assertReadmeIncludes("`status` or `border right`", "README should document the two Working Tree placements");
assertReadmeIncludes("unless Working Tree file counts are already visible", "README should hide the dirty lamp when worktree counts are visible");
assertReadmeIncludes("`main Δ6 +123 −99`", "README should show worktree counts without the dirty lamp");
assertReadmeIncludes("`main↓N`", "README should document the behind-main marker");
assertReadmeIncludes("`Behind main`", "README should document the behind-main setting");
assertReadmeIncludes("or upstream `↓N` is already showing that same lag", "README should hide main↓N when upstream behind already covers origin/main");
assertReadmeIncludes("`/diff` hands the terminal to optional", "README should document the primary review entrypoint");
assertReadmeIncludes("`Ctrl+Shift+S` stashes or restores", "README should document the editor stash shortcut");
assertReadmeIncludes("`Ctrl+Shift+U` discards the stash after a second press", "README should document the discard shortcut");
assertReadmeIncludes("Confirm prompts appear under the editor", "README should document the clearable confirm prompt");
assertReadmeIncludes("The left border shows a highlighted `!stash` mark", "README should document the unrestored-draft border mark");
assertReadmeIncludes("Reloading or resuming the same session restores it automatically if the editor is empty", "README should document empty-editor restore after reload/resume");
assertReadmeExcludes("input-stash.json", "README should not document stash storage layout");
assertReadmeExcludes("1500ms", "README should not document the confirm-window timeout");
assertReadmeIncludes("never sent automatically", "README should document annotation confirmation behavior");
assertReadmeIncludes("only `/diff` shows the install hint", "README should isolate missing revdiff from Glance startup");
assertReadmeIncludes("**Bottom details**", "README should document the remaining bottom-details settings category");
assertReadmeIncludes("`Progress bar`", "README should document the bottom-right context progress toggle");
assertReadmeIncludes("`track` or `border`", "README should document both context progress styles");
assertReadmeIncludes("Unused border cells stay light `─`, used cells become heavy `━`", "README should document border progress glyphs");
assertReadmeIncludes("Below 70% is normal", "README should document the normal context risk range");
assertReadmeIncludes("85% or higher is error", "README should document the context error threshold");
assertReadmeExcludes('"showDefaultStatus"', "README should not document a removed Pi status-row switch");
assertReadmeExcludes("250ms trailing debounce", "README should not document Git refresh internals");
assertReadmeExcludes("schema version 15", "README should not document config schema internals");
assertReadmeExcludes("pnpm test", "README should not document local development steps");
assert.equal("footer" in defaultConfig(), false, "README footer behavior should stay aligned with config removal");
assert.deepEqual(defaultConfig().bottomDetails, { showAutoCompact: true }, "README bottom-details JSON should stay aligned with defaultConfig");
assert.deepEqual(defaultConfig().context, { text: "percent+tokens", progress: false, progressStyle: "border", progressWidth: "third" }, "README context progress defaults should stay aligned with defaultConfig");
assert.equal(defaultConfig().git.worktreeSummary, "status", "README Working Tree default should stay aligned with defaultConfig");
assert.ok(readmeZh.includes("pi install npm:@zhcsyncer/pi-glance"), "Chinese README should document scoped install");
assert.ok(readmeZh.includes("./assets/demo.png"), "Chinese README should use the local Glance demo screenshot");
assert.ok(readmeZh.includes("`Progress bar`"), "Chinese README should document context progress mode");
assert.ok(readmeZh.includes("未用部分细线 `─`，已用部分粗线 `━`"), "Chinese README should document border progress glyphs");
assert.ok(readmeZh.includes("低于 70% 正常，70%（含）到 85%（不含）warning，85% 及以上 error"), "Chinese README should document fixed context risk thresholds");
assert.ok(readmeZh.includes("`status` 或 `border right`"), "Chinese README should document the two Working Tree placements");
assert.ok(readmeZh.includes("`main Δ6 +123 −99`"), "Chinese README should show worktree counts without the dirty lamp");
assert.ok(readmeZh.includes("文件计数已可见时不亮灯"), "Chinese README should hide the dirty lamp when worktree counts are visible");
assert.ok(readmeZh.includes("`main↓N`"), "Chinese README should document the behind-main marker");
assert.ok(readmeZh.includes("`Behind main`"), "Chinese README should document the behind-main setting");
assert.ok(readmeZh.includes("上游 `↓N` 已经在报同一件事时不显示"), "Chinese README should hide main↓N when upstream behind already covers origin/main");
assert.ok(readmeZh.includes("只回填编辑器供你确认"), "Chinese README should document annotation confirmation behavior");
assert.ok(readmeZh.includes("`Ctrl+Shift+S` 收起或拿回"), "Chinese README should document the editor stash shortcut");
assert.ok(readmeZh.includes("`Ctrl+Shift+U` 连按两次丢掉"), "Chinese README should document the discard shortcut");
assert.ok(readmeZh.includes("确认提示出现在输入框下方"), "Chinese README should document the clearable confirm prompt");
assert.ok(readmeZh.includes("`!stash`"), "Chinese README should document the unrestored-draft border mark");
assert.ok(readmeZh.includes("输入框是空的会自动倒回"), "Chinese README should document empty-editor restore after reload/resume");
assert.equal(readmeZh.includes("input-stash.json"), false, "Chinese README should not document stash storage layout");
assertReadmeIncludes("Icons` default to `plain`", "README should state that icons default to plain");
assertReadmeIncludes("`nerd` needs a Nerd Font", "README should state that nerd icons are opt-in");
assertReadmeIncludes("If icons look like boxes, choose `plain`", "README should explain the plain fallback when icons render as boxes");
assertReadmeIncludes("Claude-inspired working indicator", "README should describe the Claude-inspired working indicator");
assertReadmeIncludes("Fork difference:", "README should clearly mark the working indicator as a fork difference");
assertReadmeIncludes("upstream `pi-glance` 0.5.3 does not include it", "README should distinguish the working indicator from upstream capabilities");
assert.ok(upstreamSource.includes("switchable, theme-aware Claude-inspired working indicator"), "upstream source record should list the working indicator among local differences");
assert.ok(upstreamSource.includes("defaults into the Git status line"), "upstream source record should list the Working Tree summary among local differences");
assert.ok(upstreamSource.includes("single-slot editor stash"), "upstream source record should list the editor stash among local differences");
assertReadmeIncludes("not an official Anthropic component", "README should rule out official Anthropic provenance");
assertReadmeIncludes("does not change the Agent, prompts, models, tools, messages, or session behavior", "README should document display-only behavior");
assertReadmeIncludes("one `Enabled: on/off` switch", "README should document the single working-indicator toggle");
assertReadmeIncludes("instead of showing `↓ ~0 tokens`", "README should document empty-partial suppression");
assertReadmeIncludes("Top-border Tokens are session cumulative usage", "README should distinguish session usage from working output");
assertReadmeIncludes("Context is context-window occupancy", "README should distinguish context occupancy from output counters");
assertReadmeIncludes("Elapsed time uses the theme warning color at five minutes or later", "README should document long-cycle elapsed emphasis");
assert.deepEqual(defaultConfig().workingIndicator, { enabled: true }, "README working default should stay aligned with config");
assert.ok(readmeZh.includes("**Fork 差异：**"), "Chinese README should clearly mark the working indicator as a fork difference");
assert.ok(readmeZh.includes("上游 `pi-glance` 0.5.3 不包含该功能"), "Chinese README should distinguish the working indicator from upstream capabilities");
assert.ok(readmeZh.includes("不是 Anthropic 官方组件"), "Chinese README should rule out official Anthropic provenance");
assert.ok(readmeZh.includes("一级菜单只有一个 `Enabled: on/off`"), "Chinese README should document the single working switch");
assert.ok(readmeZh.includes("不显示 `↓ ~0 tokens`"), "Chinese README should document empty-partial suppression");
assert.ok(readmeZh.includes("当前 session 累计 usage"), "Chinese README should document session-token scope");
assert.ok(readmeZh.includes("context window 占用"), "Chinese README should document context scope");
assert.ok(readmeZh.includes("五分钟及以上耗时使用主题 warning 色"), "Chinese README should document long-cycle elapsed emphasis");

assert.equal(GLANCE_THEMES.length, 22, "README theme copy should describe the curated 22-theme collection");
assertReadmeIncludes("22 Glance palettes", "README should describe the curated 22-theme fallback collection");
assertReadmeIncludes("`Color source` is `Follow Pi`", "README should document the new-install Follow Pi setting");
assertReadmeIncludes("`Light palette` and `Dark palette`", "README should document the split fallback palette rows");
assert.equal(defaultConfig().colorSource, "pi", "README color-source copy should stay aligned with defaultConfig");
assert.equal("startupHeader" in defaultConfig(), false, "README/config contract should not expose a custom Header setting");
assert.deepEqual(defaultConfig().theme, { light: "light", dark: "dark" }, "README fallback theme copy should stay aligned with defaultConfig");
assert.deepEqual(normalizeConfig({ version: 10 }).colorSource, "glance", "README legacy color-source migration should stay aligned with config normalization");
assert.deepEqual(normalizeConfig({ theme: "tokyo-night" }).theme, { light: "tokyo-night", dark: "tokyo-night" }, "README old string theme migration should stay aligned with config normalization");
assert.ok(readmeZh.includes("不隐藏其他扩展发布的状态"), "Chinese README should document preserved extension statuses");

console.log("✓ README copy checks passed");
