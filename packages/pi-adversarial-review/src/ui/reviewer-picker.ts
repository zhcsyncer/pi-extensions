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
import {
  resolveRefuterRoute,
  resolveReviewerRoutes,
} from "../command/resolve-routes.ts";
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

export interface RefuterPickerOptions {
  ctx: ExtensionCommandContext;
  previousSpec?: string;
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

export function retainValidRefuterSpec(
  spec: string | undefined,
  scopedModels: readonly ScopedModelEntry[],
): string | undefined {
  return retainValidReviewerSpecs(spec ? [spec] : [], scopedModels)[0];
}

function pickerItems(rows: readonly PickerRow[], mode: "reviewer" | "refuter"): SettingItem[] {
  const refuter = mode === "refuter";
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
      label: refuter ? "▶ Use selected refuter" : "▶ Run selected reviewers",
      currentValue: "confirm",
      values: ["confirm"],
      description: refuter
        ? "Use exactly one independent scoped route for every blocking cluster."
        : "Start with 2–8 distinct scoped models. No reviewer starts before confirmation.",
    },
  ];
}

/**
 * Pick reviewer routes from the current scoped-model snapshot.
 * Returns undefined on Escape or abort and never starts runtime work itself.
 */
async function pickScopedSpecs(
  {
    ctx,
    maxConcurrent,
    previousSpecs,
    signal,
  }: ReviewerPickerOptions,
  mode: "reviewer" | "refuter",
): Promise<string[] | undefined> {
  if (signal?.aborted) return undefined;
  const rows = pickerRows(ctx.scopedModels, previousSpecs);
  if (mode === "refuter") {
    let keptRemembered = false;
    for (const row of rows) {
      if (row.remembered === undefined) continue;
      if (keptRemembered) delete row.remembered;
      else keptRemembered = true;
    }
  }
  if (rows.length === 0) {
    throw new ReviewCommandError(
      "No scoped models are configured. Use /scoped-models before adversarial review.",
    );
  }

  let removeAbortListener = () => {};
  try {
    return await ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
      const items = pickerItems(rows, mode);
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

      let list: SettingsList;
      list = new SettingsList(
        items,
        Math.min(Math.max(rows.length + 1, 4), 14),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === RUN_ITEM_ID) {
            const specs = selectedSpecs(rows, values);
            try {
              if (mode === "reviewer") {
                resolveReviewerRoutes(specs, ctx.scopedModels);
              } else {
                if (specs.length !== 1) {
                  throw new ReviewCommandError(
                    "Adversarial refute requires exactly one refuter model.",
                  );
                }
                resolveRefuterRoute(specs[0], ctx.scopedModels);
              }
              finish(specs);
            } catch (error) {
              validationError = error instanceof Error ? error.message : String(error);
            }
            tui.requestRender();
            return;
          }
          values.set(id, newValue);
          if (mode === "refuter" && newValue !== DISABLED) {
            for (const row of rows) {
              if (row.id === id) continue;
              values.set(row.id, DISABLED);
              list.updateValue(row.id, DISABLED);
            }
          }
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
          const title = theme.fg(
            "accent",
            theme.bold(mode === "reviewer" ? "Adversarial review fleet" : "Adversarial refuter"),
          );
          const validCount = mode === "reviewer" ? count >= 2 && count <= 8 : count === 1;
          const summaryText = mode === "reviewer"
            ? `${count} selected · max concurrent ${concurrency} · ${waves} wave${waves === 1 ? "" : "s"}`
            : `${count} selected · one fresh session per blocking cluster`;
          const summary = theme.fg(validCount ? "muted" : "warning", summaryText);
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

/** Pick 2–8 reviewer routes from the current scoped-model snapshot. */
export function pickReviewerSpecs(options: ReviewerPickerOptions): Promise<string[] | undefined> {
  return pickScopedSpecs(options, "reviewer");
}

/** Pick exactly one independent refuter route from the same scope snapshot. */
export async function pickRefuterSpec({
  ctx,
  previousSpec,
  signal,
}: RefuterPickerOptions): Promise<string | undefined> {
  const specs = await pickScopedSpecs({
    ctx,
    maxConcurrent: 1,
    ...(previousSpec ? { previousSpecs: [previousSpec] } : {}),
    signal,
  }, "refuter");
  return specs?.[0];
}
