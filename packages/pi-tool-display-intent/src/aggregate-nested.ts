import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AggregateClickRegion } from "./aggregate-interaction.js";
import { getDisplaySummary } from "./display-summary.js";
import { displayThemeSignature } from "./display-theme.js";
import { NESTED_LIMITS, type NestedCall, type NestedRoot } from "./nested-display.js";
import { layoutPreviewRows, MAX_PREVIEW_LAYOUT_ROWS, type PreviewTextTheme } from "./preview-text.js";
import { DISPLAY_LIMITS, displayOmissionRows } from "./display-budget.js";
import type { NestedCallRecord } from "./detail-viewer-model.js";

const PARENT_ROW_LIMIT = 32;
const CHILD_LABEL_ROW_LIMIT = 6;
const CHILD_ERROR_ROW_LIMIT = 2;

export interface NestedCallFormat {
  target(member: { toolName: string; args: Record<string, unknown> }): string;
  duration(ms: number): string;
}

function callsOf(root: NestedRoot): NestedCall[] {
  return [...root.calls.values(), ...root.anonymous];
}

export function nestedFailureCount(root: NestedRoot | undefined): number {
  return root ? callsOf(root).filter(call => call.status === "error").length : 0;
}

export function aggregateNestedSummary(root: NestedRoot | undefined): string | undefined {
  if (!root || (!root.calls.size && !root.anonymous.length && !root.nativeSeen && (!root.hasRecord || root.complete))) return undefined;
  const calls = callsOf(root);
  const count = (status: NestedCall["status"]) => calls.filter(call => call.status === status).length;
  const models = calls.filter(call => call.kind === "model").length;
  const previews = calls.filter(call => call.kind === "preview").length;
  return [
    !root.hasRecord && !calls.length ? "internal calls: count unavailable"
      : `${root.complete && root.hasRecord ? "" : "at least "}${calls.length} internal calls`,
    count("error") ? `${count("error")} failed` : "",
    count("cancelled") ? `${count("cancelled")} cancelled` : "",
    count("unfinished") ? `${count("unfinished")} unfinished` : "",
    count("running") ? `${count("running")} running` : "",
    models ? `${models} model calls` : "",
    previews ? `${previews} previews` : "",
    !root.hasRecord ? "execution record unavailable" : "",
    !root.complete ? "incomplete / omitted data" : "",
  ].filter(Boolean).join(" · ");
}

export type NestedParentRegion = Omit<AggregateClickRegion, "onClick"> & { action: "toggle" | "details" };

/** Content-relative geometry: the caller adds the Run gutter and any turn/header rows once. */
export function renderNestedParent(options: {
  label: string; summary: string; timing: string; expanded: boolean; canExpand: boolean; indent: number;
  color: string; marker: string; error?: string; detailsLabel: string;
}, width: number, theme: PreviewTextTheme): { lines: string[]; regions: NestedParentRegion[]; indent: number } {
  if (!Number.isFinite(width) || width < 1) return { lines: [], regions: [], indent: 0 };
  width = Math.floor(width);
  const indent = Math.min(options.indent, Math.max(0, width - 3));
  const pad = " ".repeat(indent);
  const marker = options.canExpand ? theme.fg(options.color, options.expanded ? "▾" : "▸") : options.marker;
  const mainAction = options.canExpand ? "toggle" : "details";
  const detailsLabel = options.detailsLabel;
  const name = truncateToWidth(options.label, Math.max(1, width - indent - 2), "…");
  const title = `${marker} ${name} · ${options.summary}${options.timing ? ` · ${options.timing}` : ""}`;
  const lines: string[] = [];
  const regions: NestedParentRegion[] = [];
  if (!options.error && indent + visibleWidth(title) + 2 + visibleWidth(detailsLabel) <= width) {
    const startColumn = width - visibleWidth(detailsLabel);
    lines.push(pad + title + " ".repeat(startColumn - indent - visibleWidth(title)) + theme.fg("accent", detailsLabel));
    regions.push({ action: mainAction, startRow: 0, endRow: 1, startColumn: indent, endColumn: startColumn });
    regions.push({ action: "details", startRow: 0, endRow: 1, startColumn, endColumn: width });
  } else {
    // Keep the sole details entry outside the bounded title, even at extremely narrow widths.
    const layout = layoutPreviewRows([title], PARENT_ROW_LIMIT, width - indent);
    lines.push(...layout.rows.map(row => pad + row));
    if (layout.rowLimitReached || layout.longLineTruncated || layout.safetyLimitReached) {
      lines[lines.length - 1] = truncateToWidth(lines.at(-1)!, Math.max(0, width - 1), "") + "…";
    }
    if (options.error) {
      const error = layoutPreviewRows([options.error], CHILD_ERROR_ROW_LIMIT, width - indent);
      if ((error.rowLimitReached || error.longLineTruncated || error.safetyLimitReached) && error.rows.length) {
        error.rows[error.rows.length - 1] = truncateToWidth(error.rows.at(-1)!, Math.max(0, width - indent - 1), "") + "…";
      }
      lines.push(...error.rows.map(row => pad + theme.fg("error", row)));
    }
    regions.push({ action: mainAction, startRow: 0, endRow: lines.length, startColumn: indent, endColumn: width });
    const startColumn = Math.min(indent + 2, Math.max(0, width - visibleWidth(detailsLabel)));
    for (const row of wrapTextWithAnsi(detailsLabel, width - startColumn)) {
      regions.push({ action: "details", startRow: lines.length, endRow: lines.length + 1, startColumn, endColumn: startColumn + visibleWidth(row) });
      lines.push(" ".repeat(startColumn) + theme.fg("accent", row));
    }
  }
  return { lines, regions, indent };
}

