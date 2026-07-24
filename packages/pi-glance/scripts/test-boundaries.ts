import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const ALLOWED_PI_IMPORTS = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
]);
const FOOTER_MODULE = "footer.ts";
const STATUS_LINE_MODULE = "status-line.ts";
const INPUT_SURFACE_FRAME_MODULE = "input-surface-frame.ts";
const RENDER_MODULES = new Set(["editor.ts", "renderer.ts", "pane.ts", "segments.ts", "surface-layout.ts", INPUT_SURFACE_FRAME_MODULE, FOOTER_MODULE, STATUS_LINE_MODULE]);
const INDEX_MODULE = "index.ts";
const PURE_CONFIG_OPTIONS_MODULE = "config-options.ts";
const SEGMENT_DISPLAY_PRIMITIVES_MODULE = "segment-display-primitives.ts";
const RUNTIME_POLICY_MODULE = "runtime-policy.ts";
const RUNTIME_PLAN_EXECUTOR_MODULE = "runtime-plan-executor.ts";
const RUNTIME_REFRESH_SESSION_MODULE = "runtime-refresh-session.ts";
const RUNTIME_SNAPSHOT_MODULE = "runtime-snapshot.ts";
const STATE_MODULE = "state.ts";
const SURFACE_LAYOUT_MODULE = "surface-layout.ts";
const SETTINGS_CATALOG_MODULE = "settings-catalog.ts";
const PANE_MODEL_MODULE = "pane-model.ts";
const THEME_ADAPTER_MODULE = "theme-adapter.ts";
const THEME_SELECTION_MODULE = "theme-selection.ts";
const THEME_TONE_MODULE = "theme-tone.ts";
const RENDER_STYLE_CONTEXT_MODULE = "render-style-context.ts";
const GUARD_SCRIPT = join("scripts", "test-boundaries.ts");
const LEGACY_NAMESPACE = ["@mariozechner", ""].join("/");
const LOW_LEVEL_FRAME_COMPOSITION_TOKENS = [
	"planSurfaceTopFrame",
	"planSurfaceBottomFrame",
	"planSurfaceRow",
	"planSurfaceStatusBudget",
	"planWorkspaceTitle",
	"renderSurfaceChunks",
	"renderSurfaceTopMargin",
	"safeSurfaceWidth",
	"surfaceMetrics",
	"SURFACE_AUTOCOMPLETE_INDENT",
	"SURFACE_CONTENT_PADDING_X",
] as const;
const LOW_LEVEL_FRAME_COMPOSITION_PATTERN = new RegExp(`\\b(?:${LOW_LEVEL_FRAME_COMPOSITION_TOKENS.join("|")})\\b`);

interface SourceFile {
	path: string;
	text: string;
}

async function readSourceFiles(): Promise<SourceFile[]> {
	const rootEntries = await readdir(ROOT, { withFileTypes: true });
	const rootTs = rootEntries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => entry.name);

	const scriptEntries = await readdir(join(ROOT, "scripts"), { withFileTypes: true });
	const scriptTs = scriptEntries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join("scripts", entry.name));

	return Promise.all(
		[...rootTs, ...scriptTs].map(async (path) => ({
			path,
			text: await readFile(join(ROOT, path), "utf8"),
		})),
	);
}

async function readText(path: string): Promise<string> {
	return readFile(join(ROOT, path), "utf8");
}

function fail(message: string): never {
	assert.fail(message);
}

function importSpecifiers(file: SourceFile): string[] {
	const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	return [...file.text.matchAll(importPattern)].map((match) => match[1]!);
}

function namedImportsFrom(file: SourceFile, specifier: string): string[] {
	const namedImportPattern = /import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;
	const names: string[] = [];
	for (const match of file.text.matchAll(namedImportPattern)) {
		if (match[2] !== specifier) continue;
		for (const raw of match[1]!.split(",")) {
			const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
			if (name) names.push(name);
		}
	}
	return names;
}

function assertNoLowLevelFrameCompositionTokens(file: SourceFile, label: string): void {
	const match = file.text.match(LOW_LEVEL_FRAME_COMPOSITION_PATTERN);
	if (match) fail(`${file.path}: ${label} must not directly use low-level frame composition primitive ${match[0]}`);
}

function assertNoLegacyNamespace(files: SourceFile[]): void {
	for (const file of files) {
		const index = file.text.indexOf(LEGACY_NAMESPACE);
		if (index >= 0) fail(`${file.path}: legacy namespace is not allowed`);
	}
}

function assertNoLegacyPiPackages(packageFiles: SourceFile[]): void {
	const legacyPiPackage = /@mariozechner\/pi-(?:ai|coding-agent|tui)/;
	for (const file of packageFiles) {
		if (legacyPiPackage.test(file.text)) fail(`${file.path}: legacy pi package namespace is not allowed`);
	}
}

function assertPublicPiImports(files: SourceFile[]): void {
	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const file of files) {
		for (const match of file.text.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (specifier.startsWith(LEGACY_NAMESPACE)) {
				fail(`${file.path}: legacy pi import ${specifier}`);
			}
			if (!specifier.startsWith("@earendil-works/pi-")) continue;
			if (!ALLOWED_PI_IMPORTS.has(specifier)) {
				fail(`${file.path}: private/deep or unsupported pi import ${specifier}`);
			}
		}
	}
}

