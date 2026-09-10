import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/agent-runner-restart.mjs", import.meta.url));

describe("runner restoration across process restart (real SDK, local faux provider)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runner-restart-"));
    for (const dir of ["work", "config", "agent", "sessions", "home"]) mkdirSync(join(root, dir));
    mkdirSync(join(root, "config", ".pi", "skills", "original-skill"), { recursive: true });
    writeFileSync(join(root, "config", ".pi", "skills", "original-skill", "SKILL.md"),
      "---\nname: original-skill\ndescription: ORIGINAL_SKILL_CATALOGUE\n---\nOriginal skill content.\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function phase(name: string) {
    const { stdout } = await exec(process.execPath, [fixture, name, root], {
      timeout: 30_000,
      env: { ...process.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
    });
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  }

  it("finishes at maxTurns=1 without stranded internal steering and guides only actual continuation", async () => {
    const result = await phase("limit");
    expect(result.error).toBeUndefined();
    expect(result.first.responseText).toBe("TERMINAL_ON_TURN_ONE");
    expect(result.firstCalls).toBe(1);
    expect(result.firstQueues).toEqual([[], []]);
    expect(result.resumed).toMatchObject({ text: "GUIDED_FINAL", steered: true, aborted: false });
    expect(result.queues).toEqual([[], []]);
    expect(result.preservedQueues).toEqual([["USER_STEER"], ["USER_FOLLOWUP"]]);
  }, 30_000);

  it("retains original prompt, tool scope, compacted context and SDK entries in a fresh process", async () => {
    const original = await phase("create");
    expect(original.error).toBeUndefined();
    expect(original.snapshot.systemPrompt).toContain("ORIGINAL_ROLE");
    expect(original.snapshot.systemPrompt).toContain("ORIGINAL_PARENT_SYSTEM");
    expect(original.snapshot.systemPrompt).toContain("ORIGINAL_SKILL_CATALOGUE");
    expect(readFileSync(original.sessionFile, "utf8")).toContain("ORIGINAL_PARENT_HISTORY");
    // New resource discovery must not rewrite the saved rendered prompt.
    writeFileSync(join(root, "config", ".pi", "skills", "original-skill", "SKILL.md"),
      "---\nname: original-skill\ndescription: CHANGED_SKILL_CATALOGUE\n---\nChanged.\n");
    const restored = await phase("restore");
    expect(restored.error).toBeUndefined();
    expect(restored.pid).not.toBe(original.pid);
    expect(restored.originalPrompt).toBe(original.snapshot.systemPrompt);
    expect(restored.request.systemPrompt).toBe(original.snapshot.systemPrompt);
    expect(restored.before[0]).toMatchObject({ role: "compactionSummary", summary: "COMPACTED_ORIGINAL_CONTEXT" });
    expect(JSON.stringify(restored.before)).toContain("RETAINED_TASK");
    expect(JSON.stringify(restored.before)).not.toContain("ORIGINAL_TASK");
    expect(JSON.stringify(restored.request.messages)).toContain("COMPACTED_ORIGINAL_CONTEXT");
    expect(restored.result).toMatchObject({ text: "RESTORED_ANSWER", aborted: false, steered: false });
    expect(restored.sessionFile).toBe(original.sessionFile);
    expect(restored.tools).toEqual(["read"]);
    expect(restored.custom.data).toEqual({ original: true });
  }, 60_000);

  it("rejects missing, empty, corrupt files and unavailable models without creating fresh sessions", async () => {
    const original = await phase("create");
    expect(original.error).toBeUndefined();
    const savedText = readFileSync(original.sessionFile, "utf8");
    const existing = readdirSync(join(root, "sessions"));
    for (const invalid of ["", "not json", savedText + '\n{"type":"message"']) {
      writeFileSync(original.sessionFile, invalid);
      expect((await phase("restore")).error).toMatch(/empty|corrupt JSONL/i);
      expect(readFileSync(original.sessionFile, "utf8")).toBe(invalid);
      expect(readdirSync(join(root, "sessions"))).toEqual(existing);
    }
    rmSync(original.sessionFile);
    expect((await phase("restore")).error).toMatch(/ENOENT/);
    expect(readdirSync(join(root, "sessions"))).toEqual([]);
    writeFileSync(original.sessionFile, savedText);
    expect((await phase("unavailable")).error).toMatch(/unavailable/);
    expect(readFileSync(original.sessionFile, "utf8")).toBe(savedText);
    expect(readdirSync(join(root, "sessions"))).toEqual(existing);
  }, 120_000);
});
