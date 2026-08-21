import { describe, expect, it } from "vitest";
import { isolationParam } from "../src/invocation-config.js";

describe("isolationParam", () => {
  function schema(enabled: boolean) {
    const built = isolationParam(enabled);
    return built.isolation as {
      anyOf?: { const?: string }[];
      description?: string;
    } | undefined;
  }

  it("offers off before worktree", () => {
    expect(schema(true)?.anyOf?.map((value) => value.const)).toEqual(["off", "worktree"]);
  });

  it("warns that a linked checkout cannot see uncommitted work", () => {
    expect(JSON.stringify(schema(true))).toMatch(/uncommitted or staged/);
  });

  it("omits isolation entirely when repository worktrees are disabled", () => {
    expect(isolationParam(false)).toEqual({});
  });
});
