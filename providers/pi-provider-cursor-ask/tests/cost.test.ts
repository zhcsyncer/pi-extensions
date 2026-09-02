import { describe, expect, it } from "vitest";

import { buildAskCatalog } from "../src/models/ask-catalog.js";
import { estimateModelCost } from "../src/models/cost.js";
import { modelConfig } from "../src/models/processing.js";

describe("estimateModelCost", () => {
  it("prices Fable 5.1 cheaper on cache reads than Fable 5", () => {
    expect(estimateModelCost("claude-fable-5-1")).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    });
    expect(estimateModelCost("fable-5.1")).toEqual(estimateModelCost("claude-fable-5-1"));
    expect(estimateModelCost("claude-fable-5")).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 1,
    });
    expect(estimateModelCost("fable-5")).toEqual(estimateModelCost("claude-fable-5"));
  });

  it("does not let Fable 5's 1M id steal Fable 5.1 pricing", () => {
    expect(estimateModelCost("claude-fable-5-1m-thinking").cacheRead).toBe(1);
    expect(estimateModelCost("claude-fable-5-1-1m-thinking").cacheRead).toBe(0.25);
  });
});

describe("Ask catalog local prices", () => {
  it("keeps short picker ids and prices them from the Cursor model behind each row", () => {
    const catalog = buildAskCatalog([]);
    const cost = Object.fromEntries(
      catalog.map((model) => [model.id, modelConfig(model).cost]),
    );

    expect(catalog.map((model) => model.name)).toEqual([
      "Fable 5.1",
      "Fable 5",
      "Opus 5",
      "Opus 4.6",
      "Sonnet 5",
      "Composer 2.5",
      "Composer 2.5 Fast",
    ]);
    expect(cost["fable-5.1"]).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 12.5,
    });
    expect(cost["fable-5"]).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
    expect(cost["opus-5"]).toMatchObject({ input: 5, output: 25 });
    expect(cost["sonnet-5"]).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(cost["composer-2.5"]).toMatchObject({ input: 0.5, output: 2.5 });
    expect(cost["composer-2.5-fast"]).toMatchObject({ input: 3, output: 15 });
  });
});
