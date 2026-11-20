import { strict as assert } from "node:assert";
import { defaultConfig } from "../config.js";
import { PALETTES, fg } from "../palette.js";
import { readPiAmbientTone } from "../theme-tone.js";
import { createGitHarness, createRuntimeHarness, createRuntimeTestContext, invokeEditorFactory } from "./runtime-harness.js";

// The same object and name deliberately survive the appearance change.
const theme = {
	name: "system", appearance: "dark" as "dark" | "light",
	fg(_token: string, text: string) { return `<<${this.appearance}:${text}>>`; },
};
assert.equal(readPiAmbientTone({ theme: { name: "dark", appearance: "light" } }), "light", "appearance takes precedence over a misleading name");
assert.equal(readPiAmbientTone({ theme: { name: "light" } }), "light", "older themes retain exact-name fallback");
assert.equal(readPiAmbientTone({ theme: { name: "custom-dark" } }), "unknown", "no substring guessing");

for (const colorSource of ["pi", "glance"] as const) {
	const config = defaultConfig();
	config.colorSource = colorSource;
	const test = createRuntimeTestContext({ uiTheme: theme });
	const harness = createRuntimeHarness({ loadConfigSyncConfig: config, git: createGitHarness() });
	harness.runtime.events.sessionStart({}, test.ctx);
	const editor = invokeEditorFactory(test, 0, () => {}) as { focused: boolean; setText(text: string): void; handleInput(data: string): void; render(width: number): string[] };
	editor.focused = true;
	editor.setText("appearance input");
	const entries = test.getEntryReads();
	const branch = test.getBranchReads();
	theme.appearance = "dark";
	const dark = editor.render(100).join("\n");
	theme.appearance = "light";
	const light = editor.render(100).join("\n");
	assert.notEqual(light, dark, `${colorSource}: actual editor output invalidates at unchanged width/name/object`);
	if (colorSource === "pi") {
		assert.ok(dark.includes("<<dark:"));
		assert.ok(light.includes("<<light:"));
		assert.equal(light.includes("<<dark:"), false, "no stale cached Pi ANSI");
	} else {
		assert.ok(dark.includes(fg(PALETTES.dark.title, " repo ")));
		assert.ok(light.includes(fg(PALETTES.light.title, " repo ")));
	}
	editor.handleInput("!");
	assert.ok(editor.render(100).join("\n").includes("appearance input!"), "real editor input remains editable after theme change");
	for (const width of [40, 80, 100, 80, 100]) editor.render(width);
	assert.equal(test.getEntryReads(), entries, "render/input/resize/theme do not read history");
	assert.equal(test.getBranchReads(), branch, "render/input/resize/theme do not read branch");
	harness.runtime.events.sessionShutdown({}, test.ctx);
}
console.log("✓ appearance priority/fallback and same-object Pi/Glance live editor cache, input, resize checks passed");
