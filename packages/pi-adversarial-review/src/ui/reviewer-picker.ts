import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  truncateToWidth,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { ReviewCommandError } from "../command/parse-args.ts";
import { resolveReviewerRoutes } from "../command/resolve-routes.ts";
import type { ScopedModelEntry } from "../types.ts";

const RUN_ITEM_ID = "__adversarial_review_run__";
const DISABLED = "disabled";

interface PickerRow {
  id: string;
  modelRef: string;
  entry: ScopedModelEntry;
  values: ModelThinkingLevel[];
  remembered?: ModelThinkingLevel;
}

export interface ReviewerPickerOptions {
  ctx: ExtensionCommandContext;
  maxConcurrent: number;
  previousSpecs?: readonly string[];
  signal?: AbortSignal;
}

function modelRef(entry: ScopedModelEntry): string {
  return `${entry.model.provider}/${entry.model.id}`;
}

function parsePreviousSpecs(specs: readonly string[] | undefined): Map<string, string> {
  const previous = new Map<string, string>();
  for (const spec of specs ?? []) {
    const separator = spec.lastIndexOf("@");
    if (separator <= 0 || separator === spec.length - 1) continue;
    previous.set(spec.slice(0, separator), spec.slice(separator + 1));
  }
  return previous;
}

function pickerRows(
  scopedModels: readonly ScopedModelEntry[],
  previousSpecs: readonly string[] | undefined,
): PickerRow[] {
  const previous = parsePreviousSpecs(previousSpecs);
  const seen = new Set<string>();
  const rows: PickerRow[] = [];

  for (const entry of scopedModels) {
    const ref = modelRef(entry);
    if (seen.has(ref)) continue;
    seen.add(ref);

    const supported = getSupportedThinkingLevels(entry.model);
    const values = entry.thinkingLevel === undefined
      ? supported
      : supported.includes(entry.thinkingLevel)
        ? [entry.thinkingLevel]
        : [];
    const remembered = previous.get(ref);
    rows.push({
      id: `model:${ref}`,
      modelRef: ref,
      entry,
      values,
      ...(remembered !== undefined && values.includes(remembered as ModelThinkingLevel)
        ? { remembered: remembered as ModelThinkingLevel }
        : {}),
    });
  }

  return rows;
}

function initialValue(row: PickerRow): string {
  return row.remembered ?? DISABLED;
}

function selectedSpecs(rows: readonly PickerRow[], values: ReadonlyMap<string, string>): string[] {
  const specs: string[] = [];
  for (const row of rows) {
    const value = values.get(row.id) ?? DISABLED;
    if (value !== DISABLED) specs.push(`${row.modelRef}@${value}`);
  }
  return specs;
}

/** Drop remembered routes/thinking levels that are not valid in this scope snapshot. */
export function retainValidReviewerSpecs(
  specs: readonly string[] | undefined,
  scopedModels: readonly ScopedModelEntry[],
): string[] {
  const rows = pickerRows(scopedModels, specs);
  const values = new Map(rows.map((row) => [row.id, initialValue(row)]));
  return selectedSpecs(rows, values);
}

function pickerItems(rows: readonly PickerRow[]): SettingItem[] {
  return [
    ...rows.map((row): SettingItem => {
      const pinned = row.entry.thinkingLevel !== undefined;
      const unavailable = row.values.length === 0;
      return {
        id: row.id,
        label: row.modelRef,
        currentValue: initialValue(row),
        values: unavailable ? [DISABLED] : [DISABLED, ...row.values],
        description: unavailable
          ? "The scope pins a thinking level this model does not support."
          : pinned
            ? `Scope-pinned thinking: ${row.entry.thinkingLevel}. Toggle disabled/pinned.`
            : `${row.entry.model.name ?? row.modelRef}. Select a supported thinking level or disable.`,
      };
    }),
    {
      id: RUN_ITEM_ID,
      label: "▶ Run selected reviewers",
      currentValue: "confirm",
      values: ["confirm"],
      description: "Start with 2–8 distinct scoped models. No reviewer starts before confirmation.",
    },
  ];
}

/**
 * Pick reviewer routes from the current scoped-model snapshot.
 * Returns undefined on Escape or abort and never starts runtime work itself.
 */
export async function pickReviewerSpecs({
  ctx,
  maxConcurrent,
  previousSpecs,
  signal,
}: ReviewerPickerOptions): Promise<string[] | undefined> {
  if (signal?.aborted) return undefined;
  const rows = pickerRows(ctx.scopedModels, previousSpecs);
  if (rows.length === 0) {
    throw new ReviewCommandError(
      "No scoped models are configured. Use /scoped-models before adversarial review.",
    );
  }

  let removeAbortListener = () => {};
  try {
    return await ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
      const items = pickerItems(rows);
      const values = new Map(items.slice(0, rows.length).map((item) => [item.id, item.currentValue]));
      let validationError: string | undefined;
      let settled = false;

      const finish = (result: string[] | undefined) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        done(result);
      };
      const onAbort = () => finish(undefined);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) finish(undefined);
      }

      const list = new SettingsList(
        items,
        Math.min(Math.max(rows.length + 1, 4), 14),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === RUN_ITEM_ID) {
            const specs = selectedSpecs(rows, values);
            try {
              resolveReviewerRoutes(specs, ctx.scopedModels);
              finish(specs);
            } catch (error) {
              validationError = error instanceof Error ? error.message : String(error);
            }
            tui.requestRender();
            return;
          }
          values.set(id, newValue);
          validationError = undefined;
          tui.requestRender();
        },
        () => finish(undefined),
        { enableSearch: true },
      );

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(1, width);
          const count = selectedSpecs(rows, values).length;
          const concurrency = Math.max(1, Math.floor(maxConcurrent));
          const waves = count === 0 ? 0 : Math.ceil(count / concurrency);
          const title = theme.fg("accent", theme.bold("Adversarial review fleet"));
          const summary = theme.fg(
            count >= 2 && count <= 8 ? "muted" : "warning",
            `${count} selected · max concurrent ${concurrency} · ${waves} wave${waves === 1 ? "" : "s"}`,
          );
          const lines = [truncateToWidth(`${title}  ${summary}`, safeWidth, "")];
          if (validationError) {
            lines.push(truncateToWidth(theme.fg("error", validationError), safeWidth, ""));
          }
          // SettingsList assumes enough room for a value column and description padding.
          // Render it at a safe internal width, then enforce the caller's actual width.
          lines.push(...list.render(Math.max(40, safeWidth)).map((line) => (
            truncateToWidth(line, safeWidth, "")
          )));
          return lines;
        },
        invalidate() {
          list.invalidate();
        },
        handleInput(data: string) {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  } finally {
    removeAbortListener();
  }
}