function callRows(call: NestedCall, root: NestedRoot, args: string | undefined, width: number, parentIndent: number, format: NestedCallFormat, theme: PreviewTextTheme): string[] {
  let parent = call.parentId, depth = 0;
  const seen = new Set<string>();
  while (parent && parent !== root.id && depth < 12 && !seen.has(parent)) {
    seen.add(parent); depth++;
    parent = root.calls.get(parent)?.parentId;
  }
  const indent = " ".repeat(Math.min(parentIndent + (depth + 1) * 2, Math.max(parentIndent + 2, width - 4)));
  const marker = { running: "…", ok: "●", error: "!", cancelled: "⊘", unfinished: "?" }[call.status];
  const color = { running: "warning", ok: "success", error: "error", cancelled: "warning", unfinished: "muted" }[call.status];
  const name = call.name === "bash" ? "Bash" : call.name;
  let label = `${call.kind === "model" ? "model " : ""}${name}`;
  if (args === undefined) {
    label += call.argumentBytes === undefined ? " (arguments unavailable/omitted)" : ` (arguments omitted: ${call.argumentBytes} UTF-8 bytes)`;
  } else if (call.preview) {
    label += ` ${args.replace(/\s+/g, " ")} (argument preview)`;
  } else {
    try {
      // Only parse the store's bounded, sanitized JSON; never inspect tool-owned values again.
      const parsed = JSON.parse(args);
      const intent = call.name === "bash" ? getDisplaySummary(parsed) : undefined;
      label = intent ? `Bash — ${intent}` : format.target({ toolName: call.name, args: parsed });
    } catch { label += " (arguments unavailable)"; }
  }
  const duration = call.durationMs === undefined ? "" : ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : format.duration(call.durationMs)}`;
  const parentNote = call.kind === "tool" && call.parentId === undefined ? " · parent unknown" : "";
  const contentWidth = Math.max(1, width - indent.length - 2);
  const boundedRows = (text: string, maxRows: number) => {
    const layout = layoutPreviewRows([text], maxRows, contentWidth);
    const rows = layout.rows;
    if ((layout.rowLimitReached || layout.longLineTruncated || layout.safetyLimitReached) && rows.length) {
      rows[rows.length - 1] = truncateToWidth(rows.at(-1)!, Math.max(0, contentWidth - 1), "") + "…";
    }
    return rows;
  };
  const rows = boundedRows(`${label}${duration}${parentNote}`, CHILD_LABEL_ROW_LIMIT)
    .map((row, index) => `${indent}${index === 0 ? theme.fg(color, marker) : " "} ${row}`);
  if (call.error) rows.push(...boundedRows(call.error.replace(/\s+/g, " "), CHILD_ERROR_ROW_LIMIT).map(row => `${indent}  ${theme.fg("error", row)}`));
  return rows.map(row => truncateToWidth(row, width, "…"));
}

export type NestedChildRegion = Omit<AggregateClickRegion, "onClick"> & { action: "child"; call: NestedCallRecord };
export interface NestedChildLayout { lines: string[]; regions: NestedChildRegion[] }

/** Final rows and their identities are capped together. No later text renderer can change the hit geometry. */
function childLayout(root: NestedRoot, width: number, parentIndent: number, maxRows: number, format: NestedCallFormat, theme: PreviewTextTheme): NestedChildLayout {
  const lines: string[] = [];
  const regions: NestedChildRegion[] = [];
  const rowLimit = Number.isFinite(maxRows) ? Math.max(0, Math.min(MAX_PREVIEW_LAYOUT_ROWS, Math.floor(maxRows))) : MAX_PREVIEW_LAYOUT_ROWS;
  // Match PreviewText's bounded content allowance, accounting for terminal padding as well as ANSI.
  let remainingUnits = Math.floor(DISPLAY_LIMITS.units / 3);
  let remainingBytes = NESTED_LIMITS.totalArgumentBytes;
  let count = 0, omitted = false, previews = false;
  const append = (row: string): boolean => {
    const shown = theme.fg("toolOutput", truncateToWidth(row, width, "…"));
    const units = Math.max(width, shown.length) + 1;
    if (lines.length >= rowLimit || units > remainingUnits) return false;
    lines.push(shown);
    remainingUnits -= units;
    return true;
  };
  for (const call of callsOf(root)) {
    if (count++ >= NESTED_LIMITS.calls) { omitted = true; break; }
    let args = call.args;
    if (call.bytes > remainingBytes) { args = undefined; omitted = true; }
    else remainingBytes -= call.bytes;
    previews ||= call.preview === true;
    const startRow = lines.length;
    let clipped = false;
    for (const row of callRows(call, root, args, width, parentIndent, format, theme)) {
      if (!append(row)) { omitted = clipped = true; break; }
    }
    if (lines.length > startRow) {
      // Values come from the store, not tool-owned objects. Capture the record painted by this frame,
      // including anonymous previews with repeated IDs; never resolve it later by name or array index.
      const snapshot: NestedCallRecord = Object.freeze({
        id: call.id, name: call.name, kind: call.kind, status: call.status, parentId: call.parentId,
        args, preview: call.preview, argumentBytes: call.argumentBytes,
        durationMs: call.durationMs, error: call.error, cost: call.cost,
      });
      regions.push({ action: "child", startRow, endRow: lines.length, call: snapshot });
    }
    if (clipped) break;
  }
  if (previews) {
    for (const row of wrapTextWithAnsi("Argument previews are not full arguments.", width)) {
      if (!append(row)) { omitted = true; break; }
    }
  }
  // Omission/preview notices intentionally have no call identity or click region.
  if (omitted) lines.push(...displayOmissionRows(width));
  return { lines, regions };
}

const previews = new WeakMap<NestedRoot, { revision: number; width: number; parentIndent: number; maxRows: number; colors: string; format: NestedCallFormat; layout: NestedChildLayout }>();
export function renderNestedChildren(root: NestedRoot | undefined, width: number, parentIndent: number, theme: PreviewTextTheme, expanded: boolean, maxRows: number, format: NestedCallFormat): NestedChildLayout {
  if (!root || !expanded || !Number.isFinite(width) || width <= parentIndent + 2) return { lines: [], regions: [] };
  width = Math.floor(width);
  const colors = displayThemeSignature(theme, ["toolOutput", "success", "error", "warning", "muted"]);
  let cached = previews.get(root);
  if (!cached || cached.revision !== root.revision || cached.width !== width || cached.parentIndent !== parentIndent || cached.maxRows !== maxRows || cached.colors !== colors || cached.format !== format) {
    cached = { revision: root.revision, width, parentIndent, maxRows, colors, format, layout: childLayout(root, width, parentIndent, maxRows, format, theme) };
    previews.set(root, cached);
  }
  return cached.layout;
}
