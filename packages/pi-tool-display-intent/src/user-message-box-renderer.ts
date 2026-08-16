import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type DefaultTextStyle,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  patchUserMessageRenderPrototype,
  type PatchableUserMessagePrototype,
} from "./user-message-box-patch.js";
import {
  extractUserMessageMarkdownState,
  type UserMessageMarkdownState,
} from "./user-message-box-markdown.js";

export type { PatchableUserMessagePrototype } from "./user-message-box-patch.js";
import {
  addUserMessageVerticalPadding,
  applyUserMessageBackground,
  normalizeUserMessageContentLine,
  normalizeUserMessageContentLines,
  type UserMessageBackgroundTheme,
} from "./user-message-box-utils.js";

export interface UserMessageTheme extends UserMessageBackgroundTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

interface CachedUserMessageMarkdownRenderer {
  text: string;
  theme: unknown;
  defaultTextStyle?: Record<string, unknown>;
  renderer: { render(width: number): string[] };
  renderedWidth: number;
  renderedLines: string[];
}

interface CachedUserMessageFinalOutput {
  width: number;
  theme: UserMessageTheme | undefined;
  compact: boolean;
  hasMarkdownState: boolean;
  text?: string;
  markdownTheme?: unknown;
  defaultTextStyle?: Record<string, unknown>;
  output: string[];
}

interface CachedUserMessageBodyLines {
  width: number;
  lines: string[];
}

const MIN_BORDER_WIDTH = 8;
const TITLE_TEXT = " user ";
const CONTENT_HORIZONTAL_PADDING_COLUMNS = 1;
const USER_MESSAGE_TOP_MARGIN_LINES = 1;
const AGGREGATE_USER_GUTTER = "▎";
const AGGREGATE_USER_GUTTER_GAP = " ";
const USER_MESSAGE_PATCH_VERSION = 14;
const MAX_USER_MESSAGE_MARKDOWN_TEXT_LENGTH = 100_000;
const MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT = 2_000;

function colorBorder(theme: UserMessageTheme | undefined, text: string): string {
  if (!text || !theme) {
    return text;
  }

  try {
    return theme.fg("border", text);
  } catch {
    return text;
  }
}

function colorTitle(theme: UserMessageTheme | undefined, title: string): string {
  if (!title) {
    return title;
  }

  const base = theme?.bold ? theme.bold(title) : title;
  if (!theme) {
    return base;
  }

  try {
    return theme.fg("accent", base);
  } catch {
    return base;
  }
}

function colorUserBackground(
  theme: UserMessageTheme | undefined,
  text: string,
): string {
  return applyUserMessageBackground(theme, text);
}

function computeBoxInnerWidth(totalWidth: number): number {
  return Math.max(0, totalWidth - 2);
}

function buildTopBorder(
  totalWidth: number,
  theme: UserMessageTheme | undefined,
): string {
  const innerWidth = computeBoxInnerWidth(totalWidth);
  const title = truncateToWidth(TITLE_TEXT, innerWidth, "");
  const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
  const row = `${colorBorder(theme, "╭")}${colorTitle(theme, title)}${colorBorder(theme, `${fill}╮`)}`;

  return colorUserBackground(theme, row);
}

function buildBottomBorder(
  totalWidth: number,
  theme: UserMessageTheme | undefined,
): string {
  const innerWidth = computeBoxInnerWidth(totalWidth);
  const row = `${colorBorder(theme, "╰")}${colorBorder(theme, `${"─".repeat(innerWidth)}╯`)}`;

  return colorUserBackground(theme, row);
}

function getUserMessageContentWidth(totalWidth: number): number {
  return Math.max(
    1,
    totalWidth - 2 - CONTENT_HORIZONTAL_PADDING_COLUMNS * 2,
  );
}

