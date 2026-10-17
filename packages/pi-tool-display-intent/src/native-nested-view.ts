import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { displayField as field, displayPropertyOmitted, DISPLAY_LIMITS } from "./display-budget.js";
import { NESTED_LIMITS, nativeNestedCall, nestedArgument, nestedArrayLength, type NestedCall } from "./nested-display.js";

type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
export const NATIVE_NESTED_OMISSION = "Nested display incomplete (partial list); visible costs only, not full spend.";
interface NativeView {
  result: Result;
  rows: NestedCall[];
  ids: Set<string>;
  pendingIdentity: boolean;
  count: number;
  bytes: number;
  omitted: boolean;
}

/** Native rendering needs a string placeholder; structured details must not call it a retained value. */
export function nativeDetailView(view: NativeView): Result {
  const details = view.result.details as { calls: Array<Record<string, unknown>> };
  return { ...view.result, details: { ...details, calls: details.calls.map((call, index) => {
    if (view.rows[index].args !== undefined) return call;
    const { args: _args, ...metadata } = call;
    return { ...metadata, argsOmitted: true };
  }) } };
}

/** Detail requests lack ToolInfo; recognize only codemode's known native-progress payload. */
export function hasNativeCodemodeProgress(toolName: string, result: unknown): boolean {
  if (toolName !== "codemode") return false;
  const calls = field(field(result, "details"), "calls");
  const length = nestedArrayLength(calls);
  if (!length) return false;
  for (let i = 0; i < Math.min(length, NESTED_LIMITS.calls); i++) {
    const call = field(calls, String(i));
    if (!nativeNestedCall(call) || typeof field(call, "args") !== "string") return false;
  }
  return true;
}

// Preserve unrelated native fields by reference without invoking accessors or walking their values.
function copyNativeFields(source: unknown, replaced: string): { fields: Record<string, unknown>; omitted: boolean } {
  const fields: Record<string, unknown> = {};
  let omitted = false, count = 0, units = 0;
  if (!source || typeof source !== "object") return { fields, omitted };
  try {
    for (const key in source) {
      if (++count > DISPLAY_LIMITS.nodes || (units += key.length) > DISPLAY_LIMITS.units) { omitted = true; break; }
      if (key === replaced || !Object.hasOwn(source, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor && "value" in descriptor) Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
      else omitted = true;
    }
  } catch { omitted = true; }
  return { fields, omitted };
}

/** Shared display-only snapshot: inline, Metadata and Raw use the same byte/count budget. */
export function nativeView(result: unknown): NativeView {
  const details = field(result, "details");
  const source = field(details, "calls");
  const length = nestedArrayLength(source);
  const limit = Math.min(length, NESTED_LIMITS.calls);
  const calls: Array<Record<string, unknown>> = [];
  const rows: NestedCall[] = [];
  const ids = new Set<string>();
  let bytes = 0, omitted = length > limit || displayPropertyOmitted(result, "details") || displayPropertyOmitted(details, "calls"), pendingIdentity = false;
  for (let i = 0; i < limit; i++) {
    const raw = field(source, String(i));
    const call = nativeNestedCall(raw);
    if (!call) { omitted = true; continue; }
    // Empty native args still encode as two JSON bytes. Reserve that floor for later rows.
    const remaining = NESTED_LIMITS.totalArgumentBytes - bytes - (limit - i - 1) * 2;
    const argument = nestedArgument(field(raw, "args"), remaining, true);
    if (argument.text === undefined) omitted = true;
    bytes += argument.text === undefined ? 2 : argument.bytes;
    if (call.id.endsWith("/?")) pendingIdentity = true;
    else ids.add(call.id);
    rows.push({ ...call, args: argument.text, bytes: argument.text === undefined ? 0 : argument.bytes });
    calls.push({ id: call.id, name: call.name, args: argument.text ?? "", status: call.status,
      ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
      ...(call.error === undefined ? {} : { error: call.error }),
      ...(call.cost === undefined ? {} : { cost: call.cost }),
    });
  }
  const otherDetails = copyNativeFields(details, "calls");
  const otherResult = copyNativeFields(result, "details");
  omitted ||= otherDetails.omitted || otherResult.omitted;
  const view = { ...otherResult.fields, content: field(result, "content") ?? [], details: { ...otherDetails.fields, calls } } as Result;
  return { result: view, rows, ids, pendingIdentity, count: calls.length, bytes, omitted };
}
