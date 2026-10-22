import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundDisplayText, displayField as field, extractDisplayText, snapshotDisplayValue } from "./display-budget.js";

/** These are compact-JSON UTF-8 bytes, not D2's UTF-16 display units. */
export const NESTED_LIMITS = { calls: 256, argumentBytes: 8192, totalArgumentBytes: 32768 } as const;
export type NestedStatus = "running" | "ok" | "error" | "cancelled" | "unfinished";
export interface NestedCall {
  id: string;
  name: string;
  kind: "tool" | "model" | "preview";
  parentId?: string;
  status: NestedStatus;
  args?: string;
  argumentBytes?: number;
  bytes: number;
  preview?: boolean;
  durationMs?: number;
  error?: string;
  cost?: number;
}
export interface NestedRoot {
  id: string;
  calls: Map<string, NestedCall>;
  anonymous: NestedCall[];
  bytes: number;
  complete: boolean;
  hasRecord: boolean;
  history: boolean;
  final: boolean;
  nativeSeen: boolean;
  revision: number;
}
interface ExecutionEvent {
  toolCallId: string;
  toolName?: string;
  parentToolCallId?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export function nestedString(value: unknown, max = 240, lines = 1): string | undefined {
  return typeof value === "string" ? boundDisplayText(value, max, lines).text : undefined;
}
function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : undefined;
}
export function nestedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function nestedArrayLength(value: unknown): number {
  try {
    const length = field(value, "length");
    return Array.isArray(value) && typeof length === "number" ? length : 0;
  } catch { return 0; }
}
export function nativeModelCall(rootId: string, call: Pick<NestedCall, "id" | "name">): boolean {
  return ["models.classify", "models.generateImages"].includes(call.name) &&
    call.id.startsWith(`${rootId}/${call.name}/`);
}

/** Snapshot first. JSON/UTF-8 encoding only sees a small, data-property-only value. */
export function nestedArgument(value: unknown, remaining: number, preview = false): { text?: string; bytes: number } {
  const limit = Math.min(NESTED_LIMITS.argumentBytes, remaining);
  if (value === undefined || limit <= 0) return { bytes: 0 };
  if (preview) {
    if (typeof value !== "string" || value.length > limit) return { bytes: 0 };
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return bytes <= limit ? { text: value, bytes } : { bytes: 0 };
  }
  const snapshot = snapshotDisplayValue(value, { units: limit, nodes: 1024 });
  if (snapshot.truncated) return { bytes: 0 };
  const text = JSON.stringify(snapshot.value);
  if (text === undefined) return { bytes: 0 };
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes <= limit ? { text, bytes } : { bytes: 0 };
}

export function nativeNestedCall(value: unknown): Omit<NestedCall, "bytes"> | undefined {
  const id = identity(field(value, "id"));
  const name = nestedString(field(value, "name"));
  const status = field(value, "status");
  if (!id || !name || !["running", "ok", "error", "cancelled"].includes(status as string)) return undefined;
  return {
    id, name, status: status as NestedStatus, kind: "preview", preview: true,
    durationMs: nestedNumber(field(value, "durationMs")),
    error: nestedString(field(value, "error"), 500, 500), cost: nestedNumber(field(value, "cost")),
  };
}

/** One extension owner, no timers or global call registry. Facts never become transcript messages. */
export class NestedDisplayStore {
  private readonly roots = new Map<string, NestedRoot>();
  private readonly owners = new Map<string, string>();
  private readonly invalidators = new Map<string, Set<WeakRef<{ invalidate: () => void }>>>();
  private views = new WeakMap<object, { id: string; invalidate: () => void }>();
  private readonly fallbackInvalidators = new Map<string, () => void>();
  private historySource?: { getBranch(): unknown[] };
  private registered = false;
  private disposed = false;

