import type { Model } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  pickInteractiveReviewSetup,
  pickRefuterSpec,
  pickReviewerSpecs,
  pickerValueColor,
  retainValidRefuterSpec,
  retainValidReviewerSpecs,
} from "../src/ui/reviewer-picker.ts";

function model(provider: string, id: string, reasoning = true): Model<any> {
  return {
    provider,
    id,
    name: id,
    reasoning,
  } as Model<any>;
}

function pickerContext(
  scopedModels: ExtensionCommandContext["scopedModels"],
  drive: (component: { render(width: number): string[]; handleInput?(data: string): void }) => void,
): ExtensionCommandContext {
  return {
    mode: "tui",
    scopedModels,
    ui: {
      custom: vi.fn(async (factory: any) => new Promise((resolve) => {
        const component = factory(
          { requestRender: vi.fn() },
          {
            bold: (text: string) => text,
            fg: (_color: string, text: string) => text,
          },
          {},
          resolve,
        );
        drive(component);
      })),
    },
  } as unknown as ExtensionCommandContext;
}

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

beforeAll(() => {
  initTheme("dark", false);
});

describe("reviewer picker", () => {
  it("dims only disabled values and highlights enabled thinking including off", () => {
    expect(pickerValueColor("disabled", false)).toBe("dim");
    expect(pickerValueColor("disabled", true)).toBe("dim");
    expect(pickerValueColor("off", false)).toBe("success");
    expect(pickerValueColor("off", true)).toBe("accent");
    expect(pickerValueColor("medium", false)).toBe("success");
    expect(pickerValueColor("confirm", true)).toBe("accent");
    expect(pickerValueColor("main session", false)).toBe("success");
  });

  it("selects two scoped routes and reports concurrency waves", async () => {
    let initial = "";
    let selected = "";
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a") },
        { model: model("provider-b", "model-b") },
      ],
      (component) => {
        initial = component.render(120).join("\n");
        component.handleInput?.(ENTER); // model-a: disabled -> medium
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // model-b: disabled -> medium
        selected = component.render(120).join("\n");
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // Run
      },
    );

    await expect(pickReviewerSpecs({ ctx, maxConcurrent: 1 })).resolves.toEqual([
      "provider-a/model-a@medium",
      "provider-b/model-b@medium",
    ]);
    expect(initial).toContain("0 selected · max concurrent 1 · 0 waves");
    expect(selected).toContain("2 selected · max concurrent 1 · 2 waves");
  });

  it("defaults interactive Refute to the current main session and allows disabling it", async () => {
    const scopedModels = [
      { model: model("provider-a", "model-a") },
      { model: model("provider-b", "model-b") },
    ];
    const mainCtx = pickerContext(scopedModels, (component) => {
      const initial = component.render(140).join("\n");
      expect(initial).toContain("Refute on");
      expect(initial).toContain("Refute blocking findings");
      expect(initial).toContain("main session");
      component.handleInput?.(ENTER); // reviewer A -> medium
      component.handleInput?.(DOWN);
      component.handleInput?.(ENTER); // reviewer B -> medium
      component.handleInput?.(DOWN); // Refute remains main session
      component.handleInput?.(DOWN);
      component.handleInput?.(ENTER); // Run
    });
    await expect(pickInteractiveReviewSetup({
      ctx: mainCtx,
      maxConcurrent: 2,
      mainSessionRefuterKey: "main-provider/main-model@high",
    })).resolves.toEqual({
      reviewerSpecs: ["provider-a/model-a@medium", "provider-b/model-b@medium"],
      refute: "main-session",
    });

    const disabledCtx = pickerContext(scopedModels, (component) => {
      component.handleInput?.(ENTER);
      component.handleInput?.(DOWN);
      component.handleInput?.(ENTER);
      component.handleInput?.(DOWN);
      component.handleInput?.(ENTER); // main session -> choose model
      component.handleInput?.(ENTER); // choose model -> disabled
      expect(component.render(140).join("\n")).toContain("Refute off");
      component.handleInput?.(DOWN);
      component.handleInput?.(ENTER);
    });
    await expect(pickInteractiveReviewSetup({
      ctx: disabledCtx,
      maxConcurrent: 2,
      mainSessionRefuterKey: "main-provider/main-model@high",
    })).resolves.toMatchObject({ refute: "disabled" });
  });

  it("falls back to a required scoped refuter when the main-session route is unavailable", async () => {
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a") },
        { model: model("provider-b", "model-b") },
      ],
      (component) => {
        expect(component.render(140).join("\n")).toContain("choose model");
        component.handleInput?.(ENTER);
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER);
        component.handleInput?.(DOWN); // required Refute stays choose model
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER);
      },
    );

    await expect(pickInteractiveReviewSetup({
      ctx,
      maxConcurrent: 2,
      refuteRequired: true,
    })).resolves.toMatchObject({ refute: "choose-model" });
  });

  it("uses the nearest supported level when medium is unavailable", async () => {
    const fallback = {
      ...model("provider-a", "model-a"),
      thinkingLevelMap: { medium: null, high: null },
    } as Model<any>;
    const ctx = pickerContext(
      [{ model: fallback }],
      (component) => {
        const initial = component.render(120).join("\n");
        expect(initial).toContain("0 selected");
        expect(initial).toContain("Defaults to disabled; first enable uses medium");
        component.handleInput?.(ENTER); // disabled -> nearest supported level (low)
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // Use selected refuter
      },
    );

    await expect(pickRefuterSpec({ ctx })).resolves.toBe("provider-a/model-a@low");
  });

  it("restores only still-valid session choices and honors scope-pinned thinking", async () => {
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a"), thinkingLevel: "high" },
        { model: model("provider-b", "model-b", false) },
      ],
      (component) => {
        const rendered = component.render(120).join("\n");
        expect(rendered).toContain("2 selected");
        expect(rendered).toContain("Scope-pinned thinking: high");
        component.handleInput?.(DOWN);
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // Run remembered choices
      },
    );

    await expect(pickReviewerSpecs({
      ctx,
      maxConcurrent: 4,
      previousSpecs: [
        "provider-a/model-a@high",
        "provider-b/model-b@off",
        "removed/model@high",
      ],
    })).resolves.toEqual([
      "provider-a/model-a@high",
      "provider-b/model-b@off",
    ]);
  });

  it("keeps the picker open on an invalid fleet and Escape cancels without a result", async () => {
    let afterInvalid = "";
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a") },
        { model: model("provider-b", "model-b") },
      ],
      (component) => {
        component.handleInput?.(DOWN);
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // Run with zero selected
        afterInvalid = component.render(120).join("\n");
        component.handleInput?.(ESCAPE);
      },
    );

    await expect(pickReviewerSpecs({ ctx, maxConcurrent: 2 })).resolves.toBeUndefined();
    expect(afterInvalid).toContain("requires at least 2 distinct reviewer models");
  });

  it("permanently prunes removed routes even if a reduced-scope picker is cancelled", () => {
    const firstScope = [
      { model: model("provider-a", "model-a") },
    ];
    const pruned = retainValidReviewerSpecs([
      "provider-a/model-a@high",
      "provider-b/model-b@off",
    ], firstScope);
    expect(pruned).toEqual(["provider-a/model-a@high"]);

    expect(retainValidReviewerSpecs(pruned, [
      ...firstScope,
      { model: model("provider-b", "model-b") },
    ])).toEqual(["provider-a/model-a@high"]);
  });

  it("keeps long provider/model rows within an extremely narrow terminal width", async () => {
    const width = 3;
    const ctx = pickerContext(
      [
        { model: model("provider-with-a-very-long-name", "model-with-a-very-long-identifier-a") },
        { model: model("provider-with-a-very-long-name", "model-with-a-very-long-identifier-b") },
      ],
      (component) => {
        for (const line of component.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
        component.handleInput?.(ESCAPE);
      },
    );

    await expect(pickReviewerSpecs({ ctx, maxConcurrent: 2 })).resolves.toBeUndefined();
  });

  it("selects exactly one refuter and replaces a remembered route", async () => {
    let afterReplacement = "";
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a"), thinkingLevel: "high" },
        { model: model("provider-b", "model-b", false) },
      ],
      (component) => {
        expect(component.render(120).join("\n")).toContain("Adversarial refuter");
        expect(component.render(120).join("\n")).toContain("1 selected");
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // model-b -> off, model-a -> disabled
        afterReplacement = component.render(120).join("\n");
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // Use selected refuter
      },
    );

    await expect(pickRefuterSpec({
      ctx,
      previousSpec: "provider-a/model-a@high",
    })).resolves.toBe("provider-b/model-b@off");
    expect(afterReplacement).toContain("1 selected");
    expect(retainValidRefuterSpec("removed/model@high", ctx.scopedModels)).toBeUndefined();
  });

  it("keeps the refuter picker open until exactly one route is selected", async () => {
    let invalid = "";
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a") },
        { model: model("provider-b", "model-b") },
      ],
      (component) => {
        component.handleInput?.(DOWN);
        component.handleInput?.(DOWN);
        component.handleInput?.(ENTER); // confirm zero
        invalid = component.render(120).join("\n");
        component.handleInput?.(ESCAPE);
      },
    );

    await expect(pickRefuterSpec({ ctx })).resolves.toBeUndefined();
    expect(invalid).toContain("requires exactly one refuter model");
  });

  it("aborts a pending picker through the shared run signal", async () => {
    const controller = new AbortController();
    const ctx = pickerContext(
      [
        { model: model("provider-a", "model-a") },
        { model: model("provider-b", "model-b") },
      ],
      () => controller.abort(),
    );

    await expect(pickReviewerSpecs({
      ctx,
      maxConcurrent: 2,
      signal: controller.signal,
    })).resolves.toBeUndefined();
  });
});
