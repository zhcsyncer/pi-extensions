import { emptyGitSnapshot } from "../git.js";
import type { GlanceState } from "../types.js";

type GlanceStateOverrides = Omit<Partial<GlanceState>, "workspace" | "git" | "providers" | "model" | "runtime" | "context" | "usage" | "throughput"> & {
	workspace?: Partial<GlanceState["workspace"]>;
	git?: Partial<GlanceState["git"]>;
	providers?: Partial<GlanceState["providers"]>;
	model?: Partial<GlanceState["model"]>;
	runtime?: Partial<GlanceState["runtime"]>;
	context?: Partial<GlanceState["context"]>;
	usage?: Partial<GlanceState["usage"]>;
	throughput?: Partial<GlanceState["throughput"]>;
};

export function testState(overrides: GlanceStateOverrides = {}): GlanceState {
	const overrideRecord = overrides as GlanceStateOverrides & Record<string, unknown>;
	const base = {
		workspace: { name: "repo", path: "/repo" },
		git: emptyGitSnapshot(),
		providers: { availableCount: 1 },
		model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off", reasoning: true },
		runtime: {
			autoCompactEnabled: true,
		},
		context: { tokens: 46_800, window: 200_000, percent: 23.4 },
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 },
		throughput: { lastTurn: null, currentRun: null },
		version: 0,
	} as GlanceState & Record<string, unknown>;
	return {
		...base,
		...overrides,
		workspace: { ...base.workspace, ...overrides.workspace },
		git: { ...base.git, ...overrides.git },
		providers: { ...base.providers, ...overrides.providers },
		model: { ...base.model, ...overrides.model },
		runtime: { ...base.runtime, ...overrides.runtime },
		context: { ...base.context, ...overrides.context },
		usage: { ...base.usage, ...overrides.usage },
		throughput: { ...(base.throughput as object), ...((overrideRecord.throughput as object | undefined) ?? {}) },
	} as GlanceState;
}