  private ensure(id: string): NestedRoot {
    let root = this.roots.get(id);
    if (!root) {
      root = { id, calls: new Map(), anonymous: [], bytes: 0, complete: true, hasRecord: false, history: false, final: false, nativeSeen: false, revision: 0 };
      this.roots.set(id, root);
    }
    return root;
  }
  get(id: string, includeArchivedHistory = false): NestedRoot | undefined {
    if (this.disposed) return undefined;
    // HTML may include pre-compaction entries that the visible aggregate projection omitted.
    if (includeArchivedHistory && !this.roots.has(id) && this.historySource) {
      for (const entry of this.historySource.getBranch()) {
        const message = field(entry, "message");
        if (field(message, "role") === "toolResult" && field(message, "toolCallId") === id) this.ingest(message, false);
      }
    }
    return this.roots.get(id);
  }
  bind(id: string, invalidate: () => void, state?: object): void {
    if (this.disposed || !id) return;
    if (!state || typeof state !== "object") { this.fallbackInvalidators.set(id, invalidate); return; }
    // Public renderer state identifies a view. HTML must neither replace a live
    // invalidator nor keep discarded components alive across exports/tree changes.
    let view = this.views.get(state);
    if (view?.id === id) { view.invalidate = invalidate; return; }
    view = { id, invalidate };
    this.views.set(state, view);
    const references = this.invalidators.get(id) ?? new Set();
    for (const reference of references) if (!reference.deref()) references.delete(reference);
    references.add(new WeakRef(view));
    this.invalidators.set(id, references);
  }
  private changed(root: NestedRoot, notify = true): void {
    root.revision++;
    if (!notify || !(root.hasRecord || root.nativeSeen || root.calls.size)) return;
    const references = this.invalidators.get(root.id);
    let notified = false;
    for (const reference of [...references ?? []]) {
      const view = reference.deref();
      if (!view) { references?.delete(reference); continue; }
      try { view.invalidate(); notified = true; } catch { references?.delete(reference); }
    }
    if (!notified) this.fallbackInvalidators.get(root.id)?.();
  }
  private owner(parent: string): NestedRoot | undefined {
    return this.roots.get(this.owners.get(parent) ?? parent);
  }
  private put(root: NestedRoot, call: NestedCall, args: unknown, preview = false): void {
    const previous = root.calls.get(call.id);
    if (!previous && root.calls.size + root.anonymous.length >= NESTED_LIMITS.calls) { root.complete = false; return; }
    root.bytes -= previous?.bytes ?? 0;
    const argument = nestedArgument(args, NESTED_LIMITS.totalArgumentBytes - root.bytes, preview);
    call.args = argument.text;
    call.bytes = argument.bytes;
    call.preview = preview;
    if (argument.text === undefined) root.complete = false;
    root.bytes += call.bytes;
    root.calls.set(call.id, call);
    if (call.kind === "tool") this.owners.set(call.id, root.id);
  }
  start(event: ExecutionEvent): void {
    if (this.disposed) return;
    if (!event.parentToolCallId) { this.ensure(event.toolCallId); return; }
    const root = this.owner(event.parentToolCallId);
    if (!root || event.toolCallId === root.id) return; // Never promote an orphan to a top-level tool.
    if (root.final) root.complete = false;
    root.hasRecord = true;
    const existing = root.calls.get(event.toolCallId);
    if (!existing || existing.kind !== "tool") {
      this.put(root, { id: event.toolCallId, name: nestedString(event.toolName) ?? "tool", kind: "tool", parentId: event.parentToolCallId, status: "running", bytes: 0 }, event.args);
    } else existing.parentId = event.parentToolCallId;
    this.changed(root);
  }
  update(event: ExecutionEvent): void {
    if (this.disposed) return;
    if (event.parentToolCallId) {
      const root = this.owner(event.parentToolCallId);
      const call = root?.calls.get(event.toolCallId);
      if (root && call && event.args !== undefined) {
        this.put(root, { ...call }, event.args);
        this.changed(root);
      }
    } else {
      const root = this.ensure(event.toolCallId);
      if (event.toolName === "codemode") this.native(root, field(event.partialResult, "details"));
      this.changed(root);
    }
  }
  end(event: ExecutionEvent): void {
    if (this.disposed) return;
    if (event.parentToolCallId) {
      const root = this.owner(event.parentToolCallId);
      if (!root) return;
      if (!root.calls.has(event.toolCallId)) this.start(event);
      const call = root.calls.get(event.toolCallId);
      if (call) {
        call.status = event.isError ? (call.status === "cancelled" ? "cancelled" : "error") : "ok";
        call.durationMs = nestedNumber(event.durationMs) ?? call.durationMs;
        call.error = event.isError ? nestedString(extractDisplayText(event.result), 500) : undefined;
      }
      this.changed(root);
    } else {
      const root = this.ensure(event.toolCallId);
      root.final = true;
      if (event.toolName === "codemode") this.native(root, field(event.result, "details"));
      this.changed(root);
    }
  }
  private native(root: NestedRoot, details: unknown): void {
    const calls = field(details, "calls");
    const length = nestedArrayLength(calls);
    root.nativeSeen ||= length > 0;
    if (length > NESTED_LIMITS.calls) root.complete = false;
    for (const call of root.anonymous) root.bytes -= call.bytes;
    root.anonymous = [];
    for (let i = 0; i < Math.min(length, NESTED_LIMITS.calls); i++) {
      const raw = field(calls, String(i));
      const native = nativeNestedCall(raw);
      if (!native) { root.complete = false; continue; }
      const existing = root.calls.get(native.id);
      if (existing) {
        // Native codemode can distinguish cancellation; generic errors cannot.
        if (existing.kind !== "tool") {
          this.put(root, { ...existing, ...native, kind: existing.kind, parentId: existing.parentId, bytes: 0 }, field(raw, "args"), true);
        } else {
          if (native.status === "cancelled") existing.status = "cancelled";
          existing.durationMs ??= native.durationMs;
          existing.error ??= native.error;
        }
        continue;
      }
      const model = nativeModelCall(root.id, native);
      if (!model && (!root.history || root.hasRecord)) continue;
      if (native.id.endsWith("/?")) {
        root.complete = false;
        if (root.calls.size + root.anonymous.length >= NESTED_LIMITS.calls) continue;
        const argument = nestedArgument(field(raw, "args"), NESTED_LIMITS.totalArgumentBytes - root.bytes, true);
        root.anonymous.push({ ...native, args: argument.text, bytes: argument.bytes });
        root.bytes += argument.bytes;
      } else {
        this.put(root, { ...native, kind: model ? "model" : "preview", parentId: root.id, bytes: 0 }, field(raw, "args"), true);
      }
    }
  }
  ingest(message: unknown, notify = true): void {
    if (this.disposed || field(message, "role") !== "toolResult") return;
    const id = identity(field(message, "toolCallId"));
    if (!id) return;
    const record = field(message, "nestedCalls");
    const root = this.ensure(id);
    root.final = root.history = true;
    if (record !== undefined) {
      for (const call of root.calls.values()) this.owners.delete(call.id);
      root.calls.clear(); root.anonymous = []; root.bytes = 0;
      root.hasRecord = true;
      root.complete = field(record, "complete") === true;
      const calls = field(record, "calls");
      const length = nestedArrayLength(calls);
      if (length > NESTED_LIMITS.calls) root.complete = false;
      for (let i = 0; i < Math.min(length, NESTED_LIMITS.calls); i++) {
        const raw = field(calls, String(i));
        const child = identity(field(raw, "id"));
        const name = nestedString(field(raw, "name"));
        const status = field(raw, "status");
        if (!child || child === id || !name || root.calls.has(child) || !["ok", "error", "unfinished"].includes(status as string)) { root.complete = false; continue; }
        this.put(root, { id: child, name, kind: "tool", status: status as NestedStatus, bytes: 0,
          durationMs: nestedNumber(field(raw, "durationMs")), error: nestedString(field(raw, "error"), 500, 500),
          argumentBytes: nestedNumber(field(raw, "argumentsBytes")),
        }, field(raw, "arguments"));
      }
      for (const call of root.calls.values()) {
        if (!call.id.startsWith(`${id}/`)) continue;
        const suffix = call.id.slice(id.length + 1);
        if (!suffix.split("/").every(part => /^[1-9]\d*$/.test(part))) continue;
        const parent = call.id.slice(0, call.id.lastIndexOf("/"));
        if (parent === id || root.calls.has(parent)) call.parentId = parent;
      }
    }
    if (field(message, "toolName") === "codemode") this.native(root, field(message, "details"));
    for (const call of root.calls.values()) {
      if (call.status === "running") call.status = "unfinished";
      if (call.status === "unfinished") root.complete = false;
    }
    this.changed(root, notify);
  }
  rebuild(entries: unknown[]): void {
    if (this.disposed) return;
    this.roots.clear(); this.owners.clear(); this.fallbackInvalidators.clear();
    for (const entry of entries) this.ingest(field(entry, "message"), false);
  }
  dispose(): void {
    this.disposed = true;
    this.roots.clear(); this.owners.clear(); this.invalidators.clear(); this.fallbackInvalidators.clear();
    this.views = new WeakMap(); this.historySource = undefined;
  }
  register(pi: ExtensionAPI): void {
    if (this.registered) return;
    this.registered = true;
    const rebuild = (ctx: { sessionManager: { getBranch(): unknown[] } }, resetBindings: boolean) => {
      if (!ctx?.sessionManager) return;
      this.historySource = ctx.sessionManager;
      if (resetBindings) { this.invalidators.clear(); this.views = new WeakMap(); }
      this.rebuild(ctx.sessionManager.getBranch());
    };
    pi.on("session_start", (_e, ctx) => rebuild(ctx, true));
    pi.on("session_tree", (_e, ctx) => rebuild(ctx, true));
    pi.on("session_compact", (_e, ctx) => rebuild(ctx, true));
    pi.on("before_agent_start", (_e, ctx) => rebuild(ctx, false));
    pi.on("tool_execution_start", e => { this.start(e); });
    pi.on("tool_execution_update", e => { this.update(e); });
    pi.on("tool_execution_end", e => { this.end(e); });
    pi.on("message_start", e => { this.ingest(e.message); });
    pi.on("message_end", e => { this.ingest(e.message); });
    pi.on("session_shutdown", () => this.dispose());
  }
}
