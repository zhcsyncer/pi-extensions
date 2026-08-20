import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  CursorReportDashboard,
  reportViewportRows,
  showCursorReport,
} from "../src/extension/report-dashboard.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("CursorReportDashboard", () => {
  it("keeps the viewport tall enough for a report without filling the screen", () => {
    expect(reportViewportRows(12)).toBe(8);
    expect(reportViewportRows(40)).toBe(24);
    expect(reportViewportRows(24)).toBe(15);
  });

  it("renders a titled dashboard and keeps every line within width", () => {
    const dash = new CursorReportDashboard(
      "Cursor models",
      "opus-5  ctx  200000  Opus 5\nsonnet-5  ctx  200000  Sonnet 5",
      theme,
    );
    const lines = dash.render(40);
    expect(lines.some((line) => line.includes("Cursor models"))).toBe(true);
    expect(lines.some((line) => line.includes("[q] close"))).toBe(true);
    expect(lines.some((line) => line.includes("opus-5"))).toBe(true);
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });

  it("scrolls long reports and closes on q or escape", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
    const dash = new CursorReportDashboard("Cursor doctor", body, theme, "info", 8);
    const done = vi.fn();
    dash.onDone = done;

    const first = dash.render(32);
    expect(first.some((line) => line.includes("line-0"))).toBe(true);
    expect(first.some((line) => line.includes("line-19"))).toBe(false);

    dash.handleInput("j");
    const scrolled = dash.render(32);
    expect(scrolled.some((line) => line.includes("line-0"))).toBe(false);
    expect(scrolled.some((line) => line.includes("scroll"))).toBe(true);

    dash.handleInput("q");
    expect(done).toHaveBeenCalledTimes(1);
    dash.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(2);
  });
});

describe("showCursorReport", () => {
  it("opens a TUI dashboard in the editor slot and does not notify or print", async () => {
    const notify = vi.fn();
    const custom = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await showCursorReport(
      {
        mode: "tui",
        hasUI: true,
        ui: { notify, custom },
      } as unknown as ExtensionCommandContext,
      "Cursor models",
      "opus-5",
    );

    expect(custom).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints when there is no UI", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await showCursorReport(
      {
        mode: "print",
        hasUI: false,
        ui: { notify: vi.fn(), custom: vi.fn() },
      } as unknown as ExtensionCommandContext,
      "Cursor models",
      "opus-5",
    );
    expect(log).toHaveBeenCalledWith("opus-5");
    log.mockRestore();
  });
});
