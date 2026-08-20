/**
 * Editor-slot dashboard for Cursor command reports.
 *
 * Reports replace the bottom editor, the same place pi-meter uses, instead of
 * writing into the chat transcript or floating over the conversation.
 */

import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ReportDashboardTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export type ReportTone = "info" | "error";

export function reportViewportRows(terminalRows: number): number {
  return Math.max(8, Math.min(24, Math.floor(Math.max(1, terminalRows) * 0.8) - 4));
}

export class CursorReportDashboard {
  private scroll = 0;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(
    private readonly title: string,
    private readonly body: string,
    private readonly theme: ReportDashboardTheme,
    private readonly tone: ReportTone = "info",
    private readonly bodyRows = 16,
  ) {}

  public onDone?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onDone?.();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.scroll += 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.scroll = Math.max(0, this.scroll - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scroll += this.bodyRows;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scroll = Math.max(0, this.scroll - this.bodyRows);
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;
    const safeWidth = Math.max(1, width);
    const t = this.theme;
    const bodyColor = this.tone === "error" ? "error" : "text";
    const wrapped = this.body
      .split("\n")
      .flatMap((line) => (line ? wrapTextWithAnsi(t.fg(bodyColor, line), safeWidth) : [""]));
    const maxScroll = Math.max(0, wrapped.length - this.bodyRows);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visible = wrapped.slice(this.scroll, this.scroll + this.bodyRows);
    const footer =
      wrapped.length > this.bodyRows
        ? `[↑↓] scroll ${this.scroll + 1}-${this.scroll + visible.length}/${wrapped.length}  [q] close`
        : "[q] close";
    const lines = [
      ...wrapTextWithAnsi(t.fg("accent", t.bold(this.title)), safeWidth),
      "",
      ...visible,
      "",
      ...wrapTextWithAnsi(t.fg("dim", footer), safeWidth),
    ];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export async function showCursorReport(
  ctx: Pick<ExtensionCommandContext, "mode" | "hasUI" | "ui">,
  title: string,
  body: string,
  tone: ReportTone = "info",
): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const dash = new CursorReportDashboard(
        title,
        body,
        {
          fg: (color, text) => theme.fg(color as never, text),
          bold: (text) => theme.bold(text),
        },
        tone,
        reportViewportRows(tui.terminal.rows),
      );
      dash.onDone = () => done();
      return {
        render: (width) => dash.render(width),
        invalidate: () => dash.invalidate(),
        handleInput: (data) => {
          dash.handleInput(data);
          tui.requestRender();
        },
      };
    });
    return;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(body, tone === "error" ? "error" : "info");
    return;
  }
  if (tone === "error") console.error(body);
  else console.log(body);
}
