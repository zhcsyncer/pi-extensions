import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolDefinition,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatFlatArgumentPreview } from "./arg-preview.js";
import {
  AggregateProjection,
  registerAggregateProjectionEvents,
} from "./aggregate-activity.js";
import { setAggregateCallPresentationLookup } from "./call-presentation-registry.js";
import { renderBashCall } from "./bash-display.js";
import {
  normalizeDisplaySummary,
  stripDisplaySummary,
  withDisplaySummary,
} from "./display-summary.js";
import {
  buildDeterministicDisplaySummary,
  resolveDisplaySummaryForTool,
} from "./display-summary-fallback.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import { createCleanupScope, type CleanupScope } from "./disposable.js";
import { createToolRendererComposer } from "./renderer-shell.js";
import {
  registerLiveToolCallEvents,
  shouldShowDeterministicFallback,
} from "./live-tool-call.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  splitLines,
} from "./render-utils.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import { MAX_PREVIEW_LAYOUT_ROWS, PreviewText } from "./preview-text.js";
import { renderPathCall } from "./path-call.js";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
  readWorkspaceUtf8File,
  type PendingDiffPreviewData,
} from "./pending-diff-preview.js";
import {
  getTextField,
  isMcpToolCandidate,
  toRecord,
} from "./tool-metadata.js";
import {
  applyToolResultStyle,
  formatClaudeToolCall,
} from "./tool-call-style.js";
import { BUILT_IN_TOOL_OVERRIDE_NAMES } from "./types.js";
import { normalizeCustomToolOverrideEntry } from "./config-store.js";
import type {
  BuiltInToolOverrideName,
  CustomToolOverrideConfig,
  ToolDisplayConfig,
} from "./types.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

interface BuiltInTools {
  read: ReturnType<typeof createReadToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
}

type ConfigGetter = () => ToolDisplayConfig;

interface RuntimeToolDefinition {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  prepareArguments?: unknown;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderResult?: (result: Record<string, unknown>, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<unknown>;
  renderShell?: unknown;
  [key: string]: unknown;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  executionStarted?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  invalidate?: () => void;
  lastComponent?: unknown;
}

export interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

const RTK_COMPACTION_LABEL = "compacted by RTK";
export const WRITE_EXECUTION_META_LIMIT = 100;
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayIntentWriteExecutionMeta";
const EDIT_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayIntentEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayIntentWritePendingPreview";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display-intent.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display-intent.pendingDecorations.v1");
const TOOL_DISPLAY_DECORATED_PROPERTIES = [
  "renderCall",
  "renderResult",
  "renderShell",
] as const;

type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";
type ToolDisplayOutputMode = CustomToolOverrideConfig["outputMode"] | "inherit";

export interface ToolDisplayCallPresentation {
  target: string;
  metadata?: string[];
}

export interface ToolDisplayResultPresentation {
  summary: string;
  previewStartLine?: number;
}

export interface ToolDisplayAdapter {
  id?: string;
  toolName?: string;
  kind?: ToolDisplayKind;
  overrideExistingRenderers?: boolean;
  outputMode?: ToolDisplayOutputMode;
  getCallPresentation?: (args: unknown) => ToolDisplayCallPresentation | undefined;
  getResultPresentation?: (result: unknown) => ToolDisplayResultPresentation | undefined;
  pathFields?: string[];
  getPath?: (args: unknown) => string | undefined;
  getEditLineCount?: (args: unknown) => number;
  renderCall?: (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => unknown;
  renderResult?: (result: unknown, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
  registerAdapter(adapter: ToolDisplayAdapter): string;
  unregisterAdapter(id: string): boolean;
}

interface PendingToolDisplayDecoration {
  tool: RuntimeToolDefinition;
  adapter?: ToolDisplayAdapter;
}

type GlobalWithToolDisplayApi = typeof globalThis & {
  [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
  [TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: PendingToolDisplayDecoration[];
};

function createBuiltInToolDefinitions(cwd: string): BuiltInTools {
  return {
    read: createReadToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
  };
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const existing = readWorkspaceUtf8File(cwd, rawPath);
  return {
    existed: existing.exists,
    content: existing.content,
  };
}

function formatDisplaySummarySuffix(
  args: unknown,
  toolName: string,
  theme: RenderTheme,
  config: ToolDisplayConfig,
  context?: ToolRenderContextLike,
): string {
  const summary = resolveDisplaySummaryForTool(args, toolName, config.toolIntent);
  if (
    !summary ||
    (summary.source === "fallback" && !shouldShowDeterministicFallback(context))
  ) {
    return "";
  }

  const color = summary.source === "model" ? "accent" : "muted";
  return `${theme.fg("muted", " — ")}${theme.fg(color, summary.text)}`;
}

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "↳ command completed (no output)");
  }
  return theme.fg("muted", "↳ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditPayloadLineCount(value: unknown): number {
  const record = toRecord(value);
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.filter((line): line is string => typeof line === "string").length;
  }
  if (typeof lines === "string") {
    return countTextLines(lines);
  }

  return countTextLines(record.newText);
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits as unknown[] : [];
  if (edits.length > 0) {
    return edits.reduce<number>((total, edit) => {
      return total + getEditPayloadLineCount(edit);
    }, 0);
  }

  return getEditPayloadLineCount(record);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function recordWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
  toolCallId: string,
  meta: WriteExecutionMeta,
): void {
  pendingMetaByToolCallId.delete(toolCallId);
  pendingMetaByToolCallId.set(toolCallId, meta);

  while (pendingMetaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
    const oldestToolCallId: string | undefined = pendingMetaByToolCallId.keys().next().value as string | undefined;
    if (oldestToolCallId === undefined) {
      return;
    }
    pendingMetaByToolCallId.delete(oldestToolCallId);
  }
}

export function clearWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): void {
  pendingMetaByToolCallId.clear();
}

