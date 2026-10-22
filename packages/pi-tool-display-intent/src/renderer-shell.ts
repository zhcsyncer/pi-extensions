import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, type Component } from "@earendil-works/pi-tui";
import { applyToolResultStyle } from "./tool-call-style.js";
import type { ToolCallStyle } from "./types.js";

/** Derive the context from the public callback; it is not a root SDK type export. */
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Slot = "call" | "result";
interface Layer {
  state: Record<string, unknown>;
  call?: Component;
  result?: Component;
}
interface Row {
  own: Layer;
  delegate: Layer;
  call?: RendererSlot;
  result?: RendererSlot;
}

class RendererSlot extends Box {
  constructor(readonly row: Row, readonly owner: object) { super(0, 0); }
  update(child: Component, padding: number): void {
    this.setPaddingX(padding);
    this.clear();
    this.addChild(child);
  }
}

interface RendererOptions {
  style: ToolCallStyle;
  native?: ToolRenderers;
  connectRows?: boolean;
  run?: <T>(fn: () => T) => T;
  prepareCall?: (theme: Parameters<NonNullable<ToolRenderers["renderCall"]>>[1], context: RenderContext) => Component | undefined;
  prepareResult?: (
    result: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0],
    options: Parameters<NonNullable<ToolRenderers["renderResult"]>>[1],
    theme: Parameters<NonNullable<ToolRenderers["renderResult"]>>[2],
    context: RenderContext,
    delegated: boolean,
  ) => { result: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0]; after?: Component };
}

/** One registration owner keeps row state across independent call/result resolutions (HTML). */
export function createToolRendererComposer() {
  const rows = new WeakMap<object, Row>();
  return (own: ToolRenderers, delegate: ToolRenderers | undefined, options: RendererOptions): ToolRenderers =>
    composeToolRenderers(rows, own, delegate, options);
}

/** A row owns the framing; each renderer owns its own state and both previous-component slots. */
function composeToolRenderers(
  rows: WeakMap<object, Row>,
  own: ToolRenderers,
  delegate: ToolRenderers | undefined,
  options: RendererOptions,
): ToolRenderers {
  // Cooperative callers may install these callbacks back onto their definition.
  // Capture the inputs so that installation cannot turn delegation into recursion.
  own = { ...own };
  delegate = delegate ? { ...delegate } : undefined;
  const run = options.run ?? (<T>(fn: () => T): T => fn());
  const useCallDelegate = !!delegate?.renderCall && (!own.renderCall || delegate.renderCall !== options.native?.renderCall);
  const useResultDelegate = !!delegate?.renderResult && (!own.renderResult || delegate.renderResult !== options.native?.renderResult);
  const shell = options.style === "claude" || delegate?.renderShell === "self" ? "self" : "default";

  function prepare(context: RenderContext | undefined, slot: Slot, delegated: boolean) {
    const carrier = context?.state && typeof context.state === "object" ? context.state : undefined;
    let row = carrier ? rows.get(carrier) : undefined;
    if (!row && context?.lastComponent instanceof RendererSlot && context.lastComponent.owner === rows) {
      row = context.lastComponent.row;
    }
    row ??= { own: { state: {} }, delegate: { state: {} } };
    if (carrier) rows.set(carrier, row);
    const layer = delegated ? row.delegate : row.own;
    return {
      row, layer,
      context: { ...context, state: layer.state, lastComponent: layer[slot] } as RenderContext,
    };
  }

  function frame(row: Row, layer: Layer, slot: Slot, child: Component, context: RenderContext, delegated: boolean, theme: Parameters<NonNullable<ToolRenderers["renderCall"]>>[1], after?: Component) {
    layer[slot] = child;
    // A delegated self shell already owns outputPad. Default renderers leave it to their host.
    const selfPadded = delegated && delegate?.renderShell === "self";
    // Specialized content (including its markers and mouse handlers) belongs to
    // its renderer. Only our generic bodies receive the result-prefix component.
    const styled = slot === "result" && !delegated
      ? applyToolResultStyle(child, options.style, { connectRows: options.connectRows, theme }) as Component
      : child;
    const component = row[slot] ??= new RendererSlot(row, rows);
    let body = styled;
    if (after) {
      const group = new Container();
      group.addChild(styled);
      group.addChild(after);
      body = group;
    }
    component.update(body, shell === "self" && !selfPadded ? context?.outputPad ?? 0 : 0);
    return component;
  }

  return {
    renderShell: shell,
    renderCall: own.renderCall || delegate?.renderCall ? (args, theme, context) => run(() => {
      const renderer = useCallDelegate ? delegate! : own;
      const { row, layer, context: inner } = prepare(context, "call", useCallDelegate);
      const child = renderer.renderCall!(args, theme, inner);
      const pending = options.prepareCall?.(theme, context);
      // A root that never publishes partial results still needs its live descendants.
      // Once a result slot exists it owns the supplement, including the first result frame.
      const after = pending ? { render: (width: number) => row.result ? [] : pending.render(width), invalidate: () => pending.invalidate() } : undefined;
      return frame(row, layer, "call", child, context, useCallDelegate, theme, after);
    }) : undefined,
    renderResult: own.renderResult || delegate?.renderResult ? (result, renderOptions, theme, context) => run(() => {
      const renderer = useResultDelegate ? delegate! : own;
      const { row, layer, context: inner } = prepare(context, "result", useResultDelegate);
      const view = options.prepareResult?.(result, renderOptions, theme, context, useResultDelegate);
      const child = renderer.renderResult!(view?.result ?? result, renderOptions, theme, inner);
      return frame(row, layer, "result", child, context, useResultDelegate, theme, view?.after);
    }) : undefined,
  };
}