function assertNoCorePatching(files: SourceFile[]): void {
	const patterns: Array<[RegExp, string]> = [
		[/\bObject\.definePropert(?:y|ies)\s*\(/, "Object.defineProperty/defineProperties"],
		[/\bReflect\.defineProperty\s*\(/, "Reflect.defineProperty"],
		[/\bObject\.setPrototypeOf\s*\(/, "Object.setPrototypeOf"],
		[/__proto__/, "__proto__ mutation"],
		[/\.prototype(?:\.[A-Za-z_$][\w$]*)?\s*=/, "prototype mutation"],
		[/\bglobalThis\.[A-Za-z_$][\w$]*\s*=/, "globalThis mutation"],
		[/\bcreateRequire\s*\(/, "createRequire"],
		[/(^|[^.\w$])require\s*\(/, "require()"],
	];

	for (const file of files.filter((candidate) => candidate.path !== GUARD_SCRIPT)) {
		for (const [pattern, label] of patterns) {
			if (pattern.test(file.text)) fail(`${file.path}: core-patching/dynamic import pattern is not allowed (${label})`);
		}
	}
}

function assertSurfaceLayoutSeamImports(files: SourceFile[]): void {
	const surfaceLayout = files.find((candidate) => basename(candidate.path) === SURFACE_LAYOUT_MODULE);
	if (!surfaceLayout) return;
	const forbiddenModulePattern = /(?:^|\/)(?:input-surface-frame|renderer|editor|pane|status-line)(?:\.js)?$/;
	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of surfaceLayout.text.matchAll(importPattern)) {
		const specifier = match[1]!;
		if (forbiddenModulePattern.test(specifier)) {
			fail(`${surfaceLayout.path}: surface-layout seam must not import ${specifier}`);
		}
	}
}

function assertSettingsCatalogSeamImports(files: SourceFile[]): void {
	const settingsCatalog = files.find((candidate) => basename(candidate.path) === SETTINGS_CATALOG_MODULE);
	if (!settingsCatalog) return;
	const forbiddenModulePattern = /(?:^|\/)(?:renderer|editor|pane|pane-model|surface-layout|input-surface-frame|status-line)(?:\.js)?$/;
	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of settingsCatalog.text.matchAll(importPattern)) {
		const specifier = match[1]!;
		if (forbiddenModulePattern.test(specifier) || specifier.startsWith("@earendil-works/pi-")) {
			fail(`${settingsCatalog.path}: settings-catalog seam must not import runtime/render/model module ${specifier}`);
		}
	}
}

const IO_NETWORK_PROCESS_IMPORTS = new Set([
	"fs",
	"fs/promises",
	"node:fs",
	"node:fs/promises",
	"child_process",
	"node:child_process",
	"process",
	"node:process",
	"http",
	"node:http",
	"https",
	"node:https",
	"net",
	"node:net",
	"tls",
	"node:tls",
	"dgram",
	"node:dgram",
	"dns",
	"node:dns",
	"undici",
	"ws",
]);

function assertPaneModelSeamImports(files: SourceFile[]): void {
	const paneModel = files.find((candidate) => basename(candidate.path) === PANE_MODEL_MODULE);
	assert.ok(paneModel, "pane-model.ts pure model seam should exist");

	const allowedLocalSpecifiers = new Set(["./config.js", "./settings-catalog.js", "./types.js"]);
	const forbiddenLocalModulePattern = /(?:^|\/)(?:pane|editor|renderer|surface-layout|input-surface-frame|status-line)(?:\.js)?$/;
	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of paneModel.text.matchAll(importPattern)) {
		const specifier = match[1]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${paneModel.path}: pane-model seam must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${paneModel.path}: pane-model seam must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalModulePattern.test(specifier)) fail(`${paneModel.path}: pane-model seam must not import render/UI module ${specifier}`);
		if (specifier.startsWith(".") && !allowedLocalSpecifiers.has(specifier)) fail(`${paneModel.path}: pane-model seam may only import pure helpers/types, not ${specifier}`);
	}
}

function assertThemeAdapterSeamImports(files: SourceFile[]): void {
	const themeAdapter = files.find((candidate) => basename(candidate.path) === THEME_ADAPTER_MODULE);
	assert.ok(themeAdapter, "theme-adapter.ts pure style adapter seam should exist");

	const allowedLocalSpecifiers = new Set(["./palette.js", "./theme-selection.js", "./themes.js", "./types.js"]);
	const forbiddenLocalModulePattern = /(?:^|\/)(?:runtime|runtime-plan-executor|runtime-refresh-session|runtime-snapshot|state|config|config-options|settings-catalog|pane|pane-model|editor|renderer|status-line|surface-layout|input-surface-frame|footer)(?:\.js)?$/;
	const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of themeAdapter.text.matchAll(importPattern)) {
		const specifier = match[1]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${themeAdapter.path}: theme adapter must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${themeAdapter.path}: theme adapter must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalModulePattern.test(specifier)) fail(`${themeAdapter.path}: theme adapter must not import runtime/render/UI module ${specifier}`);
		if (specifier.startsWith(".") && !allowedLocalSpecifiers.has(specifier)) fail(`${themeAdapter.path}: theme adapter may only import palette/theme/types helpers, not ${specifier}`);
		if (!specifier.startsWith(".")) fail(`${themeAdapter.path}: theme adapter must not import external module ${specifier}`);
	}
	if (!themeAdapter.text.includes("interface GlanceRenderStyleContext")) fail(`${themeAdapter.path}: theme adapter should expose a shared render style context seam`);
	if (!themeAdapter.text.includes("ambientTone") || !themeAdapter.text.includes("getAmbientTone")) fail(`${themeAdapter.path}: render style context should expose ambient tone inputs`);
	if (!themeAdapter.text.includes("selectGlanceTheme")) fail(`${themeAdapter.path}: render style resolver should select from the configured theme pair`);
	if (!themeAdapter.text.includes("resolveGlanceRenderStyles")) fail(`${themeAdapter.path}: theme adapter should expose a shared render style resolver`);
	if (!themeAdapter.text.includes("interface PiThemeLike")) fail(`${themeAdapter.path}: theme adapter should expose a structural Pi theme-like style source skeleton`);
	if (!themeAdapter.text.includes("resolvePiThemeStyles")) fail(`${themeAdapter.path}: theme adapter should expose an adapter-only Pi theme style resolver`);
}

