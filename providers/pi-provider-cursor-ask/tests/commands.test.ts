import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  emitCursorCommandOutput,
  formatCursorCommandHelp,
  getCursorCommandCompletions,
  registerCursorCommands,
} from "../src/extension/commands.js";
import { CredentialSource } from "../src/types/enums.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function registeredHandler(): CommandHandler {
  let handler: CommandHandler | undefined;
  registerCursorCommands(
    {
      registerCommand(_name: string, command: { handler: CommandHandler }) {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI,
    {
      getAccessToken: async () => {
        throw new Error("token unused");
      },
      getLastRegisteredModels: () => [],
      getCurrentTokenSource: () => CredentialSource.None,
    },
  );
  if (!handler) throw new Error("command was not registered");
  return handler;
}

function commandContext(
  overrides: Partial<Pick<ExtensionCommandContext, "hasUI" | "mode">> & {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    custom?: (...args: unknown[]) => Promise<void>;
  } = {},
): ExtensionCommandContext {
  return {
    hasUI: overrides.hasUI ?? true,
    mode: overrides.mode ?? "tui",
    ui: {
      notify: overrides.notify ?? vi.fn(),
      custom: overrides.custom ?? vi.fn(async () => undefined),
    },
  } as unknown as ExtensionCommandContext;
}

describe("cursor command surface", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a single cursor command with usage and doctor completions", () => {
    const commands: string[] = [];
    registerCursorCommands(
      {
        registerCommand(name: string) {
          commands.push(name);
        },
      } as unknown as ExtensionAPI,
      {
        getAccessToken: async () => "token",
        getLastRegisteredModels: () => [],
        getCurrentTokenSource: () => CredentialSource.None,
      },
    );

    expect(commands).toEqual(["cursor"]);
    expect(getCursorCommandCompletions("")?.map((item) => item.value)).toEqual(["usage", "doctor"]);
    expect(getCursorCommandCompletions("m")).toBeNull();
  });

  it("notifies a one-line hint and does not write stdout", async () => {
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await registeredHandler()("", commandContext({ notify }));

    expect(notify).toHaveBeenCalledWith(formatCursorCommandHelp(), "info");
    expect(formatCursorCommandHelp()).toBe("Usage: /cursor <usage|doctor>");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("prints only when no UI is present", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const notify = vi.fn();

    emitCursorCommandOutput(commandContext({ hasUI: false, notify }), "report");
    emitCursorCommandOutput(commandContext({ hasUI: true, notify }), "toast");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("report");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("toast", "info");
  });

  it("rejects unknown subcommands without writing stdout", async () => {
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await registeredHandler()("models", commandContext({ notify }));

    expect(notify).toHaveBeenCalledWith(
      "Unknown /cursor subcommand. Usage: /cursor <usage|doctor>",
      "warning",
    );
    expect(log).not.toHaveBeenCalled();
  });
});
