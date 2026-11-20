import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config.js";
import { resolvePiThemeStyles } from "../theme-adapter.js";
import { readPiAmbientTone } from "../theme-tone.js";
import type { ColorSource } from "../types.js";
import { createWorkingIndicatorController } from "../working-indicator.js";

type Appearance = "light" | "dark";
type Theme = Parameters<typeof resolvePiThemeStyles>[0];
type Controller = ReturnType<typeof createWorkingIndicatorController>;
type Context = Parameters<Controller["apply"]>[0];
type StyleContext = NonNullable<Parameters<Controller["apply"]>[1]>;
type IndicatorOptions = { frames?: string[]; intervalMs?: number };

// Boundary double: one stable system-theme proxy, not a real TTY/OS notification.
// Every token deliberately has a different RGB value between appearances.
function systemThemeDouble() {
	let appearance: Appearance = "light";
	const target: Theme = {
		name: "system",
		appearance: "light",
		fg(_token, text) {
			const rgb = appearance === "light" ? "24;48;72" : "216;192;168";
			return `\u001b[38;2;${rgb}m${text}\u001b[39m`;
		},
		bold: (text) => text,
		getColorMode: () => "truecolor",
	};
	const theme = new Proxy(target, {
		get(object, property, receiver) {
			return property === "appearance" ? appearance : Reflect.get(object, property, receiver);
		},
	});
	return { theme, setAppearance: (next: Appearance) => { appearance = next; } };
}

// Boundary double: advance each registered timer once without sleeping or using
// real timers. The callback belongs to the real controller, not this fixture.
function timerDouble() {
	let now = 1_000_000;
	const timers = new Map<object, { callback: () => void; milliseconds: number }>();
	return {
		nowMs: () => now,
		setInterval(callback: () => void, milliseconds: number): unknown {
			const handle = {};
			timers.set(handle, { callback, milliseconds });
			return handle;
		},
		clearInterval(handle: unknown) {
			timers.delete(handle as object);
		},
		tick() {
			assert.ok(timers.size > 0, "an active working cycle must schedule a refresh");
			const scheduled = [...timers.entries()];
			now += Math.max(...scheduled.map(([, timer]) => timer.milliseconds));
			for (const [handle, timer] of scheduled) {
				if (timers.has(handle)) timer.callback();
			}
		},
	};
}

// Observe actual installed spinner colors, not text messages or editor output.
// Ignore frame order and glyph movement so movement alone cannot satisfy a flip.
function frameColors(options: IndicatorOptions | undefined): string[] {
	assert.ok(options?.frames?.length, "the UI must receive nonempty spinner frames");
	const colors = [...new Set(options.frames.flatMap((frame) =>
		frame.match(/\u001b\[(?:(?:38|48);(?:2;\d+;\d+;\d+|5;\d+)|(?:3|4|9)\d|10[0-7])m/g) ?? [],
	))].sort();
	assert.ok(colors.length > 0, "installed spinner frames must contain ANSI colors");
	return colors;
}

test("explicit manual cache key completely overrides appearance-derived identity", () => {
	const fixture = systemThemeDouble();
	const keys = (["light", "dark", "light"] as const).map((appearance) => {
		fixture.setAppearance(appearance);
		return resolvePiThemeStyles(fixture.theme, { cacheKey: "manual" }).cacheKey;
	});
	assert.deepEqual(keys, ["pi:manual", "pi:manual", "pi:manual"]);
});

for (const colorSource of ["pi", "glance"] satisfies ColorSource[]) {
	test(`${colorSource}: active spinner follows stable system proxy light → dark → light without stable-tick reinstall`, (t) => {
		const config = defaultConfig();
		config.colorSource = colorSource;
		const fixture = systemThemeDouble();
		const originalTheme = fixture.theme;
		const clock = timerDouble();
		const received: (IndicatorOptions | undefined)[] = [];
		// Boundary double: this records SDK UI calls; it is not a complete SDK host
		// and does not claim to exercise a real terminal or system-theme event.
		const ui = {
			theme: fixture.theme,
			setWorkingMessage(_message?: string) {},
			setWorkingIndicator(options?: IndicatorOptions) {
				received.push(options ? {
					...options,
					frames: options.frames ? [...options.frames] : undefined,
				} : undefined);
			},
		};
		const ctx = { mode: "tui", ui } as unknown as Context;
		const styles: StyleContext = {
			getPiStyles: () => resolvePiThemeStyles(ui.theme),
			getAmbientTone: () => readPiAmbientTone(ui),
		};
		const controller = createWorkingIndicatorController({
			getConfig: () => config,
			getThinkingLevel: () => "off",
			getTerminalWidth: () => 100,
			random: () => 0.5,
			nowMs: clock.nowMs,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		});
		t.after(() => controller.shutdown());
		controller.apply(ctx, styles);
		controller.agentStart(ctx);
		controller.turnStart();
		let colors = frameColors(received.at(-1));

		function stableTicks() {
			const calls = received.length;
			clock.tick();
			clock.tick();
			assert.equal(received.length, calls, "unchanged appearance must not reinstall the spinner");
		}
		stableTicks();

		// No apply/start/settled between flips: this remains the same active cycle.
		for (const appearance of ["dark", "light"] as const) {
			const calls = received.length;
			fixture.setAppearance(appearance);
			assert.equal(ui.theme, originalTheme);
			assert.equal(ui.theme.name, "system");
			clock.tick();
			assert.ok(received.length > calls, `${appearance} must reinstall spinner frames on the active refresh path`);
			const nextColors = frameColors(received.at(-1));
			assert.notDeepEqual(nextColors, colors, `${appearance} must change spinner colors, not merely reinstall identical frames`);
			colors = nextColors;
			stableTicks();
		}
	});
}
