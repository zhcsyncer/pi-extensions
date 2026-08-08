import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import adversarialReviewExtension, {
  ADVERSARIAL_REVIEW_COMMAND,
  preflightReviewCommand,
} from "../src/index.ts";

class FakePi {
  readonly commands = new Map<string, any>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  readonly registerTool = vi.fn();
  readonly registerMessageRenderer = vi.fn();

  registerCommand(name: string, command: unknown): void {
    this.commands.set(name, command);
  }

  on(name: string, handler: (...args: any[]) => unknown): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  api(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

function model(provider: string, id: string): Model<any> {
  return { provider, id, reasoning: true } as Model<any>;
}

function context() {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    scopedModels: [
      { model: model("provider-a", "model-a") },
      { model: model("provider-b", "model-b") },
    ],
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

describe("adversarial review extension", () => {
  it("registers only the slash command and shutdown lifecycle", () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());

    expect([...fake.commands.keys()]).toEqual([ADVERSARIAL_REVIEW_COMMAND]);
    expect(fake.registerTool).not.toHaveBeenCalled();
    expect(fake.registerMessageRenderer).not.toHaveBeenCalled();
    expect(fake.handlers.get("session_shutdown")).toHaveLength(1);
  });

  it("validates explicit routes without doing runtime work", () => {
    const { ctx } = context();
    const preflight = preflightReviewCommand(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(preflight.routes.map((route) => route.key)).toEqual([
      "provider-a/model-a@high",
      "provider-b/model-b@high",
    ]);
    expect(preflight.command.target).toEqual({ mode: "local" });
  });

  it("fails before runtime work when reviewer selection is invalid", async () => {
    const fake = new FakePi();
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context();

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high",
      ctx,
    );

    expect(notifications[0]).toMatchObject({ type: "error" });
    expect(notifications[0].message).toContain("at least 2 distinct reviewer models");
  });
});