function assertThemeSelectionSeamImports(files: SourceFile[]): void {
	const themeSelection = files.find((candidate) => basename(candidate.path) === THEME_SELECTION_MODULE);
	assert.ok(themeSelection, "theme-selection.ts pure theme selection seam should exist");

	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of themeSelection.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${themeSelection.path}: theme selection seam must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${themeSelection.path}: theme selection seam must not import IO/network/process module ${specifier}`);
		if (specifier !== "./types.js") fail(`${themeSelection.path}: theme selection seam must only import shared types, not ${specifier}`);
		if (!isTypeOnly) fail(`${themeSelection.path}: theme selection seam must import shared types type-only`);
	}
	if (!themeSelection.text.includes("GlanceAmbientTone")) fail(`${themeSelection.path}: theme selection seam should expose ambient tone type`);
	if (!themeSelection.text.includes("selectGlanceTheme")) fail(`${themeSelection.path}: theme selection seam should expose selectGlanceTheme`);
	if (/readPiUiTheme|resolveRuntimeRenderStyleContext|resolvePiThemeStyles|PiThemeLike|PiThemeColorToken|ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(themeSelection.text)) {
		fail(`${themeSelection.path}: theme selection seam must not depend on Pi theme provider/product APIs`);
	}
}

function assertThemeToneSeamImports(files: SourceFile[]): void {
	const themeTone = files.find((candidate) => basename(candidate.path) === THEME_TONE_MODULE);
	assert.ok(themeTone, "theme-tone.ts public ambient tone reader seam should exist");

	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of themeTone.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${themeTone.path}: ambient tone reader seam must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${themeTone.path}: ambient tone reader seam must not import IO/network/process module ${specifier}`);
		if (specifier !== "./theme-selection.js") fail(`${themeTone.path}: ambient tone reader seam may only import shared selection types, not ${specifier}`);
		if (!isTypeOnly) fail(`${themeTone.path}: ambient tone reader seam must import shared selection types type-only`);
	}
	if (!themeTone.text.includes("interface PiThemeToneHost")) fail(`${themeTone.path}: ambient tone reader seam should expose structural PiThemeToneHost`);
	if (!themeTone.text.includes("readPiAmbientTone")) fail(`${themeTone.path}: ambient tone reader seam should expose readPiAmbientTone`);
	if (/ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(|resolvePiThemeStyles|PiThemeLike|PiThemeColorToken|getColorMode\s*\(|\bfg\s*\(|\bbg\s*\(|sourcePath|PALETTES/.test(themeTone.text)) {
		fail(`${themeTone.path}: ambient tone reader seam must only inspect public theme.name and stay out of Pi/theme-color internals`);
	}
}

function assertPiThemeResolverAdapterOnly(files: SourceFile[]): void {
	const allowed = new Set([THEME_ADAPTER_MODULE, RENDER_STYLE_CONTEXT_MODULE, GUARD_SCRIPT, join("scripts", "test-themes.ts")]);
	for (const file of files) {
		if (allowed.has(file.path)) continue;
		if (/resolvePiThemeStyles|PiThemeLike|PiThemeColorToken/.test(file.text)) {
			fail(`${file.path}: Pi theme style resolver skeleton must remain adapter/provider/test-only in this slice`);
		}
	}
}

function assertRenderStyleContextSeam(files: SourceFile[]): void {
	const renderStyleContext = files.find((candidate) => basename(candidate.path) === RENDER_STYLE_CONTEXT_MODULE);
	assert.ok(renderStyleContext, "render-style-context.ts inactive runtime style provider seam should exist");

	const allowedSpecifiers = new Set(["./theme-adapter.js", "./theme-selection.js", "./types.js"]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of renderStyleContext.text.matchAll(importPattern)) {
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${renderStyleContext.path}: provider seam must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${renderStyleContext.path}: provider seam must not import IO/network/process module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${renderStyleContext.path}: provider seam must not import ${specifier}`);
	}
	if (!renderStyleContext.text.includes("createPiRenderStyleContext")) fail(`${renderStyleContext.path}: provider seam should expose Pi theme to GlanceRenderStyleContext conversion`);
	if (!renderStyleContext.text.includes("resolveRuntimeRenderStyleContext")) fail(`${renderStyleContext.path}: provider seam should expose inactive runtime context resolver`);
	if (!renderStyleContext.text.includes("getAmbientTone")) fail(`${renderStyleContext.path}: runtime context resolver should merge ambient tone providers with future style overrides`);
	if (!renderStyleContext.text.includes("enablePiThemeStyles")) fail(`${renderStyleContext.path}: runtime Pi style activation should require an explicit future enable flag`);
	if (/getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(renderStyleContext.text)) fail(`${renderStyleContext.path}: provider seam must not enumerate, load, or set Pi themes`);
}

function assertThemePairGuardrails(files: SourceFile[]): void {
	const productionFiles = files.filter((candidate) => !candidate.path.startsWith("scripts/"));
	const forbiddenProductPatterns: Array<[RegExp, string]> = [
		[/\bthemeMode\b/, "themeMode"],
		[/\bFOLLOW_PI_THEME_ID\b/, "FOLLOW_PI_THEME_ID"],
		[/\btheme\s*:\s*["']pi["']/, 'theme: "pi"'],
		[/\btheme\s*:\s*["']auto["']/, 'theme: "auto"'],
		[/ctx\.ui\.setTheme\s*\(/, "ctx.ui.setTheme()"],
		[/getAllThemes\s*\(/, "getAllThemes()"],
		[/setTheme\s*\(/, "setTheme()"],
	];
	for (const file of productionFiles) {
		for (const [pattern, label] of forbiddenProductPatterns) {
			if (pattern.test(file.text)) fail(`${file.path}: light/dark theme pairs must not introduce ${label}`);
		}
	}

	const themeTone = files.find((candidate) => basename(candidate.path) === THEME_TONE_MODULE);
	assert.ok(themeTone, "theme-tone.ts public ambient tone reader seam should exist");
	if (!themeTone.text.includes("const name = host?.theme?.name;")) fail(`${themeTone.path}: ambient tone reader should inspect only the public structural theme name`);
	if (!themeTone.text.includes('if (name === "light" || name === "dark") return name;')) fail(`${themeTone.path}: ambient tone reader should use exact light/dark name matching`);
	if (/toLowerCase|toUpperCase|includes\s*\(|startsWith\s*\(|endsWith\s*\(|getColorMode\s*\(/.test(themeTone.text)) {
		fail(`${themeTone.path}: ambient tone reader must not infer tone from fuzzy names or color-mode helpers`);
	}

	const renderStyleContext = files.find((candidate) => basename(candidate.path) === RENDER_STYLE_CONTEXT_MODULE);
	assert.ok(renderStyleContext, "render-style-context.ts inactive runtime style provider seam should exist");
	if (/enablePiThemeStyles\s*[:=]\s*true|enablePiThemeStyles\s*\?\?\s*true/.test(renderStyleContext.text)) {
		fail(`${renderStyleContext.path}: Pi theme styles must remain inactive by default`);
	}
	if (!/options\.enablePiThemeStyles\s*\?\s*createPiRenderStyleContext\(options\.piTheme\)\s*:\s*undefined/.test(renderStyleContext.text)) {
		fail(`${renderStyleContext.path}: active Pi theme color styles must remain behind the explicit future enable flag`);
	}
}

function assertPiThemeRuntimeProviderBoundary(files: SourceFile[]): void {
	const runtime = files.find((candidate) => basename(candidate.path) === "runtime.ts");
	assert.ok(runtime, "runtime.ts should exist");
	if (!runtime.text.includes("./render-style-context.js")) fail(`${runtime.path}: runtime should import the inactive render style provider seam`);
	if (!runtime.text.includes("resolveRuntimeRenderStyleContext(activeConfig")) fail(`${runtime.path}: runtime should prepare render style context through the inactive provider seam for editor install`);
	if (!runtime.text.includes("resolveRuntimeRenderStyleContext(current")) fail(`${runtime.path}: runtime should prepare render style context through the inactive provider seam for pane preview`);
	if (!runtime.text.includes("./theme-tone.js")) fail(`${runtime.path}: runtime should import the public ambient tone reader seam`);
	if (!runtime.text.includes("getAmbientTone: () => readPiAmbientTone(ctx.ui)")) fail(`${runtime.path}: runtime should provide lazy ambient tone through the theme-tone seam`);
	if (/enablePiThemeStyles/.test(runtime.text)) fail(`${runtime.path}: runtime must not activate Pi theme styles without a future explicit product decision`);
	if (/createPiRenderStyleContext|resolvePiThemeStyles|PiThemeLike|PiThemeColorToken|readPiUiTheme|ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(runtime.text)) {
		fail(`${runtime.path}: runtime must not directly use Pi theme adapters, inactive Pi color reader, or enumerate/set Pi themes`);
	}

	for (const file of files) {
		if (new Set([RENDER_STYLE_CONTEXT_MODULE, GUARD_SCRIPT]).has(file.path)) continue;
		if (/ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(file.text)) {
			fail(`${file.path}: Pi UI theme APIs must stay limited to the inactive provider seam in this slice`);
		}
	}
}

function assertPanePreviewStyleContextBoundary(files: SourceFile[]): void {
	const pane = files.find((candidate) => basename(candidate.path) === "pane.ts");
	assert.ok(pane, "pane.ts should exist");
	if (!pane.text.includes("GlancePaneOptions")) fail(`${pane.path}: pane should expose optional preview style context options`);
	if (!pane.text.includes("renderStyleContext")) fail(`${pane.path}: pane preview should accept an optional render style context`);
	if (!pane.text.includes("GlanceRenderStyleContext")) fail(`${pane.path}: pane should only depend on the generic render style context type`);
	if (/render-style-context|resolvePiThemeStyles|PiThemeLike|PiThemeColorToken|readPiUiTheme|createPiRenderStyleContext/.test(pane.text)) {
		fail(`${pane.path}: pane must not depend on Pi-specific style providers or resolver types`);
	}
	if (!/renderInputSurface\([\s\S]*?previewOptions/.test(pane.text)) fail(`${pane.path}: runtime-state pane preview should forward preview style context options`);
	if (!/renderInputSurfacePreview\([\s\S]*?previewOptions/.test(pane.text)) fail(`${pane.path}: static pane preview should forward preview style context options`);
}

function assertRenderModulesHaveNoIo(files: SourceFile[]): void {
	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	const callPatterns: Array<[RegExp, string]> = [
		[/\bfetch\s*\(/, "fetch()"],
		[/\bXMLHttpRequest\b/, "XMLHttpRequest"],
		[/\bWebSocket\b/, "WebSocket"],
		[/\bexec(?:File)?\s*\(/, "exec/execFile"],
		[/\bspawn\s*\(/, "spawn"],
		[/\bfork\s*\(/, "fork"],
		[/\breadFile\s*\(/, "readFile"],
		[/\bwriteFile\s*\(/, "writeFile"],
		[/\bmkdir\s*\(/, "mkdir"],
		[/\breaddir\s*\(/, "readdir"],
		[/\bstat\s*\(/, "stat"],
		[/\bcreateReadStream\s*\(/, "createReadStream"],
		[/\bcreateWriteStream\s*\(/, "createWriteStream"],
	];

	for (const file of files.filter((candidate) => RENDER_MODULES.has(basename(candidate.path)) || basename(candidate.path) === SETTINGS_CATALOG_MODULE)) {
		for (const match of file.text.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${file.path}: render module must not import IO/network/process module ${specifier}`);
		}
		for (const [pattern, label] of callPatterns) {
			if (pattern.test(file.text)) fail(`${file.path}: render module must not perform render-time IO/network/process work (${label})`);
		}
	}
}

function assertInputSurfaceFrameSeamImports(files: SourceFile[]): void {
	const inputSurfaceFrame = files.find((candidate) => basename(candidate.path) === INPUT_SURFACE_FRAME_MODULE);
	assert.ok(inputSurfaceFrame, "input-surface-frame.ts frame composition seam should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-tui", "./bottom-details.js", "./context-risk.js", "./status-line.js", "./surface-layout.js", "./theme-adapter.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./editor.js",
		"./renderer.js",
		"./pane.js",
		"./runtime.js",
		"./runtime-snapshot.js",
		"./state.js",
		"./footer.js",
		"./config.js",
		"./settings-catalog.js",
		"./palette.js",
		"./render-style-context.js",
	]);
	const imports = importSpecifiers(inputSurfaceFrame);
	for (const specifier of imports) {
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-tui") {
			fail(`${inputSurfaceFrame.path}: frame seam may only import public pi-tui helpers, not ${specifier}`);
		}
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${inputSurfaceFrame.path}: frame seam must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${inputSurfaceFrame.path}: frame seam must not import UI/runtime/state/config/provider module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${inputSurfaceFrame.path}: frame seam must not import ${specifier}`);
	}
	if (!imports.includes("./surface-layout.js")) fail(`${inputSurfaceFrame.path}: frame seam should centralize low-level surface-layout frame primitives`);
	if (!imports.includes("./status-line.js")) fail(`${inputSurfaceFrame.path}: frame seam should own default status-line placement`);
	if (!imports.includes("./bottom-details.js")) fail(`${inputSurfaceFrame.path}: frame seam should own bottom-right details placement`);
	if (!inputSurfaceFrame.text.includes("export function measureInputSurfaceFrame") || !inputSurfaceFrame.text.includes("export function renderInputSurfaceFrame")) {
		fail(`${inputSurfaceFrame.path}: frame seam should expose measurement and render entrypoints`);
	}
	if (!inputSurfaceFrame.text.includes("ResolvedGlanceStyles")) fail(`${inputSurfaceFrame.path}: frame seam should accept resolved styles directly`);
	if (/GlanceRenderStyleContext|resolveGlanceRenderStyles|readPiUiTheme|createPiRenderStyleContext|enablePiThemeStyles|resolvePiThemeStyles|PiThemeLike|ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(inputSurfaceFrame.text)) {
		fail(`${inputSurfaceFrame.path}: frame seam must not depend on Pi theme provider/product APIs`);
	}
	if (!/renderGlanceLine\([\s\S]*?\{ styles: input\.styles \}/.test(inputSurfaceFrame.text)) fail(`${inputSurfaceFrame.path}: default status rendering should pass resolved styles into status-line`);
	if (/\bPALETTES\b|(^|[^.\w$])fg\s*\(/.test(inputSurfaceFrame.text)) fail(`${inputSurfaceFrame.path}: frame seam must not style through direct palette/fg access`);
}

function assertProductionFrameCompositionSeam(files: SourceFile[]): void {
	const productionFiles = files.filter((candidate) => !candidate.path.startsWith("scripts/"));
	const allowedSurfaceLayoutConsumers = new Set([INPUT_SURFACE_FRAME_MODULE, "editor.ts"]);
	for (const file of productionFiles) {
		if (!importSpecifiers(file).includes("./surface-layout.js")) continue;
		const moduleName = basename(file.path);
		if (!allowedSurfaceLayoutConsumers.has(moduleName)) {
			fail(`${file.path}: production frame composition must go through input-surface-frame, not surface-layout directly`);
		}
	}

	const renderer = files.find((candidate) => basename(candidate.path) === "renderer.ts");
	assert.ok(renderer, "renderer.ts preview/static render seam should exist");
	const rendererImports = importSpecifiers(renderer);
	if (!rendererImports.includes("./input-surface-frame.js")) fail(`${renderer.path}: renderer preview path must import input-surface-frame`);
	if (rendererImports.includes("./surface-layout.js") || rendererImports.includes("./status-line.js")) {
		fail(`${renderer.path}: renderer preview path must not import surface-layout or status-line directly`);
	}
	assertNoLowLevelFrameCompositionTokens(renderer, "renderer preview path");
	if (/\brenderGlanceLine\b/.test(renderer.text)) fail(`${renderer.path}: renderer preview path should receive status rendering through input-surface-frame`);

	const editor = files.find((candidate) => basename(candidate.path) === "editor.ts");
	assert.ok(editor, "editor.ts live input surface seam should exist");
	const editorImports = importSpecifiers(editor);
	if (!editorImports.includes("./input-surface-frame.js")) fail(`${editor.path}: editor live path must import input-surface-frame`);
	assertNoLowLevelFrameCompositionTokens(editor, "editor live path");
	if (editorImports.includes("./surface-layout.js")) {
		const names = namedImportsFrom(editor, "./surface-layout.js");
		assert.deepEqual(names, ["formatSurfaceScrollIndicator"], `${editor.path}: editor may only import formatSurfaceScrollIndicator from surface-layout for scroll adapter extraction`);
	}
}

function assertRuntimePlanExecutorSeam(files: SourceFile[]): void {
	const executor = files.find((candidate) => basename(candidate.path) === RUNTIME_PLAN_EXECUTOR_MODULE);
	assert.ok(executor, "runtime-plan-executor.ts plan execution seam should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-coding-agent", "./runtime-policy.js", "./runtime-snapshot.js", "./state.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./runtime.js",
		"./runtime-refresh-session.js",
		"./throughput-run-tracker.js",
		"./input-surface-frame.js",
		"./surface-layout.js",
		"./status-line.js",
		"./renderer.js",
		"./editor.js",
		"./pane.js",
		"./footer.js",
		"./segments.js",
		"./config.js",
		"./config-schema.js",
		"./config-options.js",
		"./settings-catalog.js",
		"./pane-model.js",
		"./render-style-context.js",
		"./git.js",
		"./theme-adapter.js",
		"./themes.js",
		"./theme-catalog.js",
		"./palette.js",
	]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of executor.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-coding-agent") {
			fail(`${executor.path}: plan executor may only type-import public pi coding-agent types, not ${specifier}`);
		}
		if (specifier === "@earendil-works/pi-coding-agent" && !isTypeOnly) fail(`${executor.path}: pi coding-agent import must be type-only`);
		if (specifier === "./runtime-policy.js" && !isTypeOnly) fail(`${executor.path}: runtime-policy import should stay type-only; RuntimeRefreshSession chooses plans`);
		if (specifier === "./types.js" && !isTypeOnly) fail(`${executor.path}: types import must be type-only`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${executor.path}: plan executor must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${executor.path}: plan executor must not import runtime/session/UI/config/git/theme/throughput module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${executor.path}: plan executor must not import ${specifier}`);
	}
	if (!executor.text.includes("interface RuntimePlanExecutionInput")) fail(`${executor.path}: plan executor should expose an explicit input interface`);
	if (!executor.text.includes("applyRuntimeRefreshPlan")) fail(`${executor.path}: plan executor should expose applyRuntimeRefreshPlan`);
	for (const mode of ["reliable", "lifecycle", "message", "thinking", "compact", "none"] as const) {
		if (!executor.text.includes(`\"${mode}\"`)) fail(`${executor.path}: plan executor should handle ${mode} snapshot mode`);
	}
	if (/GitRefresher|readPiUiTheme|resolveRuntimeRenderStyleContext|ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(executor.text)) {
		fail(`${executor.path}: plan executor must not depend on git implementation, UI, or Pi theme provider APIs`);
	}
}

