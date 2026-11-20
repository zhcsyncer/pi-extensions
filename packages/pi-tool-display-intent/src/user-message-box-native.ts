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
import { unregisterUserMessageRenderPrototypePatch, type UserMessagePatchOwner } from "./user-message-box-patch.js";
import { extractUserMessageMarkdownState } from "./user-message-box-markdown.js";
import {
  getActiveAggregateProjection,
  renderExpandedAggregateSteerLayout,
  renderExpandedAggregateSummary,
  attachExpandedAggregateSummary,
  resolveAggregateRenderTheme,
} from "./aggregate-activity.js";
import type { ToolDisplayConfig } from "./types.js";
import { stripOscPromptControlSequences } from "./user-message-box-utils.js";
import { patchAggregateMouseHandling, recordAggregateClickRegions, releaseAggregateClickRegions, restoreAggregateMouseHandling, type AggregateClickRegion } from "./aggregate-interaction.js";

const registeredNativeUserMessageApis = new WeakSet<ExtensionAPI>();
const CONTAINER_STEER_SPACER_KEY = Symbol.for(
  "pi-tool-display-intent.steer-user-spacer.v1",
);
const SPACER_OWNER: UserMessagePatchOwner = { retired: false };
const pendingSpacerByContainer = new WeakMap<object, Spacer>();
const spacerBeforeUser = new WeakMap<object, Spacer>();

interface PatchableContainerPrototype {
  addChild(component: unknown): void;
  [CONTAINER_STEER_SPACER_KEY]?: {
    owner: UserMessagePatchOwner;
    active: boolean;
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

export function patchSteerUserLeadingSpacer(owner: UserMessagePatchOwner = SPACER_OWNER): void {
  if (owner.retired) return;
  const prototype = getContainerPrototype();
  const previous = prototype[CONTAINER_STEER_SPACER_KEY];
  if (previous?.owner === owner) return;
  if (previous) restoreSteerUserLeadingSpacer(previous.owner);
  const originalAddChild = prototype.addChild;
  const patchedAddChild = function addChildTrackingSteerSpacer(
    this: object,
    component: unknown,
  ): void {
    originalAddChild.call(this, component);
    if (!state.active) return;
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
  const state = { owner, active: true, originalAddChild, patchedAddChild };
  prototype.addChild = patchedAddChild;
  prototype[CONTAINER_STEER_SPACER_KEY] = state;
}

export function restoreSteerUserLeadingSpacer(owner: UserMessagePatchOwner = SPACER_OWNER): void {
  const prototype = getContainerPrototype();
  const state = prototype[CONTAINER_STEER_SPACER_KEY];
  if (!state || state.owner !== owner) return;
  state.active = false;
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
  const layout = renderExpandedAggregateSteerLayout(stripOscPromptControlSequences(steer.text), width, theme, projection.getFrameEdge(steer.id) ?? "only");
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
  owner: UserMessagePatchOwner,
): void {
  if (owner.retired) return;
  patchSteerUserLeadingSpacer(owner);
  patchNativeUserMessagePrototype(
    getUserMessagePrototype(),
    getTheme,
    isEnabled,
    isCompact,
    (instance, width) => isCompact() ? resolveAggregateSteerUserPresentation(instance, width) : undefined,
    owner,
  );
  patchAggregateMouseHandling(getUserMessagePrototype(), owner);
}

function restoreUserMessageRender(owner: UserMessagePatchOwner): void {
  restoreAggregateMouseHandling(getUserMessagePrototype(), owner);
  restoreSteerUserLeadingSpacer(owner);
  unregisterUserMessageRenderPrototypePatch(getUserMessagePrototype(), owner);
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
  const owner: UserMessagePatchOwner = { retired: false };

  const getTheme = (): UserMessageTheme | undefined => activeTheme;
  const isAggregate = (): boolean => getConfig().toolCallLayout === "aggregate";
  const isEnabled = (): boolean => getConfig().enableNativeUserMessageBox;
  const isCompact = (): boolean => isAggregate();

  patchUserMessageRender(getTheme, isEnabled, isCompact, owner);

  pi.on("session_shutdown", async () => {
    owner.retired = true;
    restoreUserMessageRender(owner);
    activeTheme = undefined;
    registeredNativeUserMessageApis.delete(pi);
  });

  pi.on("before_agent_start", async () => {
    patchUserMessageRender(getTheme, isEnabled, isCompact, owner);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (owner.retired) return;
    activeTheme = ctx?.ui?.theme as unknown as UserMessageTheme;
    patchUserMessageRender(getTheme, isEnabled, isCompact, owner);
  });

}
