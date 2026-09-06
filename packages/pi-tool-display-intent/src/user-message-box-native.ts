import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import {
  isUserMessageExpanded,
  patchNativeUserMessagePrototype,
  type PatchableUserMessagePrototype,
  type UserMessageSteerPresentation,
  type UserMessageTheme,
} from "./user-message-box-renderer.js";
import { unregisterUserMessageRenderPrototypePatch } from "./user-message-box-patch.js";
import { extractUserMessageMarkdownState } from "./user-message-box-markdown.js";
import {
  getActiveAggregateProjection,
  renderExpandedAggregateSteerLayout,
  renderExpandedAggregateSummary,
  attachExpandedAggregateSummary,
  resolveAggregateRenderTheme,
} from "./aggregate-activity.js";
import type { ToolDisplayConfig } from "./types.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { patchAggregateMouseHandling, recordAggregateClickRegions, releaseAggregateClickRegions, restoreAggregateMouseHandling, type AggregateClickRegion } from "./aggregate-interaction.js";

const registeredNativeUserMessageApis = new WeakSet<ExtensionAPI>();
const CONTAINER_STEER_SPACER_KEY = Symbol.for(
  "pi-tool-display-intent.steer-user-spacer.v1",
);
const pendingSpacerByContainer = new WeakMap<object, Spacer>();
const spacerBeforeUser = new WeakMap<object, Spacer>();

interface PatchableContainerPrototype {
  addChild(component: unknown): void;
  [CONTAINER_STEER_SPACER_KEY]?: {
    originalAddChild: (component: unknown) => void;
    patchedAddChild: (component: unknown) => void;
  };
}

function getUserMessagePrototype(): PatchableUserMessagePrototype {
  return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}

function readUserMessageText(instance: object): string | undefined {
  const text = (instance as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return extractUserMessageMarkdownState(instance)?.text;
}

function getContainerPrototype(): PatchableContainerPrototype {
  return Container.prototype as unknown as PatchableContainerPrototype;
}

export function patchSteerUserLeadingSpacer(): void {
  const prototype = getContainerPrototype();
  if (prototype[CONTAINER_STEER_SPACER_KEY]) return;
  const originalAddChild = prototype.addChild;
  const patchedAddChild = function addChildTrackingSteerSpacer(
    this: object,
    component: unknown,
  ): void {
    originalAddChild.call(this, component);
    if (component instanceof Spacer) {
      pendingSpacerByContainer.set(this, component);
      return;
    }
    const pending = pendingSpacerByContainer.get(this);
    if (component instanceof UserMessageComponent && pending) {
      spacerBeforeUser.set(component, pending);
      suppressSteerLeadingSpacer(component);
    }
    pendingSpacerByContainer.delete(this);
  };
  prototype.addChild = patchedAddChild;
  prototype[CONTAINER_STEER_SPACER_KEY] = { originalAddChild, patchedAddChild };
}

export function restoreSteerUserLeadingSpacer(): void {
  const prototype = getContainerPrototype();
  const state = prototype[CONTAINER_STEER_SPACER_KEY];
  if (!state) return;
  if (prototype.addChild === state.patchedAddChild) {
    prototype.addChild = state.originalAddChild;
  }
  delete prototype[CONTAINER_STEER_SPACER_KEY];
}

function suppressSteerLeadingSpacer(instance: object): void {
  const spacer = spacerBeforeUser.get(instance);
  if (!spacer) return;
  const projection = getActiveAggregateProjection();
  const text = readUserMessageText(instance);
  if (!projection || text === undefined) return;
  if (!projection.matchSteerForComponent(instance, text)) return;
  spacer.setLines(0);
}

export function resolveAggregateSteerUserPresentation(
  instance: object,
  width: number,
): UserMessageSteerPresentation | undefined {
  releaseAggregateClickRegions(instance);
  const projection = getActiveAggregateProjection();
  if (!projection) return undefined;
  const text = readUserMessageText(instance);
  const steer = projection.matchSteerForComponent(instance, text);
  if (!steer) return undefined;
  suppressSteerLeadingSpacer(instance);
  projection.connectFrameRenderer(steer.id, () => {
    try {
      (instance as { invalidate?: () => void }).invalidate?.();
    } catch {
      // A stale transcript component may already be disposed.
    }
  });
  recordAggregateClickRegions(instance, width, 0);
  if (!projection.isItemExpanded(steer.id, isUserMessageExpanded(instance))) {
    projection.markFrameContentVisible(steer.id, false);
    return { hide: true };
  }
  projection.markFrameContentVisible(steer.id, true);
  const theme = resolveAggregateRenderTheme(projection);
  const layout = renderExpandedAggregateSteerLayout(steer.text, width, theme, projection.getFrameEdge(steer.id) ?? "only");
  let lines = layout.lines;
  let offset = 0;
  const regions: AggregateClickRegion[] = [];
  if (projection.shouldHostExpandedSummary(steer.id)) {
    const view = projection.getViewForGroup(steer.id);
    if (view) {
      const header = renderExpandedAggregateSummary(view, width, theme);
      lines = attachExpandedAggregateSummary(header, lines);
      offset = 1 + header.length;
      regions.push({ startRow: 1, endRow: offset, onClick: () => projection.toggleGroupExpansionFromComponent(steer.id, instance) });
    }
  }
  if (layout.omissionRow !== undefined) {
    regions.push({ startRow: offset + layout.omissionRow, endRow: offset + layout.omissionRow + 1,
      onClick: () => projection.openDetail({ kind: "steer", text: steer.text }) });
  }
  const run = projection.getViewportRun(steer.id);
  recordAggregateClickRegions(instance, width, lines.length, regions, run ? { run, ...(offset > 0 ? { titleRow: 1 } : {}) } : undefined);
  return { lines };
}

function patchUserMessageRender(
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
  isCompact: () => boolean,
): void {
  patchSteerUserLeadingSpacer();
  patchNativeUserMessagePrototype(
    getUserMessagePrototype(),
    getTheme,
    isEnabled,
    isCompact,
    (instance, width) => isCompact() ? resolveAggregateSteerUserPresentation(instance, width) : undefined,
  );
  patchAggregateMouseHandling(getUserMessagePrototype());
}

function restoreUserMessageRender(): void {
  restoreAggregateMouseHandling(getUserMessagePrototype());
  restoreSteerUserLeadingSpacer();
  unregisterUserMessageRenderPrototypePatch(getUserMessagePrototype());
}

export default function registerNativeUserMessageBox(
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
): void {
  if (registeredNativeUserMessageApis.has(pi)) {
    return;
  }
  registeredNativeUserMessageApis.add(pi);

  let activeTheme: UserMessageTheme | undefined;

  const getTheme = (): UserMessageTheme | undefined => activeTheme;
  const isAggregate = (): boolean => getConfig().toolCallLayout === "aggregate";
  const isEnabled = (): boolean => true;
  const isCompact = (): boolean => isAggregate();

  patchUserMessageRender(getTheme, isEnabled, isCompact);

  onReloadShutdown(pi, () => {
    restoreUserMessageRender();
    activeTheme = undefined;
    registeredNativeUserMessageApis.delete(pi);
  });

  pi.on("before_agent_start", async () => {
    patchUserMessageRender(getTheme, isEnabled, isCompact);
  });

  pi.on("session_start", async (_event, ctx) => {
    activeTheme = ctx?.ui?.theme as unknown as UserMessageTheme;
    patchUserMessageRender(getTheme, isEnabled, isCompact);
  });

}
