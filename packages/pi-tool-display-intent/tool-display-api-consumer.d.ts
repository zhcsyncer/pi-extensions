export {
  addDisplaySummaryParameter,
  getDisplaySummary,
  normalizeDisplaySummary,
  stripDisplaySummary,
  withDisplaySummary,
} from "./src/display-summary.js";
export type {
  DisplaySummaryLanguage,
  DisplaySummaryToolDefinition,
  DisplaySummaryWrappedTool,
  DisplaySummaryWrapOptions,
} from "./src/display-summary.js";

export type RuntimeToolDefinition = Record<string, unknown>;
export type ToolDisplayOutputMode = "inherit" | "hidden" | "summary" | "preview";
export type ToolDisplayDecorated<T extends object> = T & {
  renderCall?: (...args: any[]) => unknown;
  renderResult?: (...args: any[]) => unknown;
  renderShell?: "default" | "self";
};

export interface ToolDisplayCallPresentation {
  /** Primary target rendered in accent color, such as a query or shortened URL. */
  target: string;
  /** Secondary single-line facts rendered after the target. */
  metadata?: string[];
}

export interface ToolDisplayResultPresentation {
  /** Semantic result status, such as backend and result count. */
  summary: string;
  /** Number of leading raw output lines duplicated by the semantic status. */
  previewStartLine?: number;
}

export interface ToolDisplayAdapter {
  kind?: "read" | "edit" | "mcp" | "generic";
  overrideExistingRenderers?: boolean;
  /** Add shared result rendering. "inherit" follows the active global results.mode. */
  outputMode?: ToolDisplayOutputMode;
  /** Replace the generic `(N args)` target while preserving shared style and intent rendering. */
  getCallPresentation?: (args: unknown) => ToolDisplayCallPresentation | undefined;
  /** Add a semantic status line and optionally skip duplicated raw preview header lines. */
  getResultPresentation?: (result: unknown) => ToolDisplayResultPresentation | undefined;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(
    tool: T,
    adapter?: ToolDisplayAdapter | Record<string, unknown>,
  ): ToolDisplayDecorated<T>;
}

export interface DecorateToolForDisplayOptions {
  suppressDecorateErrors?: boolean;
}

export declare function getToolDisplayApi(): ToolDisplayApi | undefined;

export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
): void;

export declare function decorateToolForDisplay<T extends object>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
  options?: DecorateToolForDisplayOptions,
): ToolDisplayDecorated<T>;

export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(
  tool: T,
): ToolDisplayDecorated<T>;
