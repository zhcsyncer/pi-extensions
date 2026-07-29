import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.js";

export { sanitizeAnsiForThemedOutput };

interface TextLikeContent {
  type: string;
  text?: string;
}

interface ToolResultLike {
  content?: unknown;
}

const QUIET_COMMAND_PREFIXES = [
  "cd",
  "mkdir",
  "rmdir",
  "rm",
  "mv",
  "cp",
  "touch",
  "chmod",
  "chown",
  "git add",
  "git checkout",
  "git switch",
  "git restore",
  "git reset",
  "git clean",
  "npm install",
  "pnpm install",
  "yarn install",
  "bun install",
  "pip install",
  "poetry install",
  "cargo fetch",
  "go mod tidy",
  "Set-Location",
  "New-Item",
  "Remove-Item",
  "Move-Item",
  "Copy-Item",
] as const;

interface CompactOutputOptions {
  expanded: boolean;
  maxCollapsedConsecutiveEmptyLines?: number;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1]?.trim().length === 0) {
    next.pop();
  }
  return next;
}

function collapseConsecutiveEmptyLines(
  lines: string[],
  maxConsecutiveEmptyLines: number,
): string[] {
  const maxAllowed = Math.max(0, maxConsecutiveEmptyLines);
  if (maxAllowed === 0) {
    return lines.filter((line) => line.trim().length > 0);
  }

  const compacted: string[] = [];
  let consecutiveEmpty = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty > maxAllowed) {
        continue;
      }
    } else {
      consecutiveEmpty = 0;
    }
    compacted.push(line);
  }

  return compacted;
}

export function shortenPath(inputPath: string | undefined): string {
  if (!inputPath) {
    return "";
  }
  const home = homedir();
  const isHomePath = inputPath === home || inputPath.startsWith(`${home}/`) || inputPath.startsWith(`${home}\\`);
  return isHomePath
    ? `~${inputPath.slice(home.length)}`
    : inputPath;
}

interface DisplayPathParts {
  prefix: string;
  separator: "/" | "\\";
  segments: string[];
}

function splitDisplayPath(path: string): DisplayPathParts {
  const separator: "/" | "\\" = path.includes("/") || !path.includes("\\") ? "/" : "\\";
  let prefix = "";
  let rest = path;

  if (separator === "/") {
    if (rest.startsWith("~/")) {
      prefix = "~/";
      rest = rest.slice(2);
    } else if (rest.startsWith("/")) {
      prefix = "/";
      rest = rest.slice(1);
    } else if (rest.startsWith("./")) {
      prefix = "./";
      rest = rest.slice(2);
    } else {
      while (rest.startsWith("../")) {
        prefix += "../";
        rest = rest.slice(3);
      }
    }
  } else {
    const drive = rest.match(/^[A-Za-z]:\\/u)?.[0];
    if (drive) {
      prefix = drive;
      rest = rest.slice(drive.length);
    } else if (rest.startsWith("\\\\")) {
      prefix = "\\\\";
      rest = rest.slice(2);
    } else if (rest.startsWith(".\\")) {
      prefix = ".\\";
      rest = rest.slice(2);
    } else {
      while (rest.startsWith("..\\")) {
        prefix += "..\\";
        rest = rest.slice(3);
      }
    }
  }

  return {
    prefix,
    separator,
    segments: rest.split(separator).filter((segment) => segment.length > 0),
  };
}

function joinDisplayPath(prefix: string, separator: "/" | "\\", segments: string[]): string {
  return `${prefix}${segments.join(separator)}`;
}

/** Compact the middle of a path while preserving its root, first directory, and basename. */
export function compactPathForDisplay(inputPath: string | undefined, maxWidth: number): string {
  const path = shortenPath(inputPath);
  const safeWidth = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : 0;
  if (!path || safeWidth === 0) {
    return "";
  }
  if (visibleWidth(path) <= safeWidth) {
    return path;
  }

  const { prefix, separator, segments } = splitDisplayPath(path);
  if (segments.length < 2) {
    return truncateToWidth(path, safeWidth, "…");
  }

  const basename = segments.at(-1) ?? "";
  const directories = segments.slice(0, -1);
  const firstDirectory = directories[0];
  const remainingDirectories = firstDirectory === undefined ? [] : directories.slice(1);

  if (firstDirectory !== undefined) {
    for (let tailCount = Math.max(0, remainingDirectories.length - 1); tailCount >= 0; tailCount--) {
      const tail = tailCount > 0 ? remainingDirectories.slice(-tailCount) : [];
      const candidate = joinDisplayPath(prefix, separator, [firstDirectory, "…", ...tail, basename]);
      if (visibleWidth(candidate) <= safeWidth) {
        return candidate;
      }
    }
  }

  for (let tailCount = Math.max(0, directories.length - 1); tailCount >= 0; tailCount--) {
    const tail = tailCount > 0 ? directories.slice(-tailCount) : [];
    const candidate = joinDisplayPath(prefix, separator, ["…", ...tail, basename]);
    if (visibleWidth(candidate) <= safeWidth) {
      return candidate;
    }
  }

  return truncateToWidth(basename || path, safeWidth, "…");
}

export function extractTextOutput(result: ToolResultLike): string {
  const rawBlocks = Array.isArray(result.content) ? result.content : [];
  const blocks = rawBlocks.filter(
    (block): block is TextLikeContent =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as TextLikeContent).type === "text" &&
      typeof (block as TextLikeContent).text === "string",
  );
  return blocks.map((block) => block.text ?? "").join("\n");
}

export function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\t/g, "    "));
}

export function compactOutputLines(
  lines: string[],
  options: CompactOutputOptions,
): string[] {
  const trimmed = trimTrailingEmptyLines(lines);
  if (options.expanded) {
    return trimmed;
  }

  return collapseConsecutiveEmptyLines(
    trimmed,
    options.maxCollapsedConsecutiveEmptyLines ?? 1,
  );
}

export function isLikelyQuietCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }

  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const primarySegment = normalized
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .find((segment) => segment.length > 0);

  if (!primarySegment) {
    return false;
  }

  for (const prefix of QUIET_COMMAND_PREFIXES) {
    const normalizedPrefix = prefix.toLowerCase();
    if (
      primarySegment === normalizedPrefix ||
      primarySegment.startsWith(`${normalizedPrefix} `)
    ) {
      return true;
    }
  }

  return false;
}

export function countNonEmptyLines(lines: string[]): number {
  return lines.filter((line) => line.trim().length > 0).length;
}

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}