export function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateRecord(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as unknown as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function getPendingDiffPreviewState(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
): PendingDiffPreviewState | undefined {
  const carrier = toStateRecord(context?.state);
  if (!carrier) {
    return undefined;
  }

  const current = carrier[stateKey];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as PendingDiffPreviewState;
  }

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) {
    return compute();
  }

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function buildPendingDiffCallComponent(
  summaryComponent: Component,
  previewData: PendingDiffPreviewData | undefined,
  context: ToolRenderContextLike | undefined,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Component {
  if (!context?.isPartial || !previewData) {
    return summaryComponent;
  }

  const container = new Container();
  container.addChild(summaryComponent);
  if (config.toolCallStyle !== "claude") {
    container.addChild(new Spacer(1));
  }

  if (previewData.notice || typeof previewData.nextContent !== "string") {
    const notice = new Text(theme.fg("warning", previewData.notice || "Preview unavailable."), 0, 0);
    container.addChild(applyToolResultStyle(notice, config.toolCallStyle) as Text);
    return container;
  }

  const diff = renderWriteDiffResult(
    previewData.nextContent,
    {
      expanded: context.expanded === true,
      filePath: previewData.filePath,
      previousContent: previewData.previousContent,
      fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
      headerLabel: previewData.headerLabel,
    },
    config,
    theme,
    "",
  );
  container.addChild(applyToolResultStyle(diff, config.toolCallStyle) as typeof diff);
  return container;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function getRtkCompactionInfoIfApplied(
  details: unknown,
  config: ToolDisplayConfig,
): RtkCompactionInfo | undefined {
  if (!config.showRtkCompactionHints) {
    return undefined;
  }
  const info = getRtkCompactionInfo(details);
  return info?.applied ? info : undefined;
}

function withRtkCompactionInfo(
  params: RtkHintParams,
  handler: (info: RtkCompactionInfo) => string,
): string {
  const info = getRtkCompactionInfoIfApplied(params.details, params.config);
  return info ? handler(info) : "";
}

interface RtkHintParams {
  details: unknown;
  config: ToolDisplayConfig;
  theme: RenderTheme;
}

interface PreviewHintContext {
  lines: string[];
  config: ToolDisplayConfig;
  theme: RenderTheme;
  options: ToolRenderResultOptions;
  details: unknown;
}

interface McpPreviewHintContext extends PreviewHintContext {
  truncation: { truncated: boolean; fullOutputPath?: string };
}

function handlePartialResult(
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  message: string,
): Text | undefined {
  return options.isPartial ? partialResultText(theme, message) : undefined;
}

function renderSearchPreview(ctx: PreviewHintContext, expandedOnly = false): Component {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendPreviewHints(p, ctx), expandedOnly);
}

function renderMcpPreview(
  ctx: McpPreviewHintContext,
  expandedOnly = false,
  outputColor?: string,
): Component {
  return renderPreviewText(
    ctx.lines,
    ctx.config,
    ctx.theme,
    ctx.options,
    (p) => appendMcpPreviewHints(p, ctx),
    expandedOnly,
    outputColor,
  );
}

function formatRtkSummarySuffix(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const segments: string[] = [RTK_COMPACTION_LABEL];

    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      segments.push(techniqueText);
    }
    if (info.truncated) {
      segments.push("RTK removed content");
    }

    if (segments.length === 0) {
      return "";
    }

    return theme.fg("warning", ` • ${segments.join(" • ")}`);
  });
}

function getExpandedPreviewRowLimit(config: ToolDisplayConfig): number {
  const limit = Math.max(0, config.expandedPreviewMaxRows);
  return limit === 0 ? MAX_PREVIEW_LAYOUT_ROWS : limit;
}

function formatRtkPreviewHint(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const hints: string[] = [];
    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
    } else {
      hints.push(`${RTK_COMPACTION_LABEL} applied`);
    }

    if (
      info.originalLineCount !== undefined &&
      info.compactedLineCount !== undefined &&
      info.originalLineCount > info.compactedLineCount
    ) {
      hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
    }

    if (info.truncated) {
      hints.push("RTK removed content");
    }

    return hints.length > 0
      ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
      : "";
  });
}

function appendRtkPreviewHints(preview: string, ctx: PreviewHintContext): string {
  return preview + formatRtkPreviewHint(ctx);
}

function appendMcpPreviewHints(preview: string, ctx: McpPreviewHintContext): string {
  const { config, theme, truncation } = ctx;
  if (config.showTruncationHints && (truncation.truncated || truncation.fullOutputPath)) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }
  return appendRtkPreviewHints(preview, ctx);
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, details } = ctx;
  if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  return appendRtkPreviewHints(preview, ctx);
}

