// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSubagentsConfigNoticesForTests } from "../src/config-storage.js";
import {
  getGlobalAgentToolDescriptionPath,
  getLegacyGlobalAgentToolDescriptionPath,
  getLegacyProjectAgentToolDescriptionPath,
  getProjectAgentToolDescriptionPath,
  getProjectSubagentsSettingsPath,
} from "../src/config-paths.js";
import subagentsExtension from "../src/index.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../examples/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let prevXdgConfigHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function writeConfigFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate every user-level root so real settings or templates cannot leak
    // into registration-time assertions.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = join(hermeticAgentDir, "home");
    process.env.XDG_CONFIG_HOME = join(hermeticAgentDir, "xdg");
    prevCwd = process.cwd();
    if (settings) {
      writeConfigFile(getProjectSubagentsSettingsPath(tmpDir), JSON.stringify(settings));
    }
    resetSubagentsConfigNoticesForTests();
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdgConfigHome == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    resetSubagentsConfigNoticesForTests();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("defaults to the full description", () => {
    const tools = setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
    // Full agent descriptions are embedded (a late Explore sentence survives).
    expect(desc).toContain("very thorough");
  });

  it("compact mode swaps in the short description with one-line type list", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Launch an autonomous agent");
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    // Type list keeps every agent but only the first sentence of each description.
    expect(desc).toContain("- general-purpose:");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
    expect(desc).not.toContain("very thorough");
    // The point of the feature: materially smaller than the full version.
    expect(desc.length).toBeLessThan(1600);
  });

  it("invalid mode in the settings file is dropped — full description", () => {
    const tools = setup({ toolDescriptionMode: "tiny" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
  });

  it("compact keeps every load-bearing contract — fails when a behavior change forgets compact", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    // One keyword per behavioral contract the orchestrator must know about.
    // If you change one of these behaviors, update BOTH descriptions.
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      'isolation: "worktree"',
      ".pi/agents/",
      "self-contained",
    ]) {
      expect(desc).toContain(contract);
    }
  });

  it("custom mode renders the canonical project template and de-duplicates unknown-placeholder warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(
        getProjectAgentToolDescriptionPath(tmpDir),
        "My agents:\n{{typeList}}\n\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal",
      );
      writeConfigFile(getGlobalAgentToolDescriptionPath(hermeticAgentDir), "GLOBAL MUST NOT WIN");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("My agents:");
    expect(desc).toContain("- general-purpose:"); // {{typeList}} expanded
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`); // {{agentDir}} expanded
    expect(desc).toContain("Unknown: {{nope}}"); // unknown placeholder left verbatim
    expect(desc).toContain("Cost: $& stays literal"); // no $-pattern expansion
    expect(desc).not.toContain("GLOBAL MUST NOT WIN");
    expect(desc).not.toContain("## Usage notes");

    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(warn.mock.calls.filter(([message]) => String(message).includes("unknown placeholder"))).toHaveLength(1);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode falls back to the canonical global file when no project file exists", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getGlobalAgentToolDescriptionPath(hermeticAgentDir), "GLOBAL CUSTOM\n{{compactTypeList}}");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("GLOBAL CUSTOM");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
  });

  it("migrates the legacy project description before rendering it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getLegacyProjectAgentToolDescriptionPath(tmpDir), "LEGACY PROJECT\n{{compactTypeList}}");
    });

    expect(tools.get("Agent").description).toContain("LEGACY PROJECT");
    expect(readFileSync(getProjectAgentToolDescriptionPath(tmpDir), "utf8").trim()).toContain("LEGACY PROJECT");
    expect(() => readFileSync(getLegacyProjectAgentToolDescriptionPath(tmpDir), "utf8")).toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Migrated project agent tool description"));
  });

  it("migrates the legacy global description when the project has no override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getLegacyGlobalAgentToolDescriptionPath(hermeticAgentDir), "LEGACY GLOBAL");
    });

    expect(tools.get("Agent").description).toContain("LEGACY GLOBAL");
    expect(readFileSync(getGlobalAgentToolDescriptionPath(hermeticAgentDir), "utf8").trim()).toBe("LEGACY GLOBAL");
    expect(() => readFileSync(getLegacyGlobalAgentToolDescriptionPath(hermeticAgentDir), "utf8")).toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Migrated global agent tool description"));
  });

  it("keeps a conflicting legacy description while canonical content wins", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getProjectAgentToolDescriptionPath(tmpDir), "CANONICAL PROJECT");
      writeConfigFile(getLegacyProjectAgentToolDescriptionPath(tmpDir), "CONFLICTING LEGACY");
    });

    expect(tools.get("Agent").description).toContain("CANONICAL PROJECT");
    expect(readFileSync(getLegacyProjectAgentToolDescriptionPath(tmpDir), "utf8")).toContain("CONFLICTING LEGACY");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("conflicting legacy project agent tool description"));
  });

  it("does not replace an empty canonical description with valid legacy content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getProjectAgentToolDescriptionPath(tmpDir), "  \n");
      writeConfigFile(getLegacyProjectAgentToolDescriptionPath(tmpDir), "LEGACY MUST NOT WIN");
    });

    expect(tools.get("Agent").description).toContain("## Usage notes");
    expect(tools.get("Agent").description).not.toContain("LEGACY MUST NOT WIN");
    expect(readFileSync(getLegacyProjectAgentToolDescriptionPath(tmpDir), "utf8")).toBe("LEGACY MUST NOT WIN");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy config was not used or removed"));
  });

  it("retains an empty legacy description and falls back to full with observable warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getLegacyProjectAgentToolDescriptionPath(tmpDir), "  \n");
    });

    expect(tools.get("Agent").description).toContain("## Usage notes");
    expect(readFileSync(getLegacyProjectAgentToolDescriptionPath(tmpDir), "utf8")).toBe("  \n");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the file is empty"));
  });

  it("{{scheduleGuideline}} expands to the schedule bullet when scheduling is on (default)", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getProjectAgentToolDescriptionPath(tmpDir), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    // The expansion carries its own leading "\n- " bullet.
    expect(desc).toContain("RULES:\n- Use `schedule` only when");
  });

  it("{{scheduleGuideline}} expands to the empty string when scheduling is disabled", () => {
    const tools = setup({ toolDescriptionMode: "custom", schedulingEnabled: false }, () => {
      writeConfigFile(getProjectAgentToolDescriptionPath(tmpDir), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("RULES:\nEND");
    expect(desc).not.toContain("schedule");
  });

  it("every documented placeholder is replaced — no {{ }} residue", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(
        getProjectAgentToolDescriptionPath(tmpDir),
        "A {{typeList}} B {{compactTypeList}} C {{agentDir}} D {{scheduleGuideline}} E",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).not.toContain("{{");
    expect(desc).not.toContain("}}");
  });

  it("the shipped example template renders byte-identical to the full description", async () => {
    // Guards examples/agent-tool-description.md against going stale: it must
    // reproduce the full description exactly. If you edit one, edit the other.
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeConfigFile(getProjectAgentToolDescriptionPath(tmpDir), example);
    });
    const customDesc: string = tools.get("Agent").description;

    // Second instance in the same hermetic cwd, flipped to full mode.
    writeConfigFile(getProjectSubagentsSettingsPath(tmpDir), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to full and de-duplicates the warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = setup({ toolDescriptionMode: "custom" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");

    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("no extension-data/pi-subagents/agent-tool-description.md was usable"),
        ),
      ).toHaveLength(1);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });
});
