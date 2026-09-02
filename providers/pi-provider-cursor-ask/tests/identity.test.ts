import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import { registerCursorCommands } from "../src/extension/commands.js";
import { createProviderManager } from "../src/extension/provider.js";
import { FALLBACK_MODELS } from "../src/models/parameterized.js";
import { CredentialSource, ProviderConstant } from "../src/types/enums.js";

afterEach(() => {
  unregisterApiProviders(ProviderConstant.Source);
});

describe("drop-in Cursor provider identity", () => {
  it("registers the cursor replacement, upstream stream API, OAuth label, and filtered models", () => {
    let registeredName = "";
    let registeredConfig: ProviderConfig | undefined;
    const pi = {
      registerProvider(name: string, config: ProviderConfig) {
        registeredName = name;
        registeredConfig = config;
      },
    } as unknown as ExtensionAPI;

    const manager = createProviderManager(pi, {
      getAccessToken: async () => "token",
      setCurrentToken: vi.fn(),
      onRegisteredModelsUpdated: vi.fn(),
    });
    const models = manager.registerModels(FALLBACK_MODELS);

    expect(registeredName).toBe("cursor");
    expect(registeredConfig?.api).toBe("cursor-native");
    expect(registeredConfig?.oauth?.name).toBe("Cursor Ask");
    expect(registeredConfig?.models).toHaveLength(7);
    expect(models.map((model) => model.id)).toEqual([
      "fable-5.1",
      "fable-5",
      "opus-5",
      "opus-4.6",
      "sonnet-5",
      "composer-2.5",
      "composer-2.5-fast",
    ]);
    expect(getApiProvider("cursor-native")?.api).toBe("cursor-native");
  });

  it("keeps fork-specific diagnostic command names", () => {
    const commands: string[] = [];
    const pi = {
      registerCommand(name: string) {
        commands.push(name);
      },
    } as unknown as ExtensionAPI;

    registerCursorCommands(pi, {
      getAccessToken: async () => "token",
      getLastRegisteredModels: () => [],
      getCurrentTokenSource: () => CredentialSource.None,
    });

    expect(commands).toEqual(["cursor"]);
    expect(commands.some((name) => name.startsWith("cursor."))).toBe(false);
    expect(commands.some((name) => name.startsWith("cursor-ask"))).toBe(false);
  });
});