function assertRuntimeRefreshSessionSeam(files: SourceFile[]): void {
	const session = files.find((candidate) => basename(candidate.path) === RUNTIME_REFRESH_SESSION_MODULE);
	assert.ok(session, "runtime-refresh-session.ts state refresh session seam should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-coding-agent", "./runtime-plan-executor.js", "./runtime-policy.js", "./runtime-snapshot.js", "./state.js", "./throughput-run-tracker.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./runtime.js",
		"./input-surface-frame.js",
		"./surface-layout.js",
		"./status-line.js",
		"./renderer.js",
		"./editor.js",
		"./pane.js",
		"./footer.js",
		"./segments.js",
		"./config.js",
		"./config-schema.js",
		"./config-options.js",
		"./settings-catalog.js",
		"./pane-model.js",
		"./render-style-context.js",
		"./git.js",
		"./theme-adapter.js",
		"./themes.js",
		"./theme-catalog.js",
		"./palette.js",
	]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of session.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-coding-agent") {
			fail(`${session.path}: refresh session may only type-import public pi coding-agent types, not ${specifier}`);
		}
		if (specifier === "@earendil-works/pi-coding-agent" && !isTypeOnly) fail(`${session.path}: pi coding-agent import must be type-only`);
		if (specifier === "./types.js" && !isTypeOnly) fail(`${session.path}: types import must be type-only`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${session.path}: refresh session must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${session.path}: refresh session must not import runtime/UI/config/git/theme module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${session.path}: refresh session must not import ${specifier}`);
	}
	if (!session.text.includes("class RuntimeRefreshSession")) fail(`${session.path}: refresh session should expose RuntimeRefreshSession class`);
	for (const member of ["getState", "ensureState", "resetState", "execute", "messageEnd", "turnEnd", "agentStart", "agentEnd", "resetAccumulators", "sessionStart", "sessionShutdown", "clearContextUnknownAfterKnownAssistantUsage", "applyGitSnapshot"] as const) {
		if (!session.text.includes(member)) fail(`${session.path}: refresh session should expose ${member}`);
	}
	if (!session.text.includes("unknownContextAfterLatestCompaction")) fail(`${session.path}: refresh session should own context-unknown state`);
	if (!session.text.includes("beforeRender")) fail(`${session.path}: refresh session should own beforeRender ordering around plan execution and final render`);
	if (!session.text.includes("applyRuntimeRefreshPlan")) fail(`${session.path}: refresh session should delegate plan application to runtime-plan-executor`);
	if (!session.text.includes("setGitSnapshot")) fail(`${session.path}: refresh session should own git snapshot state application`);
	if (!session.text.includes("ThroughputRunTracker")) fail(`${session.path}: refresh session should own throughput run tracking after Slice 2C`);
	if (!session.text.includes("setCurrentRunThroughput") || !session.text.includes("setLastTurnThroughput") || !session.text.includes("clearCurrentRunThroughput")) fail(`${session.path}: refresh session should own throughput state intent application after Slice 2C`);
	if (!session.text.includes("appliedAssistantMessageObjects") || !session.text.includes("appliedAssistantMessageResponseIds")) fail(`${session.path}: refresh session should own assistant message dedupe accumulators after Slice 2C`);
	if (!session.text.includes("usageTotalsFromSessionMessage") || !session.text.includes("addUsageTotals")) fail(`${session.path}: refresh session should own assistant and nested tool usage delta accumulation`);
	if (/GitRefresher|readPiUiTheme|resolveRuntimeRenderStyleContext|ctx\.ui\.theme|ctx\.ui\.setTheme|getAllThemes|getTheme\s*\(|setTheme\s*\(/.test(session.text)) {
		fail(`${session.path}: refresh session must not depend on git implementation, UI, or Pi theme provider APIs`);
	}
}

function assertRuntimeSnapshotAdapterSeam(files: SourceFile[]): void {
	const runtimeSnapshot = files.find((candidate) => basename(candidate.path) === RUNTIME_SNAPSHOT_MODULE);
	assert.ok(runtimeSnapshot, "runtime-snapshot.ts state input adapter seam should exist");

	const forbiddenLocalSpecifiers = new Set(["./runtime.js", "./runtime-policy.js", "./runtime-plan-executor.js", "./runtime-refresh-session.js", "./state.js"]);
	const forbiddenRenderModulePattern = /(?:^|\/)(?:editor|renderer|pane|segments|surface-layout|input-surface-frame|status-line|footer)(?:\.js)?$/;
	const importPattern = /import\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of runtimeSnapshot.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-")) {
			if (specifier !== "@earendil-works/pi-coding-agent") fail(`${runtimeSnapshot.path}: runtime-snapshot may only import the public pi coding-agent entry, not ${specifier}`);
			if (!isTypeOnly && (!runtimeSnapshot.text.includes("SettingsManager") || !runtimeSnapshot.text.includes("getAgentDir"))) {
				fail(`${runtimeSnapshot.path}: runtime value imports are limited to public SettingsManager/getAgentDir runtime facts`);
			}
			continue;
		}
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${runtimeSnapshot.path}: runtime-snapshot must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier) || forbiddenRenderModulePattern.test(specifier)) fail(`${runtimeSnapshot.path}: runtime-snapshot must not import runtime/session/executor/state/render/UI module ${specifier}`);
	}
}

function assertRuntimePolicyPureModule(files: SourceFile[]): void {
	const runtimePolicy = files.find((candidate) => basename(candidate.path) === RUNTIME_POLICY_MODULE);
	assert.ok(runtimePolicy, "runtime-policy.ts pure policy table should exist");

	const forbiddenLocalModules = new Set([
		"./runtime.js",
		"./runtime-plan-executor.js",
		"./runtime-refresh-session.js",
		"./runtime-snapshot.js",
		"./state.js",
		"./editor.js",
		"./renderer.js",
		"./pane.js",
		"./footer.js",
		"./surface-layout.js",
		"./input-surface-frame.js",
		"./status-line.js",
		"./segments.js",
		"./git.js",
		"./config.js",
	]);
	for (const specifier of importSpecifiers(runtimePolicy)) {
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${runtimePolicy.path}: runtime policy must not import pi/TUI package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${runtimePolicy.path}: runtime policy must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalModules.has(specifier)) fail(`${runtimePolicy.path}: runtime policy must not import runtime/state/render/config module ${specifier}`);
		fail(`${runtimePolicy.path}: runtime policy table should be import-free, found ${specifier}`);
	}
}

function assertRuntimeStateSnapshotFrameBoundary(files: SourceFile[]): void {
	const runtime = files.find((candidate) => basename(candidate.path) === "runtime.ts");
	assert.ok(runtime, "runtime.ts should exist");
	const runtimeImports = importSpecifiers(runtime);
	if (!runtimeImports.includes("./runtime-refresh-session.js")) fail(`${runtime.path}: runtime should delegate refresh state ownership to runtime-refresh-session`);
	if (runtimeImports.includes("./runtime-policy.js")) fail(`${runtime.path}: runtime should not import runtime-policy directly; refresh session should choose plans`);
	if (runtimeImports.includes("./runtime-plan-executor.js")) fail(`${runtime.path}: runtime should not import runtime-plan-executor directly after refresh session extraction`);
	if (runtimeImports.includes("./runtime-snapshot.js")) fail(`${runtime.path}: runtime should not import runtime-snapshot directly after accumulator migration`);
	if (runtimeImports.includes("./throughput-run-tracker.js")) fail(`${runtime.path}: runtime should not import throughput tracker directly after accumulator migration`);
	if (runtimeImports.includes("./state.js")) fail(`${runtime.path}: runtime should not import state mutators directly after accumulator migration`);
	if (/plan\.snapshot|snapshot\s*===\s*["'](?:reliable|lifecycle|message|thinking|compact|none)["']/.test(runtime.text)) {
		fail(`${runtime.path}: runtime must not contain snapshot-mode branching after plan executor extraction`);
	}
	if (/let\s+state\s*:|unknownContextAfterLatestCompaction|stateInputsFromContext|thinkingInputsFromContext|lifecycleInputsFromContext|compactInputsFromContext|assistantMessageHasKnownContextUsage|createInitialState|setGitSnapshot|setUsageTotals|refreshContextUsage|clearContextUsage|refreshModel|refreshWorkspace|setProviderCount|usageTotalsFromAssistantMessage|addUsageTotals|ThroughputRunTracker|setCurrentRunThroughput|setLastTurnThroughput|clearCurrentRunThroughput/.test(runtime.text)) {
		fail(`${runtime.path}: runtime must not own refresh state core after RuntimeRefreshSession extraction`);
	}
	const forbiddenRuntimeFrameSpecifiers = new Set(["./input-surface-frame.js", "./surface-layout.js", "./status-line.js", "./renderer.js", "./pane.js", "./segments.js"]);
	for (const specifier of runtimeImports) {
		if (forbiddenRuntimeFrameSpecifiers.has(specifier)) fail(`${runtime.path}: runtime must not import frame composition/render modules directly (${specifier})`);
	}

	const forbiddenPureStateRenderSpecifiers = new Set([
		"./runtime-plan-executor.js",
		"./runtime-refresh-session.js",
		"./input-surface-frame.js",
		"./surface-layout.js",
		"./status-line.js",
		"./renderer.js",
		"./editor.js",
		"./pane.js",
		"./segments.js",
		"./footer.js",
	]);
	for (const moduleName of [STATE_MODULE, RUNTIME_SNAPSHOT_MODULE, RUNTIME_POLICY_MODULE]) {
		const file = files.find((candidate) => basename(candidate.path) === moduleName);
		assert.ok(file, `${moduleName} should exist`);
		for (const specifier of importSpecifiers(file)) {
			if (forbiddenPureStateRenderSpecifiers.has(specifier)) fail(`${file.path}: state/snapshot/policy modules must not import render module ${specifier}`);
		}
	}
}

function assertStatusLineSeamImports(files: SourceFile[]): void {
	const statusLine = files.find((candidate) => basename(candidate.path) === STATUS_LINE_MODULE);
	assert.ok(statusLine, "status-line.ts render seam should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-tui", "./context-risk.js", "./palette.js", "./segment-registry.js", "./segments.js", "./theme-adapter.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./renderer.js",
		"./surface-layout.js",
		"./input-surface-frame.js",
		"./editor.js",
		"./pane.js",
		"./runtime.js",
		"./runtime-snapshot.js",
		"./state.js",
		"./footer.js",
		"./config.js",
		"./settings-catalog.js",
	]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of statusLine.text.matchAll(importPattern)) {
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-tui") {
			fail(`${statusLine.path}: status-line may only import public pi-tui helpers, not ${specifier}`);
		}
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${statusLine.path}: status-line must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${statusLine.path}: status-line must not import UI/runtime/state/config module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${statusLine.path}: status-line must not import ${specifier}`);
	}
	if (!statusLine.text.includes("resolveGlanceRenderStyles(config.theme, styleContext)")) fail(`${statusLine.path}: status-line styling should resolve config.theme pair through the shared adapter context`);
	if (/selectGlanceTheme\(config\.theme,\s*["']light["']\)/.test(statusLine.text)) fail(`${statusLine.path}: status-line must not hardcode the light theme slot bridge`);
	if (/\bPALETTES\b|(^|[^.\w$])fg\s*\(/.test(statusLine.text)) fail(`${statusLine.path}: status-line must not style through direct palette/fg access after adapter wiring`);
}

function assertRendererSeamImports(files: SourceFile[]): void {
	const renderer = files.find((candidate) => basename(candidate.path) === "renderer.ts");
	assert.ok(renderer, "renderer.ts preview/static render seam should exist");

	const allowedSpecifiers = new Set(["./input-surface-frame.js", "./theme-adapter.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./surface-layout.js",
		"./status-line.js",
		"./editor.js",
		"./pane.js",
		"./runtime.js",
		"./runtime-snapshot.js",
		"./state.js",
		"./footer.js",
		"./config.js",
		"./settings-catalog.js",
		"./palette.js",
	]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of renderer.text.matchAll(importPattern)) {
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-tui") {
			fail(`${renderer.path}: renderer may only import public pi-tui helpers, not ${specifier}`);
		}
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${renderer.path}: renderer must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${renderer.path}: renderer must not import UI/runtime/state/config/palette module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${renderer.path}: renderer must not import ${specifier}`);
	}
	if (!renderer.text.includes("resolveGlanceRenderStyles(config.theme, options)")) fail(`${renderer.path}: renderer styling should resolve config.theme pair through the shared adapter context`);
	if (/selectGlanceTheme\(config\.theme,\s*["']light["']\)/.test(renderer.text)) fail(`${renderer.path}: renderer must not hardcode the light theme slot bridge`);
	if (!renderer.text.includes("renderInputSurfaceFrame")) fail(`${renderer.path}: renderer preview path should delegate frame assembly to input-surface-frame`);
	assertNoLowLevelFrameCompositionTokens(renderer, "renderer preview path");
	if (/\brenderGlanceLine\b/.test(renderer.text)) fail(`${renderer.path}: renderer must not call status-line directly after frame seam migration`);
	if (/\bPALETTES\b|(^|[^.\w$])fg\s*\(/.test(renderer.text)) fail(`${renderer.path}: renderer must not style through direct palette/fg access after adapter wiring`);
}

function assertEditorSeamImports(files: SourceFile[]): void {
	const editor = files.find((candidate) => basename(candidate.path) === "editor.ts");
	assert.ok(editor, "editor.ts live input surface seam should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "./format.js", "./input-surface-frame.js", "./status-line.js", "./surface-layout.js", "./theme-adapter.js", "./types.js"]);
	const forbiddenLocalSpecifiers = new Set([
		"./renderer.js",
		"./pane.js",
		"./runtime.js",
		"./runtime-snapshot.js",
		"./state.js",
		"./footer.js",
		"./config.js",
		"./settings-catalog.js",
		"./palette.js",
	]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of editor.text.matchAll(importPattern)) {
		const specifier = match[2]!;
		if (specifier.startsWith("@earendil-works/pi-") && specifier !== "@earendil-works/pi-coding-agent" && specifier !== "@earendil-works/pi-tui") {
			fail(`${editor.path}: editor may only import public pi coding-agent/pi-tui helpers, not ${specifier}`);
		}
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${editor.path}: editor must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalSpecifiers.has(specifier)) fail(`${editor.path}: editor must not import UI/runtime/state/config/palette module ${specifier}`);
		if (!allowedSpecifiers.has(specifier)) fail(`${editor.path}: editor must not import ${specifier}`);
	}
	if (!editor.text.includes("resolveGlanceRenderStyles(config.theme, this.glanceOptions?.renderStyleContext)")) fail(`${editor.path}: editor styling should resolve config.theme pair through the shared adapter context`);
	if (/selectGlanceTheme\(config\.theme,\s*["']light["']\)/.test(editor.text)) fail(`${editor.path}: editor must not hardcode the light theme slot bridge`);
	if (!editor.text.includes("measureInputSurfaceFrame") || !editor.text.includes("renderInputSurfaceFrame")) fail(`${editor.path}: editor live frame path should delegate frame metrics/assembly to input-surface-frame`);
	if (!/renderGlanceLine\([\s\S]*?\{ styles \}/.test(editor.text)) fail(`${editor.path}: editor cached status callback should pass its render-pass styles into status-line rendering`);
	if (!editor.text.includes("cachedStatusStyleKey") || !editor.text.includes("styles.cacheKey")) fail(`${editor.path}: editor status cache should include style cacheKey awareness`);
	assertNoLowLevelFrameCompositionTokens(editor, "editor live path");
	if (importSpecifiers(editor).includes("./surface-layout.js")) {
		const names = namedImportsFrom(editor, "./surface-layout.js");
		assert.deepEqual(names, ["formatSurfaceScrollIndicator"], `${editor.path}: editor may only keep formatSurfaceScrollIndicator from surface-layout for scroll-indicator adaptation`);
	}
	if (!/handleInput\(data: string\): void\s*{[\s\S]*?super\.handleInput\(data\)/.test(editor.text)) fail(`${editor.path}: GlanceEditor.handleInput must continue delegating raw input to CustomEditor`);
	if (editor.text.includes("interface GlanceEditorOptions extends EditorOptions")) fail(`${editor.path}: GlanceEditorOptions must not extend Pi EditorOptions; keep pi-glance render options separate`);
	if (!editor.text.includes("readonly editorOptions?: EditorOptions") || !editor.text.includes("readonly renderStyleContext?: GlanceRenderStyleContext")) fail(`${editor.path}: GlanceEditorOptions should wrap Pi editorOptions separately from renderStyleContext`);
	if (!editor.text.includes("super(tui, theme, appKeybindings, glanceOptions?.editorOptions)")) fail(`${editor.path}: GlanceEditor must pass only editorOptions through to CustomEditor`);
	if (/super\(tui, theme, appKeybindings, glanceOptions\)/.test(editor.text)) fail(`${editor.path}: GlanceEditor must not pass pi-glance renderStyleContext through to CustomEditor`);
	if (/\bPALETTES\b|(^|[^.\w$])fg\s*\(/.test(editor.text)) fail(`${editor.path}: editor must not style through direct palette/fg access after adapter wiring`);
}

function assertStatusLineConsumers(files: SourceFile[]): void {
	const renderer = files.find((candidate) => basename(candidate.path) === "renderer.ts");
	assert.ok(renderer, "renderer.ts should exist");
	const editor = files.find((candidate) => basename(candidate.path) === "editor.ts");
	assert.ok(editor, "editor.ts should exist");

	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	const rendererImports = [...renderer.text.matchAll(importPattern)].map((match) => match[1]!);
	if (rendererImports.includes("./segments.js")) fail(`${renderer.path}: renderer must not import ./segments.js after status-line split`);
	if (rendererImports.includes("./segment-registry.js")) fail(`${renderer.path}: renderer must not import ./segment-registry.js after status-line split`);
	if (rendererImports.includes("./status-line.js")) fail(`${renderer.path}: renderer should receive status rendering through input-surface-frame after Slice 1B`);
	assert.ok(rendererImports.includes("./input-surface-frame.js"), "renderer.ts should import input-surface-frame seam for preview frame assembly");

	const editorImports = [...editor.text.matchAll(importPattern)].map((match) => match[1]!);
	if (editorImports.includes("./renderer.js")) fail(`${editor.path}: editor must not import renderGlanceLine from renderer after status-line split`);
	assert.ok(editorImports.includes("./input-surface-frame.js"), "editor.ts should import input-surface-frame seam for live frame assembly");
	assert.ok(editorImports.includes("./status-line.js"), "editor.ts should still import status-line for cached live status rendering");
}

function assertStateModulePiFree(files: SourceFile[]): void {
	const state = files.find((candidate) => basename(candidate.path) === STATE_MODULE);
	assert.ok(state, "state.ts should exist");

	const importPattern = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of state.text.matchAll(importPattern)) {
		const specifier = match[1]!;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${state.path}: state module must not import pi package ${specifier}`);
	}
}

function assertFooterSeams(files: SourceFile[]): void {
	const footer = files.find((candidate) => basename(candidate.path) === FOOTER_MODULE);
	assert.ok(footer, "footer.ts status-preserving footer should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "./format.js", "./types.js"]);
	const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of footer.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (!allowedSpecifiers.has(specifier)) fail(`${footer.path}: footer must not import ${specifier}`);
		if (specifier === "@earendil-works/pi-coding-agent" && !isTypeOnly) fail(`${footer.path}: coding-agent footer data imports must stay type-only`);
	}
	if (!footer.text.includes("class StatusOnlyFooter")) fail(`${footer.path}: should expose StatusOnlyFooter`);
	if (!footer.text.includes("getExtensionStatuses")) fail(`${footer.path}: should preserve statuses from other extensions`);
	if (/showDefaultStatus|renderDefaultStatusRows|footerWorkspace|footerStats|footerModel/.test(footer.text)) {
		fail(`${footer.path}: must not support restoring Pi's two informational rows`);
	}
	for (const specifier of importSpecifiers(footer)) {
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${footer.path}: footer render path must not perform IO/network/process work`);
	}
}

function assertProviderCountSnapshotSeam(files: SourceFile[]): void {
	const runtimeSnapshot = files.find((candidate) => basename(candidate.path) === RUNTIME_SNAPSHOT_MODULE);
	assert.ok(runtimeSnapshot, "runtime-snapshot.ts state input adapter seam should exist");
	if (!/modelRegistry[\s\S]*?getAvailable/.test(runtimeSnapshot.text)) fail(`${runtimeSnapshot.path}: provider count should derive from ctx.modelRegistry.getAvailable()`);
	if (!/new Set<string>\(\)/.test(runtimeSnapshot.text)) fail(`${runtimeSnapshot.path}: provider count should deduplicate provider names`);
}

function assertIndexThinWiring(files: SourceFile[]): void {
	const index = files.find((candidate) => basename(candidate.path) === INDEX_MODULE);
	assert.ok(index, "index.ts should exist");

	const allowedSpecifiers = new Set(["@earendil-works/pi-coding-agent", "./config.js", "./pane.js", "./runtime.js"]);
	const importPattern = /import\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of index.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (!allowedSpecifiers.has(specifier)) fail(`${index.path}: thin extension wiring must not import ${specifier}`);
		if (specifier === "@earendil-works/pi-coding-agent" && !isTypeOnly) fail(`${index.path}: pi coding-agent import must be type-only`);
	}
}

function assertPackageRuntimeRefreshTestWiring(packageJsonFile: SourceFile): void {
	const packageJson = JSON.parse(packageJsonFile.text) as { scripts?: Record<string, string> };
	const scripts = packageJson.scripts ?? {};
	const expectedDedicatedScripts = new Map([
		["test:runtime:plan-executor", "node .tmp-git-dev/scripts/test-runtime-plan-executor.js"],
		["test:runtime:refresh-session", "node .tmp-git-dev/scripts/test-runtime-refresh-session.js"],
	]);
	const testDev = scripts["test:dev"] ?? "";
	for (const [scriptName, target] of expectedDedicatedScripts) {
		const script = scripts[scriptName];
		if (!script) fail(`package.json: missing ${scriptName} script for runtime refresh seam validation`);
		if (!script.includes("pnpm --silent build:dev")) fail(`package.json: ${scriptName} should build test artifacts before running`);
		if (!script.includes(target)) fail(`package.json: ${scriptName} should run ${target}`);
		if (!testDev.includes(target)) fail(`package.json: test:dev should include ${target}`);
	}
}

function assertSegmentDisplayPrimitivesPureModule(files: SourceFile[]): void {
	const primitives = files.find((candidate) => basename(candidate.path) === SEGMENT_DISPLAY_PRIMITIVES_MODULE);
	assert.ok(primitives, "segment-display-primitives.ts pure display primitive module should exist");
	for (const specifier of importSpecifiers(primitives)) {
		fail(`${primitives.path}: display primitives should be import-free, found ${specifier}`);
	}
	for (const helper of ["formatTokens", "formatPercent", "formatCost"] as const) {
		if (!primitives.text.includes(`export function ${helper}`)) fail(`${primitives.path}: should export ${helper}`);
	}
}

function assertConfigOptionsPureModule(files: SourceFile[]): void {
	const configOptions = files.find((candidate) => basename(candidate.path) === PURE_CONFIG_OPTIONS_MODULE);
	assert.ok(configOptions, "config-options.ts pure option source should exist");

	const forbiddenLocalModules = new Set(["./config.js", "./settings-catalog.js", "./pane.js", "./editor.js", "./renderer.js", "./runtime-plan-executor.js", "./runtime-refresh-session.js", "./surface-layout.js", "./input-surface-frame.js", "./status-line.js"]);
	const importPattern = /import\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
	for (const match of configOptions.text.matchAll(importPattern)) {
		const isTypeOnly = match[1] === "type ";
		const specifier = match[2]!;
		if (specifier === "./types.js") {
			if (!isTypeOnly) fail(`${configOptions.path}: config-options may only type-import from ./types.js`);
			continue;
		}
		if (specifier === "./config-schema.js") continue;
		if (specifier.startsWith("@earendil-works/pi-")) fail(`${configOptions.path}: pure option source must not import pi package ${specifier}`);
		if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${configOptions.path}: pure option source must not import IO/network/process module ${specifier}`);
		if (forbiddenLocalModules.has(specifier)) fail(`${configOptions.path}: pure option source must not import runtime/config/catalog module ${specifier}`);
		fail(`${configOptions.path}: pure option source must not import ${specifier}`);
	}
}

