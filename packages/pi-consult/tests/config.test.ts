import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONSULT_CONFIG,
	loadConsultConfig,
	parseConsultConfig,
	saveConsultConfig,
	serializeConsultConfig,
} from "../src/config.ts";
import { getConsultPaths } from "../src/paths.ts";

const cleanup = new Set<string>();

afterEach(async () => {
	await Promise.all([...cleanup].map((directory) => rm(directory, { recursive: true, force: true })));
	cleanup.clear();
});

async function agentDir(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-consult-config-"));
	cleanup.add(directory);
	return directory;
}

describe("consult config", () => {
	it("defaults to an empty panel so off costs nothing", () => {
		expect(parseConsultConfig({})).toEqual(DEFAULT_CONSULT_CONFIG);
		expect(DEFAULT_CONSULT_CONFIG.panel).toEqual([]);
		expect(DEFAULT_CONSULT_CONFIG.gates).toEqual({ loop: 3 });
		expect(DEFAULT_CONSULT_CONFIG.budget).toEqual({ perTurn: 1, perSession: 8 });
	});

	it("parses panel, gates, budget, and disabledForModels", () => {
		expect(
			parseConsultConfig({
				panel: [{ model: "anthropic/claude-fable-5", effort: "high" }, { model: "openai-codex/gpt-5.6-sol" }],
				fanout: true,
				gates: { loop: 4 },
				budget: { perTurn: 2, perSession: 10 },
				disabledForModels: ["anthropic/claude-fable-5"],
			}),
		).toEqual({
			panel: [
				{ model: "anthropic/claude-fable-5", effort: "high" },
				{ model: "openai-codex/gpt-5.6-sol" },
			],
			fanout: true,
			gates: { loop: 4 },
			budget: { perTurn: 2, perSession: 10 },
			disabledForModels: ["anthropic/claude-fable-5"],
		});
	});

	it("drops invalid panel entries and treats loop false as off", () => {
		const parsed = parseConsultConfig({
			panel: [{ model: "" }, { effort: "high" }, { model: "ok", effort: "nope" }, { model: "keep/me", effort: "low" }],
			gates: { loop: false },
		});
		expect(parsed.panel).toEqual([{ model: "keep/me", effort: "low" }]);
		expect(parsed.gates.loop).toBe(0);
	});

	it("loads defaults when the file is missing", async () => {
		const directory = await agentDir();
		expect(await loadConsultConfig(directory)).toMatchObject({
			config: DEFAULT_CONSULT_CONFIG,
			path: getConsultPaths(directory).configFile,
			raw: {},
		});
	});

	it("preserves unknown fields on save", async () => {
		const directory = await agentDir();
		const configPath = getConsultPaths(directory).configFile;
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(configPath, `${JSON.stringify({ panel: [], note: "hand-edited", gates: { loop: 2 } })}\n`);

		const loaded = await loadConsultConfig(directory);
		expect(loaded.config.gates.loop).toBe(2);
		expect(loaded.raw.note).toBe("hand-edited");

		const next = { ...loaded.config, fanout: true };
		expect(await saveConsultConfig(next, directory, loaded.raw)).toBe(true);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
			fanout: true,
			note: "hand-edited",
			gates: { loop: 2 },
		});
	});

	it("warns and falls back for malformed JSON", async () => {
		const directory = await agentDir();
		const configPath = getConsultPaths(directory).configFile;
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(configPath, "{");
		const loaded = await loadConsultConfig(directory);
		expect(loaded.config).toEqual(DEFAULT_CONSULT_CONFIG);
		expect(loaded.warning).toMatch(/Invalid Consult config/);
	});

	it("serializes without inventing a guidance block", () => {
		expect(serializeConsultConfig(DEFAULT_CONSULT_CONFIG, { extra: 1 })).toMatchObject({ extra: 1, panel: [] });
		expect(serializeConsultConfig(DEFAULT_CONSULT_CONFIG, { extra: 1 }).guidance).toBeUndefined();
	});
});
