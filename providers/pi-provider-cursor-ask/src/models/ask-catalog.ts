/**
 * Stable, advisor-oriented Cursor Ask catalog.
 *
 * Upstream Cursor catalogs expose backend model ids and parameter variants.
 * This adapter runs after upstream processing, keeps four 1M Claude rows
 * plus Composer 2.5 / Composer 2.5 Fast, and retains an explicit route back to
 * Cursor's requestedModelId and parameters for every supported Pi thinking level.
 * Composer has no Cursor effort parameter; its Pi thinking map is an explicit
 * Max Mode switch (off = non-max, max = Max Mode).
 */

import type { CursorEffortMap, CursorModelRouting, ProcessedModel } from "./processing.js";
import type { PiThinkingLevel } from "../types/enums.js";

const SELECTABLE_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type SelectableLevel = (typeof SELECTABLE_LEVELS)[number];

export interface AskModelSpec {
  id: string;
  name: string;
  requestedModelId: string;
  context: "1m";
  contextWindow: number;
  candidates: readonly string[];
  familyCandidates: readonly string[];
}

const families = {
  fable5: {
    requestedModelId: "claude-fable-5",
    defaultContext: "300k" as const,
    candidates: ["claude-fable-5-thinking", "claude-5-fable-thinking"],
    oneMillionCandidates: ["claude-fable-5-1m-thinking", "claude-5-fable-1m-thinking"],
  },
  opus5: {
    requestedModelId: "claude-opus-5",
    defaultContext: "300k" as const,
    candidates: ["claude-opus-5-thinking", "claude-5-opus-thinking"],
    oneMillionCandidates: ["claude-opus-5-1m-thinking", "claude-5-opus-1m-thinking"],
  },
  opus46: {
    requestedModelId: "claude-opus-4-6",
    defaultContext: "200k" as const,
    candidates: [
      "claude-opus-4-6-thinking",
      "claude-4-6-opus-thinking",
      "claude-4.6-opus-thinking",
    ],
    oneMillionCandidates: [
      "claude-opus-4-6-1m-thinking",
      "claude-4-6-opus-1m-thinking",
      "claude-4.6-opus-1m-thinking",
    ],
  },
  sonnet5: {
    requestedModelId: "claude-sonnet-5",
    defaultContext: "300k" as const,
    candidates: ["claude-sonnet-5-thinking", "claude-5-sonnet-thinking"],
    oneMillionCandidates: ["claude-sonnet-5-1m-thinking", "claude-5-sonnet-1m-thinking"],
  },
} as const;

function specForFamily(options: {
  id: string;
  name: string;
  requestedModelId: string;
  defaultContext: "200k" | "300k";
  candidates: readonly string[];
  oneMillionCandidates: readonly string[];
}): AskModelSpec {
  return {
    id: options.id,
    name: options.name,
    requestedModelId: options.requestedModelId,
    context: "1m",
    contextWindow: 1_000_000,
    candidates: options.oneMillionCandidates,
    familyCandidates: [...options.candidates, ...options.oneMillionCandidates],
  };
}

export const ASK_MODEL_SPECS: readonly AskModelSpec[] = [
  specForFamily({ id: "fable-5", name: "Fable 5", ...families.fable5 }),
  specForFamily({ id: "opus-5", name: "Opus 5", ...families.opus5 }),
  specForFamily({ id: "opus-4.6", name: "Opus 4.6", ...families.opus46 }),
  specForFamily({ id: "sonnet-5", name: "Sonnet 5", ...families.sonnet5 }),
];

function normalizedId(id: string): string {
  return id.trim().toLowerCase();
}

function findSourceModel(modelsById: Map<string, ProcessedModel>, spec: AskModelSpec) {
  for (const candidate of spec.candidates) {
    const model = modelsById.get(normalizedId(candidate));
    if (model) return model;
  }
  // Old bundled catalogs may have only one family row (not separate default
  // and 1M rows). Reuse it for capability metadata, then rebuild the context
  // route explicitly below.
  for (const candidate of spec.familyCandidates) {
    const model = modelsById.get(normalizedId(candidate));
    if (model) return model;
  }
  return undefined;
}

function mappedSourceEffort(source: ProcessedModel | undefined, level: SelectableLevel) {
  if (!source?.supportsEffort || !source.effortMap) return level;
  const mapped = source.effortMap[level];
  return typeof mapped === "string" ? mapped : undefined;
}

function sourceRouting(
  source: ProcessedModel | undefined,
  level: SelectableLevel,
  mappedEffort: string,
): CursorModelRouting | undefined {
  const routes = source?.rawRoutingByEffort;
  if (!routes) return undefined;
  return routes[level] ?? routes[mappedEffort] ?? (level === "medium" ? routes[""] : undefined);
}

function sourceEffortParameter(
  route: CursorModelRouting | undefined,
  fallback: SelectableLevel,
): string {
  const parameter = route?.parameters?.find(
    ({ id }) => id.toLowerCase() === "effort" || id.toLowerCase() === "reasoning",
  );
  return parameter?.value || fallback;
}

