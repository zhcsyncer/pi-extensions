/**
 * Command registrations for the standalone Cursor Ask provider.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLastDiagnostics } from "../diagnostics/diagnostics.js";
import { formatDriftSummary, getDriftSignals, hasStrandingDrift } from "../stream/drift.js";
import { readCachedCatalog } from "../stream/model-cache.js";
import { getCacheDir } from "../utils/cache-dir.js";
import { getCursorAgentUrl, getCursorClientVersion } from "../stream/config.js";
import { resolveSystemCredentialPolicy } from "../auth/consent.js";
import { getLifecycleLogPath } from "../stream/debug-log.js";
import { redactSecrets } from "../utils/security.js";
import { formatCursorUsage, getCursorUsageSummary } from "../usage.js";
import { CURSOR_ASK_COMMAND, CURSOR_ASK_IDENTITY } from "../identity.js";
import { ProviderConstant, type CredentialSource } from "../types/enums.js";
import type { ProcessedModel } from "../models/processing.js";
import { showCursorReport } from "./report-dashboard.js";

export interface CursorCommandOptions {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  getLastRegisteredModels: () => ProcessedModel[];
  getCurrentTokenSource: () => CredentialSource;
}

type NotifyLevel = "info" | "warning" | "error";

type CommandCompletion = { value: string; label: string; description?: string };

const SUBCOMMANDS: CommandCompletion[] = [
  { value: "usage", label: "usage", description: "Show Cursor plan quota" },
  { value: "doctor", label: "doctor", description: "Show sanitized diagnostics" },
];

export function formatCursorCommandHelp(): string {
  return `Usage: ${CURSOR_ASK_COMMAND} <usage|doctor>`;
}

export function emitCursorCommandOutput(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  text: string,
  level: NotifyLevel = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }
  if (level === "error") console.error(text);
  else console.log(text);
}

export function getCursorCommandCompletions(prefix: string): CommandCompletion[] | null {
  const needle = prefix.trim().toLowerCase();
  const items = SUBCOMMANDS.filter((item) => item.value.startsWith(needle));
  return items.length > 0 ? items : null;
}

export function registerCursorCommands(pi: ExtensionAPI, options: CursorCommandOptions): void {
  pi.registerCommand(CURSOR_ASK_IDENTITY.commandName, {
    description: "Cursor usage and diagnostics",
    getArgumentCompletions: getCursorCommandCompletions,
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = (tokens[0] ?? "").toLowerCase();

      if (!subcommand || subcommand === "help" || subcommand === "?") {
        emitCursorCommandOutput(ctx, formatCursorCommandHelp());
        return;
      }

      if (subcommand === "usage") {
        try {
          await showCursorReport(
            ctx,
            "Cursor usage",
            formatCursorUsage(await getCursorUsageSummary(options.getAccessToken)),
          );
        } catch (error) {
          emitCursorCommandOutput(
            ctx,
            `Cursor usage unavailable: ${redactSecrets(
              error instanceof Error ? error.message : String(error),
            )}`,
            "error",
          );
        }
        return;
      }

      if (subcommand === "doctor") {
        await showCursorReport(ctx, "Cursor doctor", formatCursorDoctorReport(options));
        return;
      }

      emitCursorCommandOutput(
        ctx,
        `Unknown ${CURSOR_ASK_COMMAND} subcommand. ${formatCursorCommandHelp()}`,
        "warning",
      );
    },
  });
}

function formatCursorDoctorReport(options: CursorCommandOptions): string {
  const d = getLastDiagnostics();
  const driftSignals = getDriftSignals();
  const cachedCatalog = readCachedCatalog();
  const registered = options.getLastRegisteredModels();
  const currentTokenSource = options.getCurrentTokenSource();

  const lines = [
    "Cursor doctor",
    `provider=${ProviderConstant.ProviderId}`,
    `agentUrl=${getCursorAgentUrl()}`,
    `clientVersion=${d.clientVersion || getCursorClientVersion()}`,
    `tokenSource=${d.tokenSource || currentTokenSource || "none"}`,
    `systemCredentials=${d.systemCredentials || resolveSystemCredentialPolicy()}`,
    `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
    `availableModels=${d.availableModels || registered.length || "none"}`,
    `catalogCache=${
      cachedCatalog
        ? `${cachedCatalog.rawModels.length}+${cachedCatalog.parameterizedModels.length} models, age ${Math.round(
            (Date.now() - cachedCatalog.savedAt) / 1000,
          )}s`
        : "none(using bundled fallback)"
    }`,
    `catalogCacheDir=${getCacheDir() || "unavailable"}`,
    `matchedModel=${d.matchedModelDebug || "none"}`,
    `lastEndpoint=${d.endpoint || "none"}`,
    `lastStatus=${d.status ?? "none"}`,
    `lastRpc=${d.lastRpc || "none"}`,
    `lastRecoverySkipReason=${d.lastRecoverySkipReason || "none"}`,
    `lastStreamEvent=${d.lastStreamEvent || "none"}`,
    `lastRequestSize=${d.lastRequestSize || "none"}`,
    `lastDriftSignal=${d.lastDriftSignal || "none"}`,
    `wireDrift=${formatDriftSummary() || "none"}`,
    `wireDriftStranding=${hasStrandingDrift() ? "yes" : "no"}`,
    `lastIdleTimeoutAt=${d.lastIdleTimeoutAt || "none"}`,
    `lastIdleTimeoutMs=${d.lastIdleTimeoutMs ?? "none"}`,
    `lastIdleAttempt=${d.lastIdleAttempt ?? "none"}`,
    `streamIdleTimeoutMs=${process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS || "0(disabled)"}`,
    `resumeIdleTimeoutMs=${process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS || "0(disabled)"}`,
    `streamIdleMaxRetries=${process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES || "0(disabled)"}`,
    `h2IdleTimeoutMs=${process.env.PI_CURSOR_H2_IDLE_TIMEOUT_MS || "0(disabled)"}`,
    `lifecycleLog=${getLifecycleLogPath()}`,
    `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
    "transport=native-streamSimple",
    "unaryTransport=in-process-h2",
    "runtimeCli=not-used",
    "proxyPath=removed",
    `commands=${CURSOR_ASK_COMMAND} usage|doctor`,
    "hint=On stalls check lifecycle log + lastStreamEvent; InteractionQuery hangs fixed in 1.2.2; re-login or PI_CURSOR_CLIENT_VERSION on wire errors",
  ];
  if (driftSignals.length > 0) {
    lines.push("--- wire drift detail ---");
    for (const s of driftSignals) {
      lines.push(`  ${s.kind}: ${s.detail} (x${s.count}, first ${s.firstSeenIso})`);
    }
    lines.push("  Cursor's agent schema may have moved. See proto/README.md to regenerate,");
    lines.push("  or pin PI_CURSOR_CLIENT_VERSION to a build that matches.");
  }
  return lines.join("\n");
}
