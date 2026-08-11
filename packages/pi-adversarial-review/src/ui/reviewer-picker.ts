import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
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
const REFUTE_ITEM_ID = "__adversarial_review_refute__";
const DISABLED = "disabled";
const REFUTE_MAIN_SESSION = "main session";
const REFUTE_CHOOSE_MODEL = "choose model";
const REFUTE_EXPLICIT_ROUTE = "explicit route";

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

export type InteractiveRefuteChoice =
  | "main-session"
  | "choose-model"
  | "explicit"
  | "disabled";

export interface InteractiveReviewSetup {
  reviewerSpecs: string[];
  refute: InteractiveRefuteChoice;
}

export interface InteractiveReviewSetupOptions extends ReviewerPickerOptions {
  mainSessionRefuterKey?: string;
  explicitRefuterKey?: string;
  refuteRequired?: boolean;
}

interface RefuteControl {
  mainSessionRefuterKey?: string;
  explicitRefuterKey?: string;
  required: boolean;
}

interface PickerSelection {
  specs: string[];
  refute: InteractiveRefuteChoice;
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
    const preferred = clampThinkingLevel(entry.model, "medium");
    const values = entry.thinkingLevel === undefined
      ? supported.includes(preferred)
        ? [preferred, ...supported.filter((level) => level !== preferred)]
        : supported
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

function pickerItems(
  rows: readonly PickerRow[],
  mode: "reviewer" | "refuter",
  refuteControl?: RefuteControl,
): SettingItem[] {
  const refuter = mode === "refuter";
  const refuteItem: SettingItem[] = mode === "reviewer" && refuteControl
    ? [{
        id: REFUTE_ITEM_ID,
        label: "Refute blocking findings",
        currentValue: refuteControl.explicitRefuterKey
          ? REFUTE_EXPLICIT_ROUTE
          : refuteControl.mainSessionRefuterKey
            ? REFUTE_MAIN_SESSION
            : REFUTE_CHOOSE_MODEL,
        values: refuteControl.explicitRefuterKey
          ? [REFUTE_EXPLICIT_ROUTE]
          : [
              ...(refuteControl.mainSessionRefuterKey ? [REFUTE_MAIN_SESSION] : []),
              REFUTE_CHOOSE_MODEL,
              ...(refuteControl.required ? [] : [DISABLED]),
            ],
        description: refuteControl.explicitRefuterKey
          ? `Enabled with explicit route ${refuteControl.explicitRefuterKey}.`
          : refuteControl.mainSessionRefuterKey
            ? `Default: fresh ${refuteControl.mainSessionRefuterKey} session; choose another scoped model or disable.`
            : "Choose one scoped refuter model; the current main session has no model.",
      }]
    : [];
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
            : `${row.entry.model.name ?? row.modelRef}. ` +
              "Defaults to disabled; first enable uses medium or the nearest supported level.",
      };
    }),
    ...refuteItem,
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

function selectedRefuteChoice(
  control: RefuteControl | undefined,
  value: string,
): InteractiveRefuteChoice {
  if (!control) return "disabled";
  if (control.explicitRefuterKey) return "explicit";
  if (value === REFUTE_MAIN_SESSION) return "main-session";
  if (value === REFUTE_CHOOSE_MODEL) return "choose-model";
  return "disabled";
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
  refuteControl?: RefuteControl,
): Promise<PickerSelection | undefined> {
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
    return await ctx.ui.custom<PickerSelection | undefined>((tui, theme, _keybindings, done) => {
      const items = pickerItems(rows, mode, refuteControl);
      const values = new Map(items.slice(0, rows.length).map((item) => [item.id, item.currentValue]));
      let refuteValue = refuteControl
        ? items.find((item) => item.id === REFUTE_ITEM_ID)?.currentValue ?? DISABLED
        : DISABLED;
      let validationError: string | undefined;
      let settled = false;

      const finish = (result: PickerSelection | undefined) => {
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
        Math.min(Math.max(rows.length + 1 + (refuteControl ? 1 : 0), 4), 14),
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
              finish({
                specs,
                refute: selectedRefuteChoice(refuteControl, refuteValue),
              });
            } catch (error) {
              validationError = error instanceof Error ? error.message : String(error);
            }
            tui.requestRender();
            return;
          }
          if (id === REFUTE_ITEM_ID) {
            refuteValue = newValue;
            validationError = undefined;
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
          const refuteChoice = selectedRefuteChoice(refuteControl, refuteValue);
          const summaryText = mode === "reviewer"
            ? `${count} selected · max concurrent ${concurrency} · ${waves} wave${waves === 1 ? "" : "s"}` +
              `${refuteControl ? ` · Refute ${refuteChoice === "disabled" ? "off" : "on"}` : ""}`
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
export async function pickReviewerSpecs(
  options: ReviewerPickerOptions,
): Promise<string[] | undefined> {
  return (await pickScopedSpecs(options, "reviewer"))?.specs;
}

/** Pick reviewers plus the default-on TUI Refute policy in one setup surface. */
export async function pickInteractiveReviewSetup({
  mainSessionRefuterKey,
  explicitRefuterKey,
  refuteRequired = false,
  ...options
}: InteractiveReviewSetupOptions): Promise<InteractiveReviewSetup | undefined> {
  const selected = await pickScopedSpecs(options, "reviewer", {
    ...(mainSessionRefuterKey ? { mainSessionRefuterKey } : {}),
    ...(explicitRefuterKey ? { explicitRefuterKey } : {}),
    required: refuteRequired,
  });
  return selected
    ? { reviewerSpecs: selected.specs, refute: selected.refute }
    : undefined;
}

/** Pick exactly one independent refuter route from the same scope snapshot. */
export async function pickRefuterSpec({
  ctx,
  previousSpec,
  signal,
}: RefuterPickerOptions): Promise<string | undefined> {
  const selected = await pickScopedSpecs({
    ctx,
    maxConcurrent: 1,
    ...(previousSpec ? { previousSpecs: [previousSpec] } : {}),
    signal,
  }, "refuter");
  return selected?.specs[0];
}
