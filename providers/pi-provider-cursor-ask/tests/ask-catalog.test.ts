import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  ASK_MODEL_SPECS,
  COMPOSER_ASK_SPECS,
  buildAskCatalog,
  supportedAskThinkingLevels,
} from "../src/models/ask-catalog.js";
import type {
  CursorEffortMap,
  CursorModelRouting,
  ProcessedModel,
} from "../src/models/processing.js";
import { modelConfig } from "../src/models/processing.js";
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

describe("Cursor Ask catalog contract", () => {
  it("always exposes the four 1M Claude rows plus Composer 2.5 / Fast", () => {
    const catalog = buildAskCatalog([]);

    expect(catalog.map(({ id, name }) => ({ id, name }))).toEqual([
      ...ASK_MODEL_SPECS.map(({ id, name }) => ({ id, name })),
      ...COMPOSER_ASK_SPECS.map(({ id, name }) => ({ id, name })),
    ]);
    expect(catalog).toHaveLength(6);
    expect(catalog.every((model) => model.reasoning && model.supportsEffort)).toBe(true);
    expect(catalog.slice(0, 4).every((model) => model.effortMap?.off === null)).toBe(true);
    expect(catalog.every((model) => model.effortMap?.minimal === null)).toBe(true);
    expect(catalog.slice(0, 4).every((model) => model.contextWindow === 1_000_000)).toBe(true);
    expect(
      catalog
        .slice(0, 4)
        .some((model) => /200k|300k|\[1m\]|-1m$/i.test(`${model.id} ${model.name}`)),
    ).toBe(false);
  });

  it("routes every level through the official requestedModelId and fixed parameters", () => {
    const sources = ASK_MODEL_SPECS.map((spec) =>
      sourceModel({
        id: spec.candidates[0]!,
        requestedModelId: spec.requestedModelId,
        context: spec.context,
      }),
    );
    const catalog = buildAskCatalog(sources).slice(0, 4);

    for (const [index, model] of catalog.entries()) {
      const spec = ASK_MODEL_SPECS[index]!;
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

    expect(catalog.slice(4).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    ]);
    expect(
      catalog.some((model) => /^(gpt|gemini|claude-|composer-1|composer-2$)/i.test(model.id)),
    ).toBe(false);

    for (const model of catalog.slice(4)) {
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
