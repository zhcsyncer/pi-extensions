import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import adversarialReviewExtension, {
  ADVERSARIAL_REVIEW_COMMAND,
  preflightReviewCommand,
} from "../src/index.ts";

class FakePi {
  readonly commands = new Map<string, any>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  readonly eventHandlers = new Map<string, Set<(data: any) => void>>();
  readonly emitted: Array<{ event: string; data: any }> = [];
  readonly sentMessages: Array<{ message: any; options: any }> = [];
  readonly entries: Array<{ customType: string; data: any }> = [];
  readonly registerTool = vi.fn();
  readonly registerMessageRenderer = vi.fn();
  eventResponder?: (event: string, data: any) => void;
  readonly events = {
    on: (event: string, handler: (data: any) => void) => {
      const handlers = this.eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      this.eventHandlers.set(event, handlers);
      return () => handlers.delete(handler);
    },
    emit: (event: string, data: any) => {
      this.emitted.push({ event, data });
      this.eventResponder?.(event, data);
      for (const handler of this.eventHandlers.get(event) ?? []) handler(data);
    },
  };

  registerCommand(name: string, command: unknown): void {
    this.commands.set(name, command);
  }

  on(name: string, handler: (...args: any[]) => unknown): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  sendMessage(message: any, options: any): void {
    this.sentMessages.push({ message, options });
  }

  appendEntry(customType: string, data: any): void {
    this.entries.push({ customType, data });
  }

  api(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

function model(provider: string, id: string): Model<any> {
  return { provider, id, reasoning: true } as Model<any>;
}

const exec = promisify(execFile);
const tempRepos: string[] = [];

async function git(root: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function changedRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-adversarial-extension-"));
  tempRepos.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "review@example.test");
  await git(root, "config", "user.name", "Review Test");
  await writeFile(path.join(root, "example.ts"), "export const value = 1;\n");
  await git(root, "add", "example.ts");
  await git(root, "commit", "-qm", "base");
  await writeFile(path.join(root, "example.ts"), "export const value = 2;\n");
  return root;
}

function context(cwd = process.cwd()) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd,
    mode: "tui",
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

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

  it("runs the local two-route command and publishes one non-triggering merged report", async () => {
    const root = await changedRepo();
    const fake = new FakePi();
    const frozenPaths: string[] = [];
    let nextAgent = 0;
    fake.eventResponder = (event, data) => {
      if (event === "subagents:rpc:ping") {
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { version: 3, maxConcurrent: 2 },
        });
        return;
      }
      if (event === "subagents:rpc:spawn") {
        const agentId = `agent-${nextAgent++}`;
        const inputPath = /^Frozen input file: (.+)$/mu.exec(data.prompt)?.[1];
        if (inputPath) frozenPaths.push(inputPath);
        fake.events.emit("subagents:completed", {
          id: agentId,
          correlationId: data.options.correlationId,
          status: "completed",
          result: JSON.stringify({ verdict: "approve", summary: "clean", findings: [] }),
          requestedModel: {
            provider: data.options.model.provider,
            modelId: data.options.model.id,
          },
          requestedThinkingLevel: data.options.thinkingLevel,
          effectiveModel: {
            provider: data.options.model.provider,
            modelId: data.options.model.id,
          },
          effectiveThinkingLevel: data.options.thinkingLevel,
        });
        fake.events.emit(`${event}:reply:${data.requestId}`, {
          success: true,
          data: { id: agentId },
        });
      }
    };
    adversarialReviewExtension(fake.api());
    const { ctx, notifications } = context(root);

    await fake.commands.get(ADVERSARIAL_REVIEW_COMMAND).handler(
      "--reviewer provider-a/model-a@high --reviewer provider-b/model-b@high",
      ctx,
    );

    expect(fake.entries).toHaveLength(1);
    expect(fake.entries[0]).toMatchObject({
      customType: "adversarial-review-report",
      data: { overall: "candidate-approve", successfulReviewerCount: 2 },
    });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]).toMatchObject({
      message: {
        customType: "adversarial-review-report",
        details: { overall: "candidate-approve", successfulReviewerCount: 2 },
      },
      options: { deliverAs: "nextTurn" },
    });
    expect(fake.sentMessages[0].options).not.toHaveProperty("triggerTurn");
    expect(JSON.stringify(fake.sentMessages[0].message.details)).not.toContain('"model":');
    expect(notifications.at(-1)).toEqual({
      message: "Adversarial review: candidate-approve (2/2 valid).",
      type: "info",
    });
    expect(frozenPaths).toHaveLength(2);
    for (const inputPath of frozenPaths) await expect(access(inputPath)).rejects.toThrow();
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
