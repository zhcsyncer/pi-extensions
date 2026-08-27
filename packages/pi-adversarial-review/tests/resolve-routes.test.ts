import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  resolveMainSessionRefuterRoute,
  resolveRefuterRoute,
  resolveReviewerRoutes,
} from "../src/command/resolve-routes.ts";
import type { ScopedModelEntry } from "../src/types.ts";

function model(provider: string, id: string, reasoning = true): Model<any> {
  return {
    provider,
    id,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } } : {}),
  } as Model<any>;
}

function scoped(...entries: Array<[Model<any>, ScopedModelEntry["thinkingLevel"]?]>): ScopedModelEntry[] {
  return entries.map(([entryModel, thinkingLevel]) => ({
    model: entryModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }));
}

describe("resolveReviewerRoutes", () => {
  const a = model("provider-a", "model-a");
  const b = model("provider-b", "model@b");

  it("uses the last @ and preserves explicit route order", () => {
    const routes = resolveReviewerRoutes(
      ["provider-a/model-a@high", "provider-b/model@b@xhigh"],
      scoped([a], [b]),
    );

    expect(routes.map(({ key, ordinal, thinkingSource }) => ({ key, ordinal, thinkingSource }))).toEqual([
      { key: "provider-a/model-a@high", ordinal: 0, thinkingSource: "user" },
      { key: "provider-b/model@b@xhigh", ordinal: 1, thinkingSource: "user" },
    ]);
  });

  it("enforces pinned thinking without clamping", () => {
    const routes = resolveReviewerRoutes(
      ["provider-a/model-a@high", "provider-b/model@b@xhigh"],
      scoped([a, "high"], [b, "xhigh"]),
    );
    expect(routes.map((route) => route.thinkingSource)).toEqual(["scope-pinned", "scope-pinned"]);

    expect(() => resolveReviewerRoutes(
      ["provider-a/model-a@medium", "provider-b/model@b@xhigh"],
      scoped([a, "high"], [b, "xhigh"]),
    )).toThrow('pinned to thinking "high"');
  });

  it("requires exact scoped models and supported thinking", () => {
    expect(() => resolveReviewerRoutes(
      ["provider-a/model-a@high", "provider-c/model-c@high"],
      scoped([a], [b]),
    )).toThrow("is not in the current scoped models");

    const plain = model("provider-c", "plain", false);
    expect(() => resolveReviewerRoutes(
      ["provider-a/model-a@high", "provider-c/plain@high"],
      scoped([a], [plain]),
    )).toThrow('Thinking "high" is not supported');
  });

  it("binds the default refuter to the current main-session model and thinking", () => {
    const main = model("main-provider", "main-model");
    expect(resolveMainSessionRefuterRoute(main, "medium")).toMatchObject({
      key: "main-provider/main-model@medium",
      model: main,
      thinking: "medium",
      thinkingSource: "main-session",
      ordinal: 0,
    });
    expect(() => resolveMainSessionRefuterRoute(undefined, "medium")).toThrow(
      "current main session has no model",
    );
    expect(() => resolveMainSessionRefuterRoute(main, undefined)).toThrow(
      "current main session has no thinking level",
    );
  });

  it("resolves one exact refuter route with the same pin and capability rules", () => {
    expect(resolveRefuterRoute(
      "provider-b/model@b@xhigh",
      scoped([a], [b, "xhigh"]),
    )).toMatchObject({
      key: "provider-b/model@b@xhigh",
      ordinal: 0,
      thinkingSource: "scope-pinned",
    });
    expect(() => resolveRefuterRoute(
      "provider-b/model@b@high",
      scoped([b, "xhigh"]),
    )).toThrow('Refuter model "provider-b/model@b" is pinned');
    expect(() => resolveRefuterRoute(
      "missing/model@high",
      scoped([a], [b]),
    )).toThrow('Refuter model "missing/model" is not in the current scoped models');
  });

  it("fails closed on empty scope, duplicate models, and invalid fleet sizes", () => {
    expect(() => resolveReviewerRoutes(["a/b@off", "c/d@off"], [])).toThrow(
      "No scoped models are configured",
    );
    expect(() => resolveReviewerRoutes(["provider-a/model-a@high"], scoped([a]))).toThrow(
      "at least 2 distinct reviewer models",
    );
    expect(() => resolveReviewerRoutes(
      ["provider-a/model-a@high", "provider-a/model-a@xhigh"],
      scoped([a]),
    )).toThrow("is duplicated");
    expect(() => resolveReviewerRoutes(
      Array.from({ length: 9 }, (_, index) => `p${index}/m${index}@off`),
      scoped(...Array.from(
        { length: 9 },
        (_, index): [Model<any>] => [model(`p${index}`, `m${index}`, false)],
      )),
    )).toThrow("at most 8 reviewer models");
  });
});
