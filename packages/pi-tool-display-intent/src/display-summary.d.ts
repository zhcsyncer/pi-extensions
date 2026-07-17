export const DISPLAY_SUMMARY_FIELD: "displaySummary";
export const DEFAULT_DISPLAY_SUMMARY_MAX_LENGTH: 96;

export type DisplaySummaryLanguage = "auto" | "zh-CN" | "en";

export interface DisplaySummaryWrapOptions {
  required?: boolean;
  language?: DisplaySummaryLanguage;
  maxLength?: number;
  preserveRendererArgs?: boolean;
  fallback?: string | ((args: unknown, tool: Record<string, unknown>) => string | undefined);
}

export interface DisplaySummaryToolDefinition extends Record<string | symbol, unknown> {
  name?: string;
  label?: string;
  description?: string;
  parameters: unknown;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: any[]) => unknown;
  renderCall?: (...args: any[]) => unknown;
}

export function normalizeDisplaySummary(value: unknown, maxLength?: number): string | undefined;
export function getDisplaySummary(args: unknown, maxLength?: number): string | undefined;
export function stripDisplaySummary<T>(args: T): T;
export function hasDisplaySummaryParameter(parameters: unknown): boolean;
export function addDisplaySummaryParameter(parameters: unknown, options?: DisplaySummaryWrapOptions): unknown;
export type DisplaySummaryWrappedTool<T extends object> = T & {
  prepareArguments: (args: unknown) => unknown;
  renderCall?: (...args: any[]) => unknown;
};

export function withDisplaySummary<T extends object>(
  tool: T,
  options?: DisplaySummaryWrapOptions,
): DisplaySummaryWrappedTool<T>;
