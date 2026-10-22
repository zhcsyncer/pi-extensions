import type { ToolExecutionStartEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type PendingCall = { promise: Promise<void>; resolve(): void };
type RootCalls = {
  members: Set<string>;
  active: Set<string>;
  agents: Map<string, PendingCall>;
};

/** Activation-local fence for nested Agent calls, not for the children they launch. */
export class NestedAgentSettlement {
  private roots = new Map<string, RootCalls>();
  private owners = new Map<string, string>();

  constructor(private readonly agentToolName: string) {}

  start(event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "parentToolCallId">): void {
    const { toolCallId, parentToolCallId } = event;
    if (this.owners.has(toolCallId)) return;
    const rootId = parentToolCallId ? this.owners.get(parentToolCallId) ?? parentToolCallId : toolCallId;
    let root = this.roots.get(rootId);
    if (!root) {
      root = { members: new Set(), active: new Set(), agents: new Map() };
      this.roots.set(rootId, root);
    }
    this.owners.set(toolCallId, rootId);
    root.members.add(toolCallId);
    root.active.add(toolCallId);
    // Direct Agent must never wait on itself. A background launch leaves this
    // set when its tool call returns an ID; its continuing child is not tracked.
    if (parentToolCallId && event.toolName === this.agentToolName) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      root.agents.set(toolCallId, { promise, resolve });
    }
  }

  end(toolCallId: string): void {
    const rootId = this.owners.get(toolCallId);
    if (rootId === undefined) return;
    const root = this.roots.get(rootId)!;
    root.active.delete(toolCallId);
    const pending = root.agents.get(toolCallId);
    root.agents.delete(toolCallId);
    pending?.resolve();
    // Keep intermediate parent identities until every actual call has ended.
    // Lifecycle notifications must not clear or resolve still-active calls.
    if (root.active.size === 0) {
      for (const id of root.members) this.owners.delete(id);
      this.roots.delete(rootId);
    }
  }

  async waitForRoot(event: Pick<ToolResultEvent, "toolCallId" | "parentToolCallId">): Promise<void> {
    if (event.parentToolCallId) return;
    const root = this.roots.get(event.toolCallId);
    // New nested calls can arrive while an earlier one is settling.
    while (root?.agents.size) await Promise.all([...root.agents.values()].map(call => call.promise));
  }
}