const sourceFiles = await readSourceFiles();
const packageFiles: SourceFile[] = [{ path: "package.json", text: await readText("package.json") }];

assertNoLegacyNamespace(sourceFiles);
assertNoLegacyPiPackages(packageFiles);
assertPublicPiImports(sourceFiles);
assertNoCorePatching(sourceFiles);
assertSurfaceLayoutSeamImports(sourceFiles);
assertSettingsCatalogSeamImports(sourceFiles);
assertPaneModelSeamImports(sourceFiles);
assertThemeAdapterSeamImports(sourceFiles);
assertThemeSelectionSeamImports(sourceFiles);
assertThemeToneSeamImports(sourceFiles);
assertPiThemeResolverAdapterOnly(sourceFiles);
assertRenderStyleContextSeam(sourceFiles);
assertThemePairGuardrails(sourceFiles);
assertPiThemeRuntimeProviderBoundary(sourceFiles);
assertPanePreviewStyleContextBoundary(sourceFiles);
assertRenderModulesHaveNoIo(sourceFiles);
assertInputSurfaceFrameSeamImports(sourceFiles);
assertProductionFrameCompositionSeam(sourceFiles);
assertRuntimePlanExecutorSeam(sourceFiles);
assertRuntimeRefreshSessionSeam(sourceFiles);
assertRuntimeSnapshotAdapterSeam(sourceFiles);
assertRuntimePolicyPureModule(sourceFiles);
assertRuntimeStateSnapshotFrameBoundary(sourceFiles);
assertStatusLineSeamImports(sourceFiles);
assertRendererSeamImports(sourceFiles);
assertEditorSeamImports(sourceFiles);
assertStatusLineConsumers(sourceFiles);
assertStateModulePiFree(sourceFiles);
assertFooterSeams(sourceFiles);
assertProviderCountSnapshotSeam(sourceFiles);
assertIndexThinWiring(sourceFiles);
assertSegmentDisplayPrimitivesPureModule(sourceFiles);
assertConfigOptionsPureModule(sourceFiles);
assertPackageRuntimeRefreshTestWiring(packageFiles[0]!);

console.log("✓ public import and render-boundary guard checks passed");
