import { describe, expect, it } from "vitest";
import { sanitizeDisplayText } from "../src/ui/display-safety.js";

describe("sanitizeDisplayText", () => {
  it("strips CSI, OSC, DCS, C0, and C1 terminal controls", () => {
    const input = [
      "before",
      "\u001b[31mred\u001b[0m",
      "\u001b]8;;https://example.invalid/?token=secret\u0007link\u001b]8;;\u0007",
      "\u001bPignored payload\u001b\\",
      "\u009b32mgreen\u009b0m",
      "\u0000\u0001after",
    ].join("");

    const output = sanitizeDisplayText(input);

    expect(output).toBe("beforeredlinkgreenafter");
    expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    expect(output).not.toContain("example.invalid");
    expect(output).not.toContain("ignored payload");
  });

  it("preserves printable wide text, tabs, and line feeds", () => {
    expect(sanitizeDisplayText("中文🙂\talpha\r\nbeta\rgamma")).toBe("中文🙂\talpha\nbeta\ngamma");
  });
});