function routeForLevel(
  spec: AskModelSpec,
  source: ProcessedModel | undefined,
  level: SelectableLevel,
  mappedEffort: string,
): CursorModelRouting {
  const sourceRoute = sourceRouting(source, level, mappedEffort);
  const passthrough =
    sourceRoute?.parameters?.filter(
      ({ id }) =>
        !["thinking", "context", "effort", "reasoning", "fast"].includes(id.toLowerCase()),
    ) ?? [];
  const parameters = [
    ...passthrough,
    { id: "thinking", value: "true" },
    { id: "context", value: spec.context },
    { id: "effort", value: sourceEffortParameter(sourceRoute, level) },
    { id: "fast", value: "false" },
  ];

  return {
    // Parameterized live metadata already carries the authoritative requested
    // model id. Legacy raw fallback rows do not, so use the current canonical
    // id instead of sending an obsolete effort-suffixed picker id.
    modelId: sourceRoute?.parameters?.length ? sourceRoute.modelId : spec.requestedModelId,
    parameters,
    requiresMaxMode: spec.context === "1m",
    requestedMaxMode: spec.context === "1m",
  };
}

function buildEffortRouting(spec: AskModelSpec, source: ProcessedModel | undefined) {
  const effortMap: CursorEffortMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  const routes: Record<string, CursorModelRouting> = {};

  for (const level of SELECTABLE_LEVELS) {
    const mappedEffort = mappedSourceEffort(source, level);
    if (mappedEffort === undefined) continue;
    effortMap[level] = level;
    routes[level] = routeForLevel(spec, source, level, mappedEffort);
  }

  return { effortMap, routes };
}

function representativeRoute(routes: Record<string, CursorModelRouting>): CursorModelRouting {
  const route = routes.medium ?? routes.high ?? routes.low ?? routes.xhigh ?? routes.max;
  if (!route) throw new Error("Cursor Ask model has no thinking route");
  return route;
}

export interface ComposerAskSpec {
  id: string;
  name: string;
  requestedModelId: string;
  fast: boolean;
  candidates: readonly string[];
}

export const COMPOSER_ASK_SPECS: readonly ComposerAskSpec[] = [
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    requestedModelId: "composer-2.5",
    fast: false,
    candidates: ["composer-2.5", "composer-2.5-max-mode"],
  },
  {
    id: "composer-2.5-fast",
    name: "Composer 2.5 Fast",
    requestedModelId: "composer-2.5",
    fast: true,
    candidates: ["composer-2.5-fast", "composer-2.5-max-mode-fast"],
  },
];

const COMPOSER_MAX_MODE_EFFORT_MAP: CursorEffortMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: "max",
};

export function isComposerModel(model: ProcessedModel): boolean {
  return /^composer(?:-|$)/i.test(model.id);
}

function findComposerSource(
  modelsById: Map<string, ProcessedModel>,
  spec: ComposerAskSpec,
): ProcessedModel | undefined {
  for (const candidate of spec.candidates) {
    const model = modelsById.get(normalizedId(candidate));
    if (model) return model;
  }
  return undefined;
}

function composerRoute(spec: ComposerAskSpec, maxMode: boolean): CursorModelRouting {
  return {
    modelId: spec.requestedModelId,
    parameters: [{ id: "fast", value: String(spec.fast) }],
    requiresMaxMode: false,
    requestedMaxMode: maxMode,
  };
}

function buildComposerCatalog(processedModels: ProcessedModel[]): ProcessedModel[] {
  const modelsById = new Map(processedModels.map((model) => [normalizedId(model.id), model]));
  return COMPOSER_ASK_SPECS.map((spec) => {
    const source = findComposerSource(modelsById, spec);
    const routes = {
      none: composerRoute(spec, false),
      max: composerRoute(spec, true),
    };
    const representative = routes.none;
    return {
      ...(source ?? {
        reasoning: true,
        maxTokens: 64_000,
        supportsImages: false,
        contextWindow: 200_000,
      }),
      id: spec.id,
      name: spec.name,
      reasoning: true,
      requestedModelId: representative.modelId,
      parameters: representative.parameters,
      requiresMaxMode: false,
      requestedMaxMode: false,
      supportsEffort: true,
      effortMap: { ...COMPOSER_MAX_MODE_EFFORT_MAP },
      rawModelByEffort: {
        none: representative.modelId,
        max: representative.modelId,
      },
      rawRoutingByEffort: routes,
    } satisfies ProcessedModel;
  });
}

/** Return the four 1M Claude rows followed by Composer 2.5 / Fast. */
export function buildAskCatalog(processedModels: ProcessedModel[]): ProcessedModel[] {
  const modelsById = new Map(processedModels.map((model) => [normalizedId(model.id), model]));
  const claudeModels = ASK_MODEL_SPECS.map((spec) => {
    const source = findSourceModel(modelsById, spec);
    const { effortMap, routes } = buildEffortRouting(spec, source);
    const representative = representativeRoute(routes);

    return {
      ...(source ?? {
        reasoning: true,
        maxTokens: 64_000,
        supportsImages: true,
      }),
      id: spec.id,
      name: spec.name,
      reasoning: true,
      contextWindow: spec.contextWindow,
      requestedModelId: representative.modelId,
      parameters: representative.parameters,
      requiresMaxMode: spec.context === "1m",
      requestedMaxMode: spec.context === "1m",
      supportsEffort: true,
      effortMap,
      rawModelByEffort: Object.fromEntries(
        Object.entries(routes).map(([level, route]) => [level, route.modelId]),
      ),
      rawRoutingByEffort: routes,
    } satisfies ProcessedModel;
  });
  return [...claudeModels, ...buildComposerCatalog(processedModels)];
}

export function supportedAskThinkingLevels(model: ProcessedModel): PiThinkingLevel[] {
  return (Object.entries(model.effortMap ?? {}) as Array<[PiThinkingLevel, string | null]>)
    .filter(([, effort]) => typeof effort === "string")
    .map(([level]) => level);
}
