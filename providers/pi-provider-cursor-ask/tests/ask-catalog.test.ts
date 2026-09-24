import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  ASK_MODEL_SPECS,
  COMPOSER_ASK_SPECS,
  PASSTHROUGH_ASK_SPECS,
  buildAskCatalog,
  supportedAskThinkingLevels,
} from "../src/models/ask-catalog.js";
import type {
  CursorEffortMap,
  CursorModelRouting,
  ProcessedModel,
} from "../src/models/processing.js";
import { modelConfig, processModels } from "../src/models/processing.js";
import { modelsFromParameterizedMetadata } from "../src/models/parameterized.js";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import type { CursorModel } from "../src/stream/model-discovery.js";
import { resolveNativeReasoningEffort } from "../src/stream/pi-adapter.js";

type Level = "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: Level[] = ["low", "medium", "high", "xhigh", "max"];

function sourceModel(options: {
  id: string;
  requestedModelId: string;
  context: "1m";
  levels?: Level[];
  parameterized?: boolean;
}): ProcessedModel {
  const levels = options.levels ?? ALL_LEVELS;
  const effortMap: CursorEffortMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  const rawRoutingByEffort: Record<string, CursorModelRouting> = {};
  for (const level of levels) {
    effortMap[level] = level;
    rawRoutingByEffort[level] = {
      modelId:
        options.parameterized === false ? `${options.id}-${level}` : options.requestedModelId,
      ...(options.parameterized === false
        ? {}
        : {
            parameters: [
              { id: "thinking", value: "true" },
              { id: "context", value: options.context },
              { id: "effort", value: level },
              { id: "fast", value: "false" },
            ],
          }),
    };
  }

  return {
    id: options.id,
    name: options.id,
    reasoning: true,
    contextWindow: options.context === "1m" ? 1_000_000 : 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsEffort: true,
    effortMap,
    rawRoutingByEffort,
  };
}

function plainModel(id: string, name = id): ProcessedModel {
  return {
    id,
    name,
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsEffort: false,
  };
}

function parameters(route: CursorModelRouting): Record<string, string> {
  return Object.fromEntries((route.parameters ?? []).map(({ id, value }) => [id, value]));
}

function assertOpus55Routes(catalog: ProcessedModel[]): void {
  expect(catalog.filter((model) => model.id.startsWith("opus-5")).map(({ id }) => id)).toEqual([
    "opus-5.5",
    "opus-5",
  ]);
  const opus55 = catalog.find((model) => model.id === "opus-5.5")!;
  expect(opus55).toMatchObject({
    name: "Opus 5.5",
    requestedModelId: "claude-opus-5-5",
    contextWindow: 1_000_000,
    supportsImages: true,
    requiresMaxMode: true,
    requestedMaxMode: true,
  });
  expect(supportedAskThinkingLevels(opus55)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(parameters(opus55.rawRoutingByEffort!.medium!)).toEqual({
    context: "1m",
    effort: "medium",
    fast: "false",
  });
  expect(opus55.parameters).toEqual(opus55.rawRoutingByEffort!.medium!.parameters);
  const opus5 = catalog.find((model) => model.id === "opus-5")!;
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    expect(opus55.rawRoutingByEffort?.[level]).toEqual({
      modelId: "claude-opus-5-5",
      parameters: [
        { id: "context", value: "1m" },
        { id: "effort", value: level },
        { id: "fast", value: "false" },
      ],
      requiresMaxMode: true,
      requestedMaxMode: true,
    });
    expect(opus5.rawRoutingByEffort?.[level]?.modelId).toBe("claude-opus-5");
    expect(parameters(opus5.rawRoutingByEffort![level]!)).toEqual({
      thinking: "true",
      context: "1m",
      effort: level,
      fast: "false",
    });
  }
}

