import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
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
  renderExpandedAggregateSteer,
  resolveAggregateRenderTheme,
} from "./aggregate-activity.js";
import type { ToolDisplayConfig } from "./types.js";
import { onReloadShutdown } from "./extension-lifecycle.js";

const registeredNativeUserMessageApis = new WeakSet<ExtensionAPI>();

function getUserMessagePrototype(): PatchableUserMessagePrototype {
  return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}

function readUserMessageText(instance: object): string | undefined {
  const text = (instance as { text?: unknown }).text;
  if (typeof text === "string") return text;
  return extractUserMessageMarkdownState(instance)?.text;
}

export function resolveAggregateSteerUserPresentation(
  instance: object,
  width: number,
): UserMessageSteerPresentation | undefined {
  const projection = getActiveAggregateProjection();
  if (!projection) return undefined;
  const text = readUserMessageText(instance);
  const steer = projection.matchSteerForComponent(instance, text);
  if (!steer) return undefined;
  projection.connectFrameRenderer(steer.id, () => {
    try {
      (instance as { invalidate?: () => void }).invalidate?.();
    } catch {
      // A stale transcript component may already be disposed.
    }
  });
  if (!isUserMessageExpanded(instance)) {
    projection.markFrameContentVisible(steer.id, false);
    return { hide: true };
  }
  projection.markFrameContentVisible(steer.id, true);
  return {
    lines: renderExpandedAggregateSteer(
      steer.text,
      width,
      resolveAggregateRenderTheme(projection),
      projection.getFrameEdge(steer.id) ?? "only",
    ),
  };
}

function patchUserMessageRender(
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
  isCompact: () => boolean,
): void {
  patchNativeUserMessagePrototype(
    getUserMessagePrototype(),
    getTheme,
    isEnabled,
    isCompact,
    (instance, width) => isCompact() ? resolveAggregateSteerUserPresentation(instance, width) : undefined,
  );
}

function restoreUserMessageRender(): void {
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
  const isEnabled = (): boolean => isAggregate() || getConfig().enableNativeUserMessageBox;
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