function colorThemeText(
  theme: UserMessageTheme | undefined,
  color: string,
  text: string,
): string {
  if (!theme) return text;
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

function wrapAggregatePromptLine(
  line: string,
  totalWidth: number,
  theme: UserMessageTheme | undefined,
): string {
  const prefixWidth = visibleWidth(AGGREGATE_USER_GUTTER) + visibleWidth(AGGREGATE_USER_GUTTER_GAP);
  const contentWidth = Math.max(1, totalWidth - prefixWidth);
  const normalizedLine = normalizeUserMessageContentLine(line);
  const content = truncateToWidth(normalizedLine, contentWidth, "", true);
  const coloredContent = colorThemeText(theme, "userMessageText", content);
  const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
  const gutter = colorThemeText(theme, "accent", AGGREGATE_USER_GUTTER);
  return colorUserBackground(theme, `${gutter}${AGGREGATE_USER_GUTTER_GAP}${coloredContent}${padding}`);
}

function wrapContentLine(
  line: string,
  totalWidth: number,
  theme: UserMessageTheme | undefined,
): string {
  const sidePadding = " ".repeat(CONTENT_HORIZONTAL_PADDING_COLUMNS);
  const innerWidth = getUserMessageContentWidth(totalWidth);
  const normalizedLine = normalizeUserMessageContentLine(line);
  const content = truncateToWidth(normalizedLine, innerWidth, "", true);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  const row = `${colorBorder(theme, "│")}${sidePadding}${content}${padding}${sidePadding}${colorBorder(theme, "│")}`;

  return colorUserBackground(theme, row);
}

function createMarkdownRenderer(
  markdownState: UserMessageMarkdownState,
): { render(width: number): string[] } {
  return new Markdown(
    markdownState.text,
    0,
    0,
    markdownState.theme as MarkdownTheme,
    markdownState.defaultTextStyle as DefaultTextStyle | undefined,
  );
}

function countUserMessageLines(text: string, maxLines: number): number {
  let lineCount = 1;
  for (const character of text) {
    if (character !== "\n") {
      continue;
    }

    lineCount++;
    if (lineCount > maxLines) {
      return lineCount;
    }
  }

  return lineCount;
}

function hasSameDefaultTextStyle(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return left === right;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

function hasSameMarkdownState(
  cached: Pick<CachedUserMessageMarkdownRenderer, "text" | "theme" | "defaultTextStyle">,
  state: UserMessageMarkdownState,
): boolean {
  return cached.text === state.text
    && cached.theme === state.theme
    && hasSameDefaultTextStyle(cached.defaultTextStyle, state.defaultTextStyle);
}

function hasSameFinalOutputState(
  cached: CachedUserMessageFinalOutput,
  width: number,
  theme: UserMessageTheme | undefined,
  markdownState: UserMessageMarkdownState | undefined,
  compact: boolean,
): boolean {
  if (cached.width !== width || cached.theme !== theme || cached.compact !== compact) {
    return false;
  }

  if (!markdownState) {
    return !cached.hasMarkdownState;
  }

  return cached.hasMarkdownState
    && hasSameMarkdownState(
      {
        text: cached.text ?? "",
        theme: cached.markdownTheme,
        defaultTextStyle: cached.defaultTextStyle,
      },
      markdownState,
    );
}

function toFinalOutputCacheEntry(
  width: number,
  theme: UserMessageTheme | undefined,
  markdownState: UserMessageMarkdownState | undefined,
  output: string[],
  compact: boolean,
): CachedUserMessageFinalOutput {
  if (!markdownState) {
    return {
      width,
      theme,
      compact,
      hasMarkdownState: false,
      output,
    };
  }

  return {
    width,
    theme,
    compact,
    hasMarkdownState: true,
    text: markdownState.text,
    markdownTheme: markdownState.theme,
    defaultTextStyle: markdownState.defaultTextStyle,
    output,
  };
}

export function shouldBypassUserMessageMarkdownRebuild(
  markdownState: UserMessageMarkdownState,
): boolean {
  if (markdownState.text.length > MAX_USER_MESSAGE_MARKDOWN_TEXT_LENGTH) {
    return true;
  }

  return countUserMessageLines(
    markdownState.text,
    MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT,
  ) > MAX_USER_MESSAGE_MARKDOWN_LINE_COUNT;
}

export function createUserMessageMarkdownLineRenderer(
  buildRenderer: (
    markdownState: UserMessageMarkdownState,
  ) => { render(width: number): string[] } = createMarkdownRenderer,
): (
  instance: object,
  markdownState: UserMessageMarkdownState,
  width: number,
) => string[] {
  const cache = new WeakMap<object, CachedUserMessageMarkdownRenderer>();

  return (instance, markdownState, width) => {
    const cached = cache.get(instance);
    const canReuseRenderer = cached
      ? hasSameMarkdownState(cached, markdownState)
      : false;

    if (canReuseRenderer && cached?.renderedWidth === width) {
      return cached.renderedLines;
    }

    const renderer = canReuseRenderer && cached
      ? cached.renderer
      : buildRenderer(markdownState);
    const renderedLines = renderer.render(width);

    cache.set(instance, {
      text: markdownState.text,
      theme: markdownState.theme,
      defaultTextStyle: markdownState.defaultTextStyle,
      renderer,
      renderedWidth: width,
      renderedLines,
    });

    return renderedLines;
  };
}

const renderCachedUserMessageMarkdownLines =
  createUserMessageMarkdownLineRenderer();

function renderUserMessageBodyLines(
  instance: unknown,
  innerWidth: number,
  originalRender: (width: number) => string[],
  markdownState: UserMessageMarkdownState | undefined,
  originalBodyLineCache?: WeakMap<object, CachedUserMessageBodyLines>,
): string[] {
  if (typeof instance !== "object" || instance === null) {
    return originalRender.call(instance, innerWidth) as string[];
  }

  if (!markdownState) {
    const cached = originalBodyLineCache?.get(instance);
    if (cached?.width === innerWidth) {
      return cached.lines;
    }

    const lines = originalRender.call(instance, innerWidth) as string[];
    originalBodyLineCache?.set(instance, { width: innerWidth, lines });
    return lines;
  }

  if (shouldBypassUserMessageMarkdownRebuild(markdownState)) {
    return originalRender.call(instance, innerWidth) as string[];
  }

  try {
    return renderCachedUserMessageMarkdownLines(
      instance,
      markdownState,
      innerWidth,
    );
  } catch {
    return originalRender.call(instance, innerWidth) as string[];
  }
}

export function patchNativeUserMessagePrototype(
  prototype: PatchableUserMessagePrototype,
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
  isCompact?: () => boolean,
): void {
  const finalOutputCache = new WeakMap<object, CachedUserMessageFinalOutput>();
  const originalBodyLineCache = new WeakMap<object, CachedUserMessageBodyLines>();

  patchUserMessageRenderPrototype(
    prototype,
    USER_MESSAGE_PATCH_VERSION,
    (originalRender) =>
      function renderWithNativeUserBorder(width: number): string[] {
        const safeWidth = Math.max(0, Math.floor(width));
        if (!isEnabled() || safeWidth < MIN_BORDER_WIDTH) {
          return originalRender.call(this, safeWidth) as string[];
        }

        const canCacheFinalOutput = typeof this === "object" && this !== null;
        const markdownState = canCacheFinalOutput
          ? extractUserMessageMarkdownState(this as { children?: unknown[] })
          : undefined;
        if (markdownState && shouldBypassUserMessageMarkdownRebuild(markdownState)) {
          return originalRender.call(this, safeWidth) as string[];
        }

        const theme = getTheme();
        const compact = isCompact?.() === true;
        if (canCacheFinalOutput) {
          const cached = finalOutputCache.get(this as object);
          if (cached && hasSameFinalOutputState(cached, safeWidth, theme, markdownState, compact)) {
            return cached.output;
          }
        }

        const innerWidth = compact
          ? Math.max(1, safeWidth - visibleWidth(AGGREGATE_USER_GUTTER) - visibleWidth(AGGREGATE_USER_GUTTER_GAP))
          : getUserMessageContentWidth(safeWidth);
        const lines = renderUserMessageBodyLines(
          this,
          innerWidth,
          originalRender,
          markdownState,
          originalBodyLineCache,
        );
        const contentLines = normalizeUserMessageContentLines(lines);
        const bodyLines = contentLines.length > 0 ? contentLines : [""];
        const output = compact
          ? [
            wrapAggregatePromptLine("", safeWidth, theme),
            ...bodyLines.map((renderLine) => wrapAggregatePromptLine(renderLine, safeWidth, theme)),
            wrapAggregatePromptLine("", safeWidth, theme),
          ]
          : [
            ...Array.from({ length: USER_MESSAGE_TOP_MARGIN_LINES }, () => ""),
            buildTopBorder(safeWidth, theme),
            ...addUserMessageVerticalPadding(bodyLines).map((renderLine) =>
              wrapContentLine(renderLine, safeWidth, theme),
            ),
            buildBottomBorder(safeWidth, theme),
          ];

        if (canCacheFinalOutput) {
          finalOutputCache.set(
            this as object,
            toFinalOutputCacheEntry(safeWidth, theme, markdownState, output, compact),
          );
        }

        return output;
      },
  );
}