describe("Cursor Ask catalog contract", () => {
  it("always exposes the curated 1M Claude rows plus Composer 2.5 / Fast", () => {
    const catalog = buildAskCatalog([]);
    const claudeCount = ASK_MODEL_SPECS.length;

    expect(catalog.map(({ id, name }) => ({ id, name }))).toEqual([
      ...ASK_MODEL_SPECS.map(({ id, name }) => ({ id, name })),
      ...COMPOSER_ASK_SPECS.map(({ id, name }) => ({ id, name })),
    ]);
    expect(catalog).toHaveLength(claudeCount + COMPOSER_ASK_SPECS.length);
    expect(catalog.every((model) => model.reasoning && model.supportsEffort)).toBe(true);
    expect(catalog.slice(0, claudeCount).every((model) => model.effortMap?.off === null)).toBe(
      true,
    );
    expect(catalog.every((model) => model.effortMap?.minimal === null)).toBe(true);
    expect(catalog.slice(0, claudeCount).every((model) => model.contextWindow === 1_000_000)).toBe(
      true,
    );
    expect(
      catalog
        .slice(0, claudeCount)
        .some((model) => /200k|300k|\[1m\]|-1m$/i.test(`${model.id} ${model.name}`)),
    ).toBe(false);
  });

  it("keeps thinking=true for every level of the older Claude families", () => {
    const legacySpecs = ASK_MODEL_SPECS.filter((spec) => spec.id !== "opus-5.5");
    const sources = legacySpecs.map((spec) =>
      sourceModel({
        id: spec.candidates[0]!,
        requestedModelId: spec.requestedModelId,
        context: spec.context,
      }),
    );
    const catalog = buildAskCatalog(sources).filter((model) =>
      legacySpecs.some((spec) => spec.id === model.id),
    );

    for (const [index, model] of catalog.entries()) {
      const spec = legacySpecs[index]!;
      expect(supportedAskThinkingLevels(model)).toEqual(ALL_LEVELS);
      for (const level of ALL_LEVELS) {
        const route = model.rawRoutingByEffort?.[level];
        expect(route?.modelId).toBe(spec.requestedModelId);
        expect(parameters(route!)).toEqual({
          thinking: "true",
          context: spec.context,
          effort: level,
          fast: "false",
        });
        expect(route?.requiresMaxMode).toBe(spec.context === "1m");
        expect(route?.requestedMaxMode).toBe(spec.context === "1m");
      }
    }
  });

  it("routes live Opus 5.5 metadata through 1M without a thinking parameter", () => {
    const metadata: CursorParameterizedModel = {
      name: "claude-opus-5-5",
      serverModelName: "claude-opus-5-5",
      clientDisplayName: "Opus 5.5",
      supportsMaxMode: true,
      supportsNonMaxMode: true,
      supportsImages: true,
      contextTokenLimit: 300_000,
      contextTokenLimitForMaxMode: 1_000_000,
      variants: ["300k", "1m"].flatMap((context) =>
        ["low", "medium", "high", "xhigh", "max"].flatMap((effort) =>
          [false, true].map((fast) => ({
            parameters: [
              { id: "context", value: context },
              { id: "effort", value: effort },
              { id: "fast", value: String(fast) },
            ],
            isMaxMode: context === "1m" || fast,
            isDefaultNonMaxConfig: context === "300k" && effort === "medium" && !fast,
            isDefaultMaxConfig: context === "1m" && effort === "medium" && !fast,
          })),
        ),
      ),
    };
    const processed = processModels(modelsFromParameterizedMetadata([metadata]));
    expect(processed.map((model) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5-1m",
      "claude-opus-5-5-1m-fast",
      "claude-opus-5-5-max",
      "claude-opus-5-5-max-fast",
    ]);
    const catalog = buildAskCatalog(processed);
    assertOpus55Routes(catalog);
  });

  it("provides the same Opus 5.5 routes without a live source", () => {
    assertOpus55Routes(buildAskCatalog([]));
  });

  it("rebuilds raw Opus 5.5 effort ids without confusing Opus 5", () => {
    const raw: CursorModel[] = ["low", "medium", "high", "xhigh", "max"].flatMap((effort) =>
      ["", "-fast"].map((suffix) => ({
        id: `claude-opus-5-5-${effort}${suffix}`,
        name: "Opus 5.5",
        reasoning: true,
        contextWindow: 300_000,
        maxTokens: 64_000,
        supportsImages: true,
      })),
    );
    assertOpus55Routes(
      buildAskCatalog([
        ...processModels(raw),
        sourceModel({
          id: "claude-opus-5-1m-thinking",
          requestedModelId: "claude-opus-5",
          context: "1m",
        }),
      ]),
    );
  });

  it("preserves an authoritative parameterized source backend for Opus 5.5", () => {
    const catalog = buildAskCatalog([
      sourceModel({
        id: "claude-opus-5-5-1m",
        requestedModelId: "authoritative-opus-backend",
        context: "1m",
      }),
    ]);
    const model = catalog.find((row) => row.id === "opus-5.5")!;
    for (const level of ALL_LEVELS) {
      expect(model.rawRoutingByEffort?.[level]?.modelId).toBe("authoritative-opus-backend");
      expect(parameters(model.rawRoutingByEffort![level]!)).toEqual({
        context: "1m",
        effort: level,
        fast: "false",
      });
    }
  });

  it("keeps only Composer 2.5 / Fast and maps thinking off/max to Max Mode", () => {
    const catalog = buildAskCatalog([
      plainModel("composer-1.5", "Composer 1.5"),
      plainModel("composer-2-fast", "Composer 2 Fast"),
      plainModel("composer-2.5-max-mode", "Composer 2.5 Max Mode"),
      plainModel("composer-2.5-max-mode-fast", "Composer 2.5 Max Mode Fast"),
      plainModel("gpt-5.5", "GPT-5.5"),
      plainModel("gemini-3-pro", "Gemini 3 Pro"),
      plainModel("claude-fable-5-thinking", "Fable backend row"),
    ]);

    expect(catalog.slice(ASK_MODEL_SPECS.length).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]);
    expect(
      catalog.some((model) => /^(gpt|gemini|claude-|composer-1|composer-2$)/i.test(model.id)),
    ).toBe(false);

    for (const model of catalog.slice(ASK_MODEL_SPECS.length)) {
      const fast = model.id.endsWith("-fast") ? "true" : "false";
      expect(supportedAskThinkingLevels(model)).toEqual(["off", "max"]);
      expect(model.effortMap).toEqual({
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: "max",
      });
      expect(model.rawRoutingByEffort?.none).toMatchObject({
        modelId: "composer-2.5",
        requestedMaxMode: false,
        requiresMaxMode: false,
      });
      expect(parameters(model.rawRoutingByEffort!.none!)).toEqual({ fast });
      expect(model.rawRoutingByEffort?.max).toMatchObject({
        modelId: "composer-2.5",
        requestedMaxMode: true,
        requiresMaxMode: false,
      });
      expect(parameters(model.rawRoutingByEffort!.max!)).toEqual({ fast });

      const piModel = {
        ...modelConfig(model),
        provider: "cursor",
        baseUrl: "https://agent.cursor.sh",
      } as Model<Api>;
      expect(resolveNativeReasoningEffort(piModel, undefined)).toBe("none");
      expect(resolveNativeReasoningEffort(piModel, { reasoning: "max" })).toBe("max");
      expect(() => resolveNativeReasoningEffort(piModel, { reasoning: "high" })).toThrow(
        /not supported/i,
      );
    }
  });

  it("registers passthrough families only when the account catalog has them", () => {
    expect(PASSTHROUGH_ASK_SPECS.map((spec) => spec.id)).toEqual(["grok-4.6", "grok-4.6-fast"]);
    const withoutGrok = buildAskCatalog([plainModel("gpt-5.5", "GPT-5.5")]);
    expect(withoutGrok.some((model) => /grok/i.test(model.id))).toBe(false);

    // Shape the input the way live discovery does: raw effort/fast variants,
    // folded by processModels before the Ask catalog runs.
    const raw: CursorModel[] = [
      "cursor-grok-4.6-low",
      "cursor-grok-4.6-medium",
      "cursor-grok-4.6-high",
      "cursor-grok-4.6-xhigh",
      "cursor-grok-4.6-low-fast",
      "cursor-grok-4.6-medium-fast",
      "cursor-grok-4.6-high-fast",
      "cursor-grok-4.6-xhigh-fast",
    ].map((id) => ({
      id,
      name: id,
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 64_000,
    }));
    const catalog = buildAskCatalog(processModels(raw));

    const grok = catalog.find((model) => model.id === "grok-4.6");
    const grokFast = catalog.find((model) => model.id === "grok-4.6-fast");
    expect(grok?.name).toBe("Grok 4.6");
    expect(grokFast?.name).toBe("Grok 4.6 Fast");
    expect(catalog.some((model) => model.id.startsWith("cursor-grok"))).toBe(false);

    // Upstream-derived effort routing is kept as-is (no Claude-style rebuild):
    // four selectable levels, no off/minimal/max.
    for (const model of [grok, grokFast]) {
      expect(model?.supportsEffort).toBe(true);
      expect(supportedAskThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh"]);
      expect(model?.effortMap).toMatchObject({
        off: null,
        minimal: null,
        max: null,
      });
      expect(model?.rawRoutingByEffort?.high?.modelId).toMatch(/^cursor-grok-4\.6-high/);
    }
    expect(grok?.rawRoutingByEffort?.high?.modelId).toBe("cursor-grok-4.6-high");
    expect(grokFast?.rawRoutingByEffort?.high?.modelId).toBe("cursor-grok-4.6-high-fast");

    // Priced from pi core's xai/grok-4.6 row, not the generic grok-4.20 fallback.
    expect(modelConfig(grok!).cost).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
  });

  it("does not treat Fable 5's 1M row as Fable 5.1", () => {
    const catalog = buildAskCatalog([
      sourceModel({
        id: "claude-fable-5-1m-thinking",
        requestedModelId: "claude-fable-5",
        context: "1m",
      }),
      sourceModel({
        id: "claude-fable-5-1-1m-thinking",
        requestedModelId: "claude-fable-5-1",
        context: "1m",
      }),
    ]);
    const fable51 = catalog.find((model) => model.id === "fable-5.1");
    const fable5 = catalog.find((model) => model.id === "fable-5");

    expect(fable51?.rawRoutingByEffort?.high?.modelId).toBe("claude-fable-5-1");
    expect(fable5?.rawRoutingByEffort?.high?.modelId).toBe("claude-fable-5");
  });

  it("accepts the old Opus 4.6 fallback id without inventing missing effort levels", () => {
    const legacy = sourceModel({
      id: "claude-4.6-opus-thinking",
      requestedModelId: "claude-4.6-opus",
      context: "1m",
      levels: ["high", "max"],
      parameterized: false,
    });
    const catalog = buildAskCatalog([legacy]);

    for (const model of catalog.filter((row) => row.id.startsWith("opus-4.6"))) {
      expect(supportedAskThinkingLevels(model)).toEqual(["high", "max"]);
      expect(model.effortMap).toMatchObject({
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      });
      expect(model.rawRoutingByEffort?.high?.modelId).toBe("claude-opus-4-6");
      expect(parameters(model.rawRoutingByEffort!.high!)).toMatchObject({
        thinking: "true",
        effort: "high",
        fast: "false",
      });

      const piModel = {
        ...modelConfig(model),
        provider: "cursor",
        baseUrl: "https://agent.cursor.sh",
      } as Model<Api>;
      expect(() => resolveNativeReasoningEffort(piModel, { reasoning: "low" })).toThrow(
        /not supported/i,
      );
      expect(resolveNativeReasoningEffort(piModel, { reasoning: "high" })).toBe("high");
    }
  });
});
