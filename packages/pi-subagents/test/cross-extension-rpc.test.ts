import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, PROTOCOL_VERSION, type RpcDeps, registerRpcHandlers, type SpawnCapable } from "../src/cross-extension-rpc.js";

/** Simple in-process event bus for testing. */
function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("cross-extension RPC", () => {
  let events: EventBus;
  let manager: SpawnCapable;
  let ctx: object | undefined;
  let deps: RpcDeps;

  beforeEach(() => {
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      abort: vi.fn().mockReturnValue(true),
      getMaxConcurrent: vi.fn().mockReturnValue(4),
    };
    ctx = { session: true };
    deps = { events, pi: { events }, getCtx: () => ctx, manager };
  });

  // --- ping ---

  describe("ping RPC", () => {
    it("replies with protocol version", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: true,
        data: { version: PROTOCOL_VERSION, maxConcurrent: 4 },
      });
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-other", wrongReply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to pings", async () => {
      const { unsubPing } = registerRpcHandlers(deps);
      unsubPing();

      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- spawn ---

  describe("spawn RPC", () => {
    it("returns agent id on success", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s1", type: "general-purpose", prompt: "do stuff",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "do stuff", {},
      );
    });

    it("passes options through without adding a completion-delivery override", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s2", type: "Explore", prompt: "find it",
        options: { description: "search", isBackground: true },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "Explore", "find it",
        { description: "search", isBackground: true },
      );
      expect((manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][4]).not.toHaveProperty("completionDelivery");
    });

    it("drops completionDelivery from untyped callers so RPC stays followUp", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-delivery", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-delivery",
        type: "Explore",
        prompt: "find it",
        options: { description: "search", isBackground: true, completionDelivery: "steer" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "Explore", "find it",
        { description: "search", isBackground: true },
      );
    });

    it("passes caller-owned inline config through the same spawn path", async () => {
      const onSpawned = vi.fn();
      deps = { ...deps, onSpawned };
      registerRpcHandlers(deps);
      const reply = vi.fn();
      const inlineAgentConfig = {
        name: "reviewer",
        description: "Inline reviewer",
        builtinToolNames: ["read", "grep", "find", "ls"],
        extensions: false,
        skills: false,
        systemPrompt: "Review the supplied input.",
        promptMode: "replace" as const,
      };

      events.on("subagents:rpc:spawn:reply:req-inline", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-inline",
        type: "reviewer",
        prompt: "review now",
        options: {
          inlineAgentConfig,
          completionOwner: "caller",
          correlationId: "route-1",
          isBackground: true,
        },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const expectedOptions = {
        inlineAgentConfig,
        completionOwner: "caller",
        correlationId: "route-1",
        isBackground: true,
        description: "Inline reviewer",
      };
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "reviewer", "review now", expectedOptions,
      );
      expect(onSpawned).toHaveBeenCalledWith({ id: "agent-42", ctx, options: expectedOptions });
    });

    it("rejects caller-owned completion without background execution and correlation", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-invalid-owner", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-invalid-owner",
        type: "reviewer",
        prompt: "x",
        options: { completionOwner: "caller" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply.mock.calls[0][0]).toEqual({
        success: false,
        error: 'completionOwner="caller" requires isBackground=true',
      });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("rejects inline config whose name does not match the spawn type", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-invalid-inline", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-invalid-inline",
        type: "reviewer",
        prompt: "x",
        options: {
          inlineAgentConfig: {
            name: "different-role",
            description: "Inline reviewer",
            extensions: false,
            skills: false,
            systemPrompt: "Review.",
            promptMode: "replace",
          },
        },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply.mock.calls[0][0]).toEqual({
        success: false,
        error: 'inlineAgentConfig.name must match spawn type "reviewer"',
      });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("passes per-spawn graceTurns through without changing the global default", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-grace", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-grace",
        type: "reviewer",
        prompt: "review now",
        options: {
          description: "review",
          isBackground: true,
          graceTurns: 15,
        },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "reviewer", "review now",
        { description: "review", isBackground: true, graceTurns: 15 },
      );
    });

    it("rejects non-positive graceTurns before spawning", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-bad-grace", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-bad-grace",
        type: "reviewer",
        prompt: "x",
        options: { graceTurns: 0 },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply.mock.calls[0][0]).toEqual({
        success: false,
        error: "graceTurns must be a positive integer",
      });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("rejects malformed route options before spawning", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-invalid-route", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-invalid-route",
        type: "reviewer",
        prompt: "x",
        options: { model: { provider: "test" }, thinkingLevel: "extreme" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply.mock.calls[0][0]).toEqual({
        success: false,
        error: "model must be a non-empty string or Model object with provider/id",
      });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("returns error when no active session", async () => {
      ctx = undefined;
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s3", type: "general-purpose", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "No active session" });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("returns error when manager.spawn throws", async () => {
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("unknown agent type");
      });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s4", type: "bad-type", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "unknown agent type" });
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-other", wrongReply);
      events.on("subagents:rpc:spawn:reply:req-s5", rightReply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s5", type: "general-purpose", prompt: "x",
      });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to spawns", async () => {
      const { unsubSpawn } = registerRpcHandlers(deps);
      unsubSpawn();

      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s6", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s6", type: "general-purpose", prompt: "x",
      });

      // Give any potential async handler time to fire
      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- stop ---

  describe("stop RPC", () => {
    it("returns success when agent is aborted", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st1", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.abort).toHaveBeenCalledWith("agent-42");
    });

    it("delays the stop reply until abortAndWait reaches terminal", async () => {
      let release!: () => void;
      const terminal = new Promise<void>((resolve) => { release = resolve; });
      manager.abortAndWait = vi.fn(async () => {
        await terminal;
        return true;
      });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-wait", reply);

      events.emit("subagents:rpc:stop", { requestId: "req-wait", agentId: "agent-42" });
      await Promise.resolve();
      expect(reply).not.toHaveBeenCalled();

      release();
      await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
      expect(manager.abortAndWait).toHaveBeenCalledWith("agent-42");
      expect(manager.abort).not.toHaveBeenCalled();
    });

    it("returns error when agent not found", async () => {
      (manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st2", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st2", agentId: "nonexistent" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-other", wrongReply);
      events.on("subagents:rpc:stop:reply:req-st3", rightReply);
      events.emit("subagents:rpc:stop", { requestId: "req-st3", agentId: "agent-42" });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to stop requests", async () => {
      const { unsubStop } = registerRpcHandlers(deps);
      unsubStop();

      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st4", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st4", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- concurrent requests ---

  describe("concurrent requests", () => {
    it("handles multiple simultaneous spawn requests independently", async () => {
      let callCount = 0;
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => `agent-${++callCount}`);
      registerRpcHandlers(deps);

      const reply1 = vi.fn();
      const reply2 = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-a", reply1);
      events.on("subagents:rpc:spawn:reply:req-b", reply2);

      events.emit("subagents:rpc:spawn", { requestId: "req-a", type: "Explore", prompt: "first" });
      events.emit("subagents:rpc:spawn", { requestId: "req-b", type: "Plan", prompt: "second" });

      await vi.waitFor(() => {
        expect(reply1).toHaveBeenCalled();
        expect(reply2).toHaveBeenCalled();
      });

      expect(reply1).toHaveBeenCalledWith({ success: true, data: { id: "agent-1" } });
      expect(reply2).toHaveBeenCalledWith({ success: true, data: { id: "agent-2" } });
    });
  });

  // --- model override resolution (regression for cross-extension callers
  //     that forward a serializable string instead of a Model object) ---

  describe("spawn RPC model override", () => {
    const fakeModel = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
    const registry = {
      find: (provider: string, id: string) =>
        provider === fakeModel.provider && id === fakeModel.id ? fakeModel : null,
      getAll: () => [fakeModel],
      getAvailable: () => [fakeModel],
    };

    beforeEach(() => {
      ctx = { session: true, modelRegistry: registry };
      deps = { events, pi: { events }, getCtx: () => ctx, manager };
    });

    it("resolves a string model to a Model instance before manager.spawn", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m1", type: "general-purpose", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x",
        { model: fakeModel },
      );
    });

    it("passes a Model object through unchanged", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m2", type: "general-purpose", prompt: "x",
        options: { model: fakeModel },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x",
        { model: fakeModel },
      );
    });

    it("surfaces a clear error when the model string can't be resolved", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m3", type: "general-purpose", prompt: "x",
        options: { model: "nope/does-not-exist" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not found/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("errors when ctx has no modelRegistry but a string model is given", async () => {
      ctx = { session: true }; // no modelRegistry
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m4", type: "general-purpose", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/modelRegistry is unavailable/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });
  });
});