function renderPreviewText(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  appendHints: (preview: string) => string,
  expandedOnly: boolean = false,
  outputColor?: string,
): Component {
  const useExpanded = expandedOnly || options.expanded;
  return new PreviewText({
    lines,
    maxRows: useExpanded
      ? getExpandedPreviewRowLimit(config)
      : config.previewRows,
    theme,
    expanded: useExpanded,
    outputColor,
    emptyText: theme.fg("muted", "↳ (no output)"),
    expandedRowCap: useExpanded ? config.expandedPreviewMaxRows : undefined,
    appendHints,
  });
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function getBashPreviewRowLimit(
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): number {
  return options.expanded
    ? getExpandedPreviewRowLimit(config)
    : config.previewRows;
}

type ToolRenderInput = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

const TOOL_ERROR_SUMMARY_MAX_LENGTH = 240;

class SingleLineResultText implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    return safeWidth > 0 ? [truncateToWidth(this.text, safeWidth, "…")] : [];
  }

  invalidate(): void {
    // Stateless component.
  }
}

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function getToolErrorSummary(rawOutput: string): string {
  for (const line of rawOutput.replace(/\r/g, "").split("\n")) {
    const summary = normalizeDisplaySummary(line, TOOL_ERROR_SUMMARY_MAX_LENGTH);
    if (summary) {
      return summary;
    }
  }
  return "Tool failed.";
}

function renderToolErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: unknown,
): Component {
  const summary = getToolErrorSummary(rawOutput);
  if (!options.expanded) {
    return new SingleLineResultText(
      `${theme.fg("error", `↳ ${summary}`)}${formatExpandHint(theme)}`,
    );
  }

  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return new SingleLineResultText(theme.fg("error", `↳ ${summary}`));
  }

  const truncation = getMcpTruncationDetails(details);
  const mcpCtx: McpPreviewHintContext = {
    lines,
    config,
    theme,
    options,
    details,
    truncation,
  };
  return renderMcpPreview(mcpCtx, true, "error");
}

function partialResultText(theme: RenderTheme, label: string): Text {
  return textResult(theme.fg("warning", label));
}

function renderBashPreviewWithHints(
  lines: string[],
  maxRows: number,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  details: BashToolDetails | undefined,
): Component {
  return new PreviewText({
    lines,
    maxRows,
    theme,
    expanded: options.expanded,
    emptyText: theme.fg("muted", "↳ (no output)"),
    expandedRowCap: options.expanded ? config.expandedPreviewMaxRows : undefined,
    appendHints: (preview) =>
      config.showTruncationHints
        ? preview + formatBashTruncationHints(details, theme)
        : preview,
  });
}

function prepareBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): { lines: string[]; maxRows: number } | undefined {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return undefined;
  }
  const maxRows = getBashPreviewRowLimit(options, config);
  return { lines, maxRows };
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Component {
  const prepared = prepareBashLivePreview(rawOutput, options, config);
  if (!prepared) {
    return textResult("");
  }
  return renderBashPreviewWithHints(prepared.lines, prepared.maxRows, config, theme, options, details);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Component {
  const lines = prepareOutputLines(rawOutput, options);
  const maxRows = getBashPreviewRowLimit(options, config);
  return new PreviewText({
    lines: options.expanded || maxRows > 0 ? lines : [],
    maxRows,
    theme,
    expanded: options.expanded,
    outputColor: "error",
    prefix: theme.fg("error", "↳ command failed"),
    expandedRowCap: options.expanded ? config.expandedPreviewMaxRows : undefined,
    appendHints: (preview) =>
      config.showTruncationHints
        ? preview + formatBashTruncationHints(details, theme)
        : preview,
  });
}

function renderSearchResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Component {
  if (options.isPartial) {
    return partialResultText(theme, "running...");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return textResult("");
  }

  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatArgCountSuffix(argCount: number, theme: RenderTheme): string {
  return argCount === 0
    ? theme.fg("muted", " (no args)")
    : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
}

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
  config: ToolDisplayConfig,
  context?: ToolRenderContextLike,
): Text {
  const toolArgs = toRecord(stripDisplaySummary(args));
  const argCount = Object.keys(toolArgs).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(toolArgs)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;
  const intentSuffix = formatDisplaySummarySuffix(args, toolName, theme, config, context);
  const line = config.toolCallStyle === "claude"
    ? formatClaudeToolCall("mcp", theme.fg("text", target), argSuffix, intentSuffix, theme, context)
    : `${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("text", target)}${argSuffix}${intentSuffix}`;

  return new Text(line, 0, 0);
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  context?: ToolRenderContextLike,
  presentation?: ToolDisplayResultPresentation,
): Component {
  const partial = handlePartialResult(options, theme, "running...");
  if (partial) {
    return partial;
  }

  const rawOutput = extractTextOutput(result);
  if (isToolError(result, context)) {
    return renderToolErrorResult(rawOutput, options, config, theme, result.details);
  }

  if (config.mcpOutputMode === "hidden") {
    return textResult("");
  }

  const outputLines = prepareOutputLines(rawOutput, options);
  const previewStartLine = Math.min(
    outputLines.length,
    normalizePositiveInteger(presentation?.previewStartLine) ?? 0,
  );
  const lines = presentation
    ? [theme.fg("muted", `↳ ${presentation.summary}`), ...outputLines.slice(previewStartLine)]
    : outputLines;
  const truncation = getMcpTruncationDetails(result.details);
  const mcpCtx: McpPreviewHintContext = { lines, config, theme, options, details: result.details, truncation };

  if (config.mcpOutputMode === "summary") {
    if (options.expanded) {
      return renderMcpPreview(mcpCtx, true);
    }

    const lineCount = countNonEmptyLines(outputLines);
    let summary = presentation
      ? theme.fg("muted", `↳ ${presentation.summary}`)
      : theme.fg(
          "muted",
          `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
        );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderMcpPreview(mcpCtx);
}

function isBuiltInToolName(toolName: string): boolean {
  return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

function getRuntimeCustomToolOverride(
  toolName: string,
  config: ToolDisplayConfig,
): CustomToolOverrideConfig | undefined {
  if (!toolName || isBuiltInToolName(toolName)) {
    return undefined;
  }

  const overrides = toRecord((config as unknown as Record<string, unknown>).customToolOverrides);
  return normalizeCustomToolOverrideEntry(overrides[toolName]);
}

function resolveCallPresentation(
  args: Record<string, unknown>,
  adapter: ToolDisplayAdapter,
): ToolDisplayCallPresentation | undefined {
  if (!adapter.getCallPresentation) return undefined;
  try {
    const candidate = adapter.getCallPresentation(args);
    const target = normalizeDisplaySummary(candidate?.target, 160);
    if (!target) return undefined;
    const metadata = Array.isArray(candidate?.metadata)
      ? candidate.metadata
          .map((entry) => normalizeDisplaySummary(entry, 64))
          .filter((entry): entry is string => Boolean(entry))
      : [];
    return { target, metadata };
  } catch (error) {
    logToolDisplayDebug("Tool call presentation failed.", error);
    return undefined;
  }
}

function resolveResultPresentation(
  result: unknown,
  adapter: ToolDisplayAdapter,
): ToolDisplayResultPresentation | undefined {
  if (!adapter.getResultPresentation) return undefined;
  try {
    const candidate = adapter.getResultPresentation(result);
    const summary = normalizeDisplaySummary(candidate?.summary, 200);
    if (!summary) return undefined;
    return {
      summary,
      previewStartLine: normalizePositiveInteger(candidate?.previewStartLine),
    };
  } catch (error) {
    logToolDisplayDebug("Tool result presentation failed.", error);
    return undefined;
  }
}

function formatGenericToolCallLine(
  toolName: string,
  args: unknown,
  theme: RenderTheme,
  config: ToolDisplayConfig,
  context?: ToolRenderContextLike,
  adapter: ToolDisplayAdapter = {},
): Text {
  const argRecord = toRecord(stripDisplaySummary(args));
  const presentation = resolveCallPresentation(argRecord, adapter);
  const intentSuffix = formatDisplaySummarySuffix(args, toolName, theme, config, context);

  if (presentation) {
    const metadata = presentation.metadata?.length
      ? theme.fg("muted", ` · ${presentation.metadata.join(" · ")}`)
      : "";
    const target = `${theme.fg("text", presentation.target)}${metadata}`;
    const line = config.toolCallStyle === "claude"
      ? formatClaudeToolCall(toolName, target, "", intentSuffix, theme, context)
      : `${theme.fg("toolTitle", theme.bold(toolName))} ${target}${intentSuffix}`;
    return new Text(line, 0, 0);
  }

  const argumentPreview = formatFlatArgumentPreview(argRecord);
  const line = config.toolCallStyle === "claude"
    ? formatClaudeToolCall(
        toolName,
        theme.fg("muted", argumentPreview),
        "",
        intentSuffix,
        theme,
        context,
      )
    : `${theme.fg("toolTitle", theme.bold(toolName))} (${theme.fg("muted", argumentPreview)})${intentSuffix}`;
  return new Text(line, 0, 0);
}

function getSearchPath(args: Record<string, unknown>): string {
  return getStringField(args, "path") || ".";
}

function formatSearchCallLine(
  toolName: string,
  path: string,
  buildTarget: (displayPath: string) => string,
  theme: RenderTheme,
  args: unknown,
  config: ToolDisplayConfig,
  context?: ToolRenderContextLike,
): Component {
  const intentSuffix = formatDisplaySummarySuffix(args, toolName, theme, config, context);
  return renderPathCall(
    path,
    (displayPath) => {
      const target = buildTarget(displayPath);
      return config.toolCallStyle === "claude"
        ? formatClaudeToolCall(toolName, target, "", intentSuffix, theme, context)
        : `${theme.fg("toolTitle", theme.bold(toolName))} ${target}${intentSuffix}`;
    },
    context,
  );
}

function renderCustomToolResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  outputMode: CustomToolOverrideConfig["outputMode"],
  theme: RenderTheme,
  context?: ToolRenderContextLike,
  adapter: ToolDisplayAdapter = {},
): Component {
  return renderMcpResult(
    result as ToolRenderInput,
    options,
    { ...config, mcpOutputMode: outputMode },
    theme,
    context,
    resolveResultPresentation(result, adapter),
  );
}

function getAdapterKind(tool: RuntimeToolDefinition, adapter: ToolDisplayAdapter): ToolDisplayKind {
  if (adapter.kind) {
    return adapter.kind;
  }
  if (tool.name === "read" || tool.name === "edit") {
    return tool.name;
  }
  return isMcpToolCandidate(tool) ? "mcp" : "generic";
}

function getAdapterPath(args: unknown, adapter: ToolDisplayAdapter): string | undefined {
  const explicitPath = adapter.getPath?.(args);
  if (explicitPath) {
    return explicitPath;
  }

  for (const field of adapter.pathFields ?? ["file_path", "path"]) {
    const value = getStringField(args, field);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function renderReadDisplayCall(
  args: unknown,
  theme: RenderTheme,
  adapter: ToolDisplayAdapter = {},
  config?: ToolDisplayConfig,
  context?: ToolRenderContextLike,
 ): Component {
  const path = getAdapterPath(args, adapter);
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  let suffix = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    suffix = to ? `:${from}-${to}` : `:${from}`;
  }
  const intentSuffix = config ? formatDisplaySummarySuffix(args, "read", theme, config, context) : "";
  return renderPathCall(
    path,
    (displayPath) => {
      const target = `${theme.fg("text", displayPath)}${theme.fg("warning", suffix)}`;
      return config?.toolCallStyle === "claude"
        ? formatClaudeToolCall("read", target, "", intentSuffix, theme, context)
        : `${theme.fg("toolTitle", theme.bold("read"))} ${target}${intentSuffix}`;
    },
    context,
  );
}

function renderReadDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
 ): Component {
  if (options.isPartial) {
    return partialResultText(theme, "reading...");
  }

  if (config.readOutputMode === "hidden") {
    return textResult("");
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    const summaryLines = compactOutputLines(splitLines(rawOutput), {
      expanded: true,
    });
    let summary = formatReadSummary(
      summaryLines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function renderEditDisplayCall(
  args: unknown,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): Component {
  const path = getAdapterPath(args, adapter);
  const lineCount = adapter.getEditLineCount?.(args) ?? getEditLineCount(args);
  const config = getConfig();
  const lineCountSuffix = formatLineCountSuffix(lineCount, theme);
  const intentSuffix = formatDisplaySummarySuffix(args, "edit", theme, config, context);
  const summaryComponent = renderPathCall(
    path,
    (displayPath) => config.toolCallStyle === "claude"
      ? formatClaudeToolCall("edit", theme.fg("text", displayPath), lineCountSuffix, intentSuffix, theme, context)
      : `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("text", displayPath)}${lineCountSuffix}${intentSuffix}`,
    context,
  );
  if (!context?.argsComplete || !context.isPartial) {
    return summaryComponent;
  }

  const previewKey = JSON.stringify({
    path: getAdapterPath(args, adapter) ?? null,
    edits: toRecord(args).edits ?? null,
    oldText: getStringField(args, "oldText") ?? null,
    newText: getStringField(args, "newText") ?? null,
  });
  const previewData = resolvePendingDiffPreview(
    context,
    EDIT_PENDING_PREVIEW_STATE_KEY,
    previewKey,
    () => buildPendingEditPreviewData(args, context.cwd),
  );
  return buildPendingDiffCallComponent(summaryComponent, previewData, context, getConfig(), theme);
}

function renderEditDisplayResult(
  result: ToolRenderInput & { isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): unknown {
  const lineCount = adapter.getEditLineCount?.(context?.args) ?? getEditLineCount(context?.args);
  const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "editing", "Edit failed.");
  if (earlyResult) {
    return earlyResult;
  }

  const config = getConfig();
  const details = result.details as EditToolDetails | undefined;
  return renderEditDiffResult(
    details,
    { expanded: options.expanded, filePath: getAdapterPath(context?.args, adapter) },
    config,
    theme,
    fallbackText,
  );
}

function handleEditOrWriteResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  context: ToolRenderContextLike | undefined,
  theme: RenderTheme,
  lineCount: number,
  progressLabel: string,
  errorMessage: string,
): { fallbackText: string; earlyResult: Text | undefined } {
  if (options.isPartial) {
    return { fallbackText: "", earlyResult: new Text(formatInProgressLineCount(progressLabel, lineCount, theme), 0, 0) };
  }
  const fallbackText = extractTextOutput(result);
  if (isToolError(result, context)) {
    return { fallbackText, earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)) };
  }
  return { fallbackText, earlyResult: undefined };
}

function drainPendingToolDisplayDecorations(api: ToolDisplayApi, scope: CleanupScope): void {
  const globalWithApi = globalThis as GlobalWithToolDisplayApi;
  const pendingDecorations = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  if (!Array.isArray(pendingDecorations) || pendingDecorations.length === 0) {
    return;
  }

  const entries = pendingDecorations.splice(0);
  for (const entry of entries) {
    if (!entry?.tool || typeof entry.tool !== "object") {
      continue;
    }

    // Only explicit cooperative requests may decorate a real definition in place.
    // Never touch getAllTools() metadata, and never restore over a later owner.
    try {
      const decorated = api.decorateTool(entry.tool, entry.adapter);
      for (const key of TOOL_DISPLAY_DECORATED_PROPERTIES) {
        const before = Object.getOwnPropertyDescriptor(entry.tool, key);
        const value = decorated[key];
        entry.tool[key] = value as never;
        scope.register(() => {
          if (entry.tool[key] !== value) return;
          if (before) Object.defineProperty(entry.tool, key, before);
          else delete entry.tool[key];
        });
      }
    } catch (error) {
      logToolDisplayDebug("Cooperative tool display decoration failed.", error);
    }
  }
}

function installToolDisplayApi(
  getConfig: ConfigGetter,
  scope: CleanupScope,
  composeToolRenderers: ReturnType<typeof createToolRendererComposer>,
) {
  const adapters = new Map<string, ToolDisplayAdapter>();
  const decoratedCallbacks = new Set<unknown>();
  let nextAdapterId = 0;

  const resolveAdapter = (tool: RuntimeToolDefinition, adapter?: ToolDisplayAdapter): ToolDisplayAdapter => {
    if (adapter) {
      return adapter;
    }
    const toolName = getTextField(tool, "name");
    if (toolName) {
      return adapters.get(toolName) ?? {};
    }
    return {};
  };

  const api: ToolDisplayApi = {
    version: 1,
    decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T {
      if (adapter) {
        const toolName = adapter.toolName || getTextField(tool, "name");
        api.registerAdapter({
          ...adapter,
          toolName,
        });
      }
      if (getConfig().toolCallLayout === "aggregate") return tool;
      const resolvedAdapter = resolveAdapter(tool, adapter);
      const kind = getAdapterKind(tool, resolvedAdapter);
      const overrideExisting = resolvedAdapter.overrideExistingRenderers === true;
      const decorated: RuntimeToolDefinition = { ...tool };

      if (resolvedAdapter.renderCall && (overrideExisting || typeof decorated.renderCall !== "function")) {
        decorated.renderCall = resolvedAdapter.renderCall;
      } else if (kind === "read" && (overrideExisting || typeof decorated.renderCall !== "function")) {
        decorated.renderCall = (args: unknown, theme: RenderTheme, context?: ToolRenderContextLike) => renderReadDisplayCall(args, theme, resolvedAdapter, getConfig(), context);
      } else if (kind === "edit" && (overrideExisting || typeof decorated.renderCall !== "function")) {
        decorated.renderCall = (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => renderEditDisplayCall(args, theme, context, resolvedAdapter, getConfig);
      } else if (kind === "mcp" && (overrideExisting || typeof decorated.renderCall !== "function")) {
        decorated.renderCall = (args: unknown, theme: RenderTheme, context?: ToolRenderContextLike) => {
          const toolName = getTextField(decorated, "name") ?? "mcp";
          const toolLabel = getTextField(decorated, "label") ?? (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
          return formatMcpCallLine(toolName, toolLabel, toRecord(args), theme, getConfig(), context);
        };
      } else if (kind === "generic" && (overrideExisting || typeof decorated.renderCall !== "function")) {
        decorated.renderCall = (args: unknown, theme: RenderTheme, context?: ToolRenderContextLike) => {
          const toolName = getTextField(decorated, "name") ?? "tool";
          return formatGenericToolCallLine(toolName, args, theme, getConfig(), context, resolvedAdapter);
        };
      }

      if (resolvedAdapter.renderResult && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = resolvedAdapter.renderResult;
      } else if (kind === "read" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: ToolRenderInput, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderReadDisplayResult(result, options, getConfig(), theme);
      } else if (kind === "edit" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: ToolRenderInput & { isError?: boolean }, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) =>
          renderEditDisplayResult(result, options, theme, context, resolvedAdapter, getConfig);
      } else if (
        (kind === "mcp" || (kind === "generic" && resolvedAdapter.outputMode !== undefined)) &&
        (overrideExisting || typeof decorated.renderResult !== "function")
      ) {
        decorated.renderResult = (
          result: ToolRenderInput,
          options: ToolRenderResultOptions,
          theme: RenderTheme,
          context?: ToolRenderContextLike,
        ) => {
          const config = getConfig();
          const outputMode = resolvedAdapter.outputMode === undefined || resolvedAdapter.outputMode === "inherit"
            ? config.mcpOutputMode
            : resolvedAdapter.outputMode;
          return renderCustomToolResult(result, options, config, outputMode, theme, context, resolvedAdapter);
        };
      }

      Object.assign(decorated, composeToolRenderers(
        decorated as unknown as ToolRenderers,
        tool as unknown as ToolRenderers,
        {
          style: getConfig().toolCallStyle, run: scope.run,
          native: overrideExisting ? {
            renderCall: decorated.renderCall !== tool.renderCall ? tool.renderCall : undefined,
            renderResult: decorated.renderResult !== tool.renderResult ? tool.renderResult : undefined,
          } as unknown as ToolRenderers : undefined,
        },
      ));
      decoratedCallbacks.add(decorated.renderCall);
      decoratedCallbacks.add(decorated.renderResult);
      return decorated as T;
    },
    registerAdapter(adapter: ToolDisplayAdapter): string {
      const id = adapter.id || adapter.toolName || `adapter-${++nextAdapterId}`;
      adapters.set(id, { ...adapter, id });
      if (adapter.toolName) {
        adapters.set(adapter.toolName, { ...adapter, id });
      }
      return id;
    },
    unregisterAdapter(id: string): boolean {
      const adapter = adapters.get(id);
      const removed = adapters.delete(id);
      if (adapter?.toolName) {
        adapters.delete(adapter.toolName);
      }
      return removed;
    },
  };

  const globalWithApi = globalThis as GlobalWithToolDisplayApi;
  globalWithApi[TOOL_DISPLAY_API_KEY] = api;
  setAggregateCallPresentationLookup((toolName, args) => {
    const adapter = adapters.get(toolName);
    if (!adapter?.getCallPresentation) return undefined;
    return resolveCallPresentation(toRecord(stripDisplaySummary(args)), adapter);
  });
  drainPendingToolDisplayDecorations(api, scope);
  return { api, adapters, decoratedCallbacks };
}

function tryGetAllTools(pi: ExtensionAPI, debugMessage: string): unknown[] | undefined {
  try {
    return pi.getAllTools();
  } catch (error) {
    logToolDisplayDebug(debugMessage, error);
    return undefined;
  }
}

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  const scope = createCleanupScope();
  const composeToolRenderers = createToolRendererComposer();
  const clearLiveCalls = registerLiveToolCallEvents(pi);
  const { api: toolDisplayApi, adapters, decoratedCallbacks } = installToolDisplayApi(getConfig, scope, composeToolRenderers);
  scope.register(() => {
    clearLiveCalls();
    const globalWithApi = globalThis as GlobalWithToolDisplayApi;
    if (globalWithApi[TOOL_DISPLAY_API_KEY] === toolDisplayApi) {
      delete globalWithApi[TOOL_DISPLAY_API_KEY];
      setAggregateCallPresentationLookup(undefined);
    }
  });
  pi.on("session_shutdown", () => scope.dispose());
  const bootstrapTools = createBuiltInToolDefinitions(process.cwd());
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
  scope.register(() => clearWriteExecutionMeta(writeExecutionMetaByToolCallId));
  const builtInDisplays = new Map<string, RuntimeToolDefinition>();
  const aggregateProjection = getConfig().toolCallLayout === "aggregate"
    ? new AggregateProjection(
        (toolName) =>
          getConfig().passthroughToolNames.includes(toolName) ||
          ((BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName) &&
            !getConfig().registerToolOverrides[toolName as BuiltInToolOverrideName]),
        () => getConfig().expandedTimeline,
        () => getConfig().showContextGrowth,
      )
    : undefined;
  const registerOwnedTool = (tool: RuntimeToolDefinition): void => {
    builtInDisplays.set(tool.name!, tool);
  };
  const registerIfOwned = (toolName: BuiltInToolOverrideName, register: () => void): void => {
    if (getConfig().registerToolOverrides[toolName]) register();
  };

  function createBuiltinToolBase(toolName: keyof BuiltInTools) {
    // Keep the definition, not an AgentTool reconstruction: schemas, sampling,
    // prepare/exposure/loadout and the SDK's context-aware execute all survive.
    return { ...bootstrapTools[toolName] };
  }

  const renderSearchToolResult = (
    result: ToolRenderInput,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    unitLabel: string,
    pluralLabel?: string,
  ): Component => {
    const config = getConfig();
    return renderSearchResult(result as never, options, config, theme, unitLabel, result.details, pluralLabel);
  };

  const buildSearchCallSuffix = (args: Record<string, unknown>): { path: string; limitSuffix: string } => {
    return { path: getSearchPath(args), limitSuffix: args.limit !== undefined ? ` (limit ${args.limit})` : "" };
  };

  registerIfOwned("read", () => {
    registerOwnedTool({
      name: "read",
      label: "read",
      ...createBuiltinToolBase("read"),
      renderCall(args, theme, context) {
        return renderReadDisplayCall(args, theme, {}, getConfig(), context);
      },
      renderResult(result, options, theme) {
        return renderReadDisplayResult(result, options, getConfig(), theme);
      },
    });
  });

  registerIfOwned("grep", () => {
    registerOwnedTool({
      name: "grep",
    label: "grep",
    ...createBuiltinToolBase("grep"),
    renderCall(args, theme, context) {
      const path = getSearchPath(args);
      const globSuffix = args.glob ? ` (${args.glob})` : "";
      const limitSuffix =
        args.limit !== undefined ? ` limit ${args.limit}` : "";
      return formatSearchCallLine(
        "grep",
        path,
        (displayPath) => `${theme.fg("text", `/${args.pattern}/`)}${theme.fg("muted", ` in ${displayPath}${globSuffix}${limitSuffix}`)}`,
        theme,
        args,
        getConfig(),
        context,
      );
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "match", "matches");
    },
    });
  });

  registerIfOwned("find", () => {
    registerOwnedTool({
      name: "find",
    label: "find",
    ...createBuiltinToolBase("find"),
    renderCall(args, theme, context) {
      const { path, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine(
        "find",
        path,
        (displayPath) => `${theme.fg("text", args.pattern as string)}${theme.fg("muted", ` in ${displayPath}${limitSuffix}`)}`,
        theme,
        args,
        getConfig(),
        context,
      );
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "result");
    },
    });
  });

  registerIfOwned("ls", () => {
    registerOwnedTool({
      name: "ls",
    label: "ls",
    ...createBuiltinToolBase("ls"),
    renderCall(args, theme, context) {
      const { path, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine(
        "ls",
        path,
        (displayPath) => `${theme.fg("text", displayPath)}${theme.fg("muted", limitSuffix)}`,
        theme,
        args,
        getConfig(),
        context,
      );
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "entry", "entries");
    },
    });
  });

  registerIfOwned("edit", () => {
    registerOwnedTool({
      name: "edit",
    label: "edit",
    ...createBuiltinToolBase("edit"),
    renderShell: "default",
    renderCall(args, theme, context) {
      return renderEditDisplayCall(args, theme, context, {}, getConfig);
    },
    renderResult(result, options, theme, context) {
      return renderEditDisplayResult(result as never, options, theme, context, {}, getConfig);
    },
    });
  });

  registerIfOwned("write", () => {
    registerOwnedTool({
      name: "write",
    label: "write",
    ...createBuiltinToolBase("write"),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      const executionMeta = {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      };
      recordWriteExecutionMeta(writeExecutionMetaByToolCallId, toolCallId, executionMeta);

      return bootstrapTools.write.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
        ctx as Parameters<BuiltInTools["write"]["execute"]>[4],
      );
    },
    renderCall(args, theme, context) {
      const content = getToolContentArg(args);
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = getToolPathArg(args);
      const suffix = shouldRenderWriteCallSummary({
        hasContent: content !== undefined,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
        : "";
      const config = getConfig();
      const intentSuffix = formatDisplaySummarySuffix(args, "write", theme, config, context);
      const summaryComponent = renderPathCall(
        path,
        (displayPath) => config.toolCallStyle === "claude"
          ? formatClaudeToolCall("write", theme.fg("text", displayPath), suffix, intentSuffix, theme, context)
          : `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("text", displayPath)}${suffix}${intentSuffix}`,
        context,
      );
      if (!context.argsComplete || !context.isPartial) {
        return summaryComponent;
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, content: content ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        WRITE_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingWritePreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryComponent, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "writing", "Write failed.");
      if (earlyResult) {
        return earlyResult;
      }

      const config = getConfig();
      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("bash", () => {
    registerOwnedTool({
      name: "bash",
    label: "bash",
    ...createBuiltinToolBase("bash"),
    renderCall(args, theme, context) {
      const config = getConfig();
      return renderBashCall(
        args,
        theme,
        context as never,
        config.toolIntent,
        config.toolCallStyle,
        config.bashCommandPreviewRows,
      );
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const rawOutput = extractTextOutput(result);

      if (options.isPartial) {
        return renderBashLivePreview(rawOutput, options, config, theme, details);
      }

      if (isToolError(result, context)) {
        return renderBashErrorResult(rawOutput, options, config, theme, details);
      }

      const lines = prepareOutputLines(rawOutput, options);

      if (lines.length === 0) {
        let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
        if (config.showTruncationHints) {
          text += formatBashTruncationHints(details, theme);
        }
        return textResult(text);
      }

      if (config.bashOutputMode === "summary") {
        if (options.expanded) {
          const maxRows = getExpandedPreviewRowLimit(config);
          return renderBashPreviewWithHints(lines, maxRows, config, theme, options, details);
        }

        let summary = formatBashSummary(
          lines,
          details,
          theme,
          config.showTruncationHints,
        );
        summary += formatExpandHint(theme);
        if (config.showTruncationHints) {
          summary += formatBashTruncationHints(details, theme);
        }
        return textResult(summary);
      }

      const maxRows = getBashPreviewRowLimit(options, config);
      return renderBashPreviewWithHints(lines, maxRows, config, theme, options, details);
    },
    });
  });

  const semanticTools = new Set<string>();
  pi.on("session_start", (_event, ctx) => {
    // Wait until all extension factories have registered: a display extension must
    // not win a name conflict against another extension's Bash or Write tool.
    const metadata = tryGetAllTools(pi, "Tool ownership discovery failed.") ?? [];
    for (const name of ["bash", "write"] as const) {
      const owner = metadata.find(tool => getTextField(tool, "name") === name);
      if (semanticTools.has(name) || !getConfig().registerToolOverrides[name] ||
          getConfig().passthroughToolNames.includes(name) ||
          getTextField(toRecord(owner).sourceInfo, "source") !== "builtin") continue;
      if (name === "bash") {
        const settings = pi.getSettings();
        const definition = createBashToolDefinition(ctx.cwd, {
          shellPath: settings.shellPath,
          commandPrefix: settings.shellCommandPrefix,
        });
        bootstrapTools.bash = definition;
        const intent = getConfig().toolIntent;
        pi.registerTool(withDisplaySummary({ ...definition, defaultActive: pi.getActiveTools().includes(name) }, {
          required: true, language: intent.language, maxLength: intent.maxLength,
          preserveRendererArgs: true,
          fallback: () => buildDeterministicDisplaySummary("bash", intent.language, intent.maxLength),
        }));
      } else {
        pi.registerTool({
          ...bootstrapTools.write,
          defaultActive: pi.getActiveTools().includes(name),
          execute: builtInDisplays.get("write")!.execute as ToolDefinition["execute"],
        });
      }
      semanticTools.add(name);
    }
  });

  pi.registerToolRenderer((toolName, next) => {
    const delegate = next();
    const config = getConfig();
    if ((delegate?.renderCall && decoratedCallbacks.has(delegate.renderCall)) ||
        (delegate?.renderResult && decoratedCallbacks.has(delegate.renderResult))) return delegate;
    if (config.passthroughToolNames.includes(toolName) ||
        (isBuiltInToolName(toolName) && !config.registerToolOverrides[toolName as BuiltInToolOverrideName])) {
      return delegate;
    }
    const builtin = builtInDisplays.get(toolName);
    const custom = getRuntimeCustomToolOverride(toolName, config);
    const adapter = adapters.get(toolName) ?? {};
    const metadata = tryGetAllTools(pi, "Tool display metadata unavailable.")?.find(tool => getTextField(tool, "name") === toolName);
    const isMcp = custom?.kind === "mcp" || adapter.kind === "mcp" || isMcpToolCandidate(metadata ?? { name: toolName });
    const own: ToolRenderers = builtin as unknown as ToolRenderers ?? {
      renderCall(args, theme, context) {
        if (isMcp) {
          const name = custom?.kind === "mcp" ? "mcp" : toolName;
          return formatMcpCallLine(name, name === "mcp" ? "MCP Proxy" : `MCP ${name}`, toRecord(args), theme, getConfig(), context);
        }
        return formatGenericToolCallLine(toolName, args, theme, getConfig(), context, adapter);
      },
      renderResult(result, options, theme, context) {
        const config = getConfig();
        const mode = custom?.outputMode ?? (adapter.outputMode === "inherit" ? undefined : adapter.outputMode) ?? config.mcpOutputMode;
        return renderCustomToolResult(result, options, config, mode, theme, context, adapter);
      },
    };
    const renderers = composeToolRenderers(own, delegate, {
      style: config.toolCallStyle,
      native: isBuiltInToolName(toolName) ? bootstrapTools[toolName as BuiltInToolOverrideName] : undefined,
      connectRows: toolName === "bash",
      run: scope.run,
    });
    if (aggregateProjection) {
      const call = renderers.renderCall;
      renderers.renderCall = (args, theme, context) => {
        aggregateProjection.setRenderTheme(theme);
        return call!(args, theme, context);
      };
    }
    return renderers;
  });

  if (aggregateProjection) {
    registerAggregateProjectionEvents(pi, aggregateProjection, { getConfig });
  }
}
