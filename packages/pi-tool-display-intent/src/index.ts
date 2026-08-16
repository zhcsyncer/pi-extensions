import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import { registerAggregateThinkingPlaceholderSuppression } from "./aggregate-thinking-placeholder.js";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  type ToolDisplayConfig,
} from "./types.js";

export function publishToolDisplayMigrationNotice(
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify?(message: string, level: "warning"): void;
  },
  notice: string | undefined,
): void {
  if (notice) {
    ui.setStatus("tool-display-intent-migration", notice);
    ui.notify?.(notice, "warning");
  }
}

function toolRegistrationChanged(
  previous: ToolDisplayConfig,
  next: ToolDisplayConfig,
): boolean {
  const ownershipChanged = BUILT_IN_TOOL_OVERRIDE_NAMES.some(
    (toolName) =>
      previous.registerToolOverrides[toolName] !==
      next.registerToolOverrides[toolName],
  );
  const intentSchemaChanged =
    previous.toolIntent.enabled !== next.toolIntent.enabled ||
    previous.toolIntent.language !== next.toolIntent.language ||
    previous.toolIntent.maxLength !== next.toolIntent.maxLength ||
    previous.toolCallLayout !== next.toolCallLayout ||
    previous.toolCallStyle !== next.toolCallStyle;
  return ownershipChanged || intentSchemaChanged;
}

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    if (event.reason === "reload") {
      disposeAll();
    }
  });

  let config: ToolDisplayConfig = initial.config;
  let pendingLoadError = initial.error;
  let pendingLoadNotice = initial.notice;
  let capabilities: ToolDisplayCapabilities = {
    hasMcpTooling: false,
    hasRtkOptimizer: false,
  };

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
  };

  const getConfig = (): ToolDisplayConfig => config;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    applyCapabilityConfigGuards(config, capabilities);

  const setConfig = (
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizeToolDisplayConfig(next);
    const requiresReload = toolRegistrationChanged(config, normalized);
    config = normalized;

    const saved = saveToolDisplayConfig(normalized);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }

    if (requiresReload) {
      ctx.ui.notify(
        "Tool ownership, layout, intent schema, or call frame updates apply after /reload.",
        "warning",
      );
    }
  };

  registerToolDisplayOverrides(pi, getEffectiveConfig);
  registerAggregateThinkingPlaceholderSuppression(
    pi,
    () => initial.config.toolCallLayout === "aggregate",
  );
  registerNativeUserMessageBox(pi, getConfig);
  registerThinkingLabeling(pi, () =>
    getConfig().toolCallLayout !== "aggregate" && getConfig().enableThinkingLabel,
  );

  pi.registerCommand("tool-display-intent", {
    description: "Configure intent-aware tool rendering",
    handler: async (args, ctx) => {
      const { runToolDisplayCommandHandler } = await import("./config-modal.js");
      await runToolDisplayCommandHandler(args, ctx, { getConfig, setConfig, getCapabilities });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshCapabilities();
    if (pendingLoadError) {
      ctx.ui.notify(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }
    if (pendingLoadNotice) {
      publishToolDisplayMigrationNotice(ctx.ui, pendingLoadNotice);
      pendingLoadNotice = undefined;
    }
  });

  pi.on("before_agent_start", async () => {
    refreshCapabilities();
  });
}
