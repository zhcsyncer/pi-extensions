import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { displayField as field } from "./display-budget.js";
import { formatFlatArgumentPreview } from "./arg-preview.js";
import { PreviewText, type PreviewTextOptions, type PreviewTextTheme } from "./preview-text.js";
import { NESTED_LIMITS, nestedArrayLength, type NestedCall, type NestedDisplayStore, type NestedRoot } from "./nested-display.js";
import { nativeView, NATIVE_NESTED_OMISSION } from "./native-nested-view.js";

type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Context = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
type NativeView = ReturnType<typeof nativeView>;

function callLine(call: NestedCall, root: NestedRoot, args: string | undefined): string {
  let parent = call.parentId, depth = 0;
  const seen = new Set<string>();
  while (parent && parent !== root.id && depth < 12 && !seen.has(parent)) {
    seen.add(parent); depth++;
    parent = root.calls.get(parent)?.parentId;
  }
  const icon = { running: "…", ok: "✓", error: "✗", cancelled: "⊘", unfinished: "?" }[call.status];
  const duration = call.durationMs === undefined ? "" : ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`;
  const missing = call.argumentBytes === undefined ? "arguments unavailable/omitted" : `arguments omitted (${call.argumentBytes} UTF-8 bytes)`;
  let argument = args === undefined ? `(${missing})` : args;
  if (args !== undefined && !call.preview) {
    // Reuse the existing concise/sensitive-argument policy; parse only our bounded JSON.
    try { argument = formatFlatArgumentPreview(JSON.parse(args)); } catch { argument = "(arguments unavailable)"; }
  }
  const parentNote = call.kind === "tool" && call.parentId === undefined ? " · parent unknown" : "";
  const kind = call.kind === "model" ? "model " : "";
  return `${"  ".repeat(depth)}${icon} ${kind}${call.name} [${call.status}] ${argument}${call.preview ? " (argument preview)" : ""}${duration}${parentNote}${call.error ? `\n${"  ".repeat(depth + 1)}${call.error}` : ""}`;
}

export function nestedNotice(root: NestedRoot | undefined): string | undefined {
  if (!root || (!root.hasRecord && !root.nativeSeen && !root.calls.size)) return undefined;
  const calls = [...root.calls.values()];
  const tools = calls.filter(call => call.kind === "tool").length;
  const failures = calls.filter(call => call.status === "error").length;
  const cancelled = calls.filter(call => call.status === "cancelled").length;
  const unfinished = calls.filter(call => call.status === "unfinished").length;
  return [root.hasRecord ? `Nested tools: ${root.complete ? "" : "at least "}${tools} recorded` : "Native progress (execution record unavailable)",
    failures ? `${failures} failed` : "", cancelled ? `${cancelled} cancelled` : "", unfinished ? `${unfinished} unfinished` : "",
    root.complete ? "" : "incomplete / omitted data",
  ].filter(Boolean).join(" · ");
}

function supplement(root: NestedRoot | undefined, native?: NativeView): string[] {
  const lines: string[] = [];
  let omitted = native?.omitted ?? false;
  if (root) {
    const notice = nestedNotice(root);
    if (notice) lines.push(notice);
    let remaining = NESTED_LIMITS.totalArgumentBytes - (native?.bytes ?? 0);
    let count = native?.count ?? 0;
    for (const call of [...root.calls.values(), ...root.anonymous]) {
      if (native && (native.ids.has(call.id) || call.id.endsWith("/?") || (native.pendingIdentity && call.parentId === root.id && call.kind === "tool"))) continue;
      if (count++ >= NESTED_LIMITS.calls) { omitted = true; break; }
      let args = call.args;
      if (call.bytes > remaining) { args = undefined; omitted = true; }
      else remaining -= call.bytes;
      lines.push(callLine(call, root, args));
    }
    if (notice && root.history) lines.push("Nested result bodies are not stored; unavailable in history.");
  }
  if (native && (native.count || native.omitted)) lines.push("Native arguments above are previews, not full arguments.");
  if (omitted) lines.unshift(NATIVE_NESTED_OMISSION);
  return lines;
}

export function prepareNestedCall(store: NestedDisplayStore, theme: PreviewTextTheme, context: Context, maxRows: number): PreviewText | undefined {
  if (!context?.toolCallId || !context.executionStarted) return undefined;
  store.bind(context.toolCallId, context.invalidate, context.state);
  const root = store.get(context.toolCallId);
  // Persisted HTML calls are serialized before their result; do not duplicate saved facts there.
  if (!root || root.final) return undefined;
  const lines = supplement(root);
  return lines.length ? new PreviewText({ lines, maxRows, expanded: context.expanded, theme }) : undefined;
}

/** Called at the SDK update boundary, not on every terminal frame. */
export function prepareNestedResult(
  store: NestedDisplayStore, toolName: string, knownNative: boolean, delegated: boolean,
  result: Result, expanded: boolean, theme: PreviewTextTheme, context: Context, maxRows: number, includeFacts = true,
): { result: Result; after?: PreviewText } {
  const rootId = context?.toolCallId;
  if (rootId && context.invalidate) store.bind(rootId, context.invalidate, context.state);
  let root = includeFacts && rootId ? store.get(rootId, true) : undefined;
  const native = knownNative && delegated && toolName === "codemode" ? nativeView(result) : undefined;
  // Legacy codemode history can still carry native previews when its extension is absent.
  if (!delegated && toolName === "codemode" && !nestedNotice(root) && nestedArrayLength(field(field(result, "details"), "calls"))) {
    const saved = nativeView(result);
    root = { id: rootId ?? "", calls: new Map(), anonymous: saved.rows, bytes: saved.bytes, complete: !saved.omitted,
      hasRecord: false, history: !context?.isPartial, final: !context?.isPartial, nativeSeen: true, revision: 0 };
  }
  const lines = supplement(root, native);
  return {
    result: native?.result ?? result,
    ...(lines.length ? { after: new PreviewText({ lines, maxRows, expanded, theme }) } : {}),
  };
}

// Aggregate uses the same bounded text/layout policy, one current component per root.
const aggregatePreviews = new WeakMap<NestedRoot, { revision: number; options: PreviewTextOptions; component: PreviewText }>();
export function renderNestedActivity(root: NestedRoot | undefined, width: number, theme: PreviewTextTheme, expanded: boolean, maxRows: number): string[] {
  if (!root || !nestedNotice(root)) return [];
  let cached = aggregatePreviews.get(root);
  if (!cached || cached.revision !== root.revision) {
    const options = { lines: supplement(root), maxRows, expanded, theme };
    cached = { revision: root.revision, options, component: new PreviewText(options) };
    aggregatePreviews.set(root, cached);
  }
  cached.options.theme = theme;
  cached.options.expanded = expanded;
  cached.options.maxRows = maxRows;
  return cached.component.render(width);
}
