export type UserMessageRenderFn = (width: number) => string[];
type SetExpandedFn = (expanded: boolean) => void;
export interface UserMessagePatchOwner { retired: boolean }
const USER_MESSAGE_PATCH_OWNER: UserMessagePatchOwner = { retired: false };
const PATCH = Symbol.for("pi-tool-display-intent.user-message-patch.v1");

interface UserMessagePatch {
  owner: UserMessagePatchOwner;
  version: number;
  active: boolean;
  originalRender: UserMessageRenderFn;
  render: UserMessageRenderFn;
  originalSetExpanded?: SetExpandedFn;
  setExpanded?: SetExpandedFn;
}

export interface PatchableUserMessagePrototype {
  render: UserMessageRenderFn;
  setExpanded?: SetExpandedFn;
  invalidate?: () => void;
  [PATCH]?: UserMessagePatch;
}

export function unregisterUserMessageRenderPrototypePatch(
  prototype: PatchableUserMessagePrototype,
  owner: UserMessagePatchOwner = USER_MESSAGE_PATCH_OWNER,
): void {
  const state = prototype[PATCH];
  if (!state || state.owner !== owner) return;
  // A later renderer may have captured our wrapper. Leave its chain intact,
  // but make our retired layer a transparent delegate.
  state.active = false;
  if (prototype.render === state.render) prototype.render = state.originalRender;
  if (state.setExpanded && prototype.setExpanded === state.setExpanded) {
    if (state.originalSetExpanded) prototype.setExpanded = state.originalSetExpanded;
    else delete prototype.setExpanded;
  }
  delete prototype[PATCH];
}

export function patchUserMessageRenderPrototype(
  prototype: PatchableUserMessagePrototype,
  patchVersion: number,
  buildRender: (originalRender: UserMessageRenderFn) => UserMessageRenderFn,
  owner: UserMessagePatchOwner = USER_MESSAGE_PATCH_OWNER,
  buildSetExpanded?: (original?: SetExpandedFn) => SetExpandedFn,
): void {
  if (owner.retired || typeof prototype.render !== "function") return;
  const previous = prototype[PATCH];
  if (previous?.owner === owner && previous.version === patchVersion && previous.active) return;
  if (previous) {
    if (previous.owner !== owner) previous.owner.retired = true;
    unregisterUserMessageRenderPrototypePatch(prototype, previous.owner);
  }
  const originalRender = prototype.render;
  const render = buildRender(originalRender);
  const originalSetExpanded = prototype.setExpanded;
  const setExpanded = buildSetExpanded?.(originalSetExpanded);
  const state: UserMessagePatch = {
    owner, version: patchVersion, active: true, originalRender, originalSetExpanded,
    render(width) {
      return (state.active ? render : originalRender).call(this, width);
    },
    ...(setExpanded ? {
      setExpanded(this: object, expanded: boolean) {
        (state.active ? setExpanded : originalSetExpanded)?.call(this, expanded);
      },
    } : {}),
  };
  prototype[PATCH] = state;
  prototype.render = state.render;
  if (state.setExpanded) prototype.setExpanded = state.setExpanded;
}
