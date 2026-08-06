import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
}

export function createMockPi(options: Partial<ExtensionAPI> = {}): { pi: ExtensionAPI; captured: CapturedPi } {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, command);
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		}),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => []),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const entries = captured.eventsEmitted.get(channel) ?? [];
				entries.push(data);
				captured.eventsEmitted.set(channel, entries);
			}),
			on: vi.fn(() => () => {}),
		},
		...options,
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

interface MockCtxOptions {
	hasUI?: boolean;
	mode?: string;
	cwd?: string;
	ui?: Partial<ExtensionUIContext>;
}

export function createMockCtx(options: MockCtxOptions = {}): ExtensionContext {
	const ui = {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		...options.ui,
	};
	return {
		hasUI: options.hasUI ?? false,
		mode: options.mode,
		cwd: options.cwd ?? "/tmp/test-cwd",
		ui,
		isProjectTrusted: vi.fn(() => true),
		isIdle: vi.fn(() => true),
		sessionManager: {
			getBranch: vi.fn(() => []),
			getEntries: vi.fn(() => []),
			getLeafId: vi.fn(() => null),
			getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
			getSessionId: vi.fn(() => "test-session"),
		},
		modelRegistry: {},
	} as unknown as ExtensionContext;
}

export function makeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

const SKIP_DIRS = new Set(["node_modules", "docs"]);
const SKIP_FILES = new Set(["test-fixtures.ts", "test-support.ts"]);

export function verifyShipManifest(packageDirOrUrl: string): {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
} {
	const packageDir = packageDirOrUrl.startsWith("file:")
		? dirname(fileURLToPath(packageDirOrUrl))
		: packageDirOrUrl;
	const pkg = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { files?: string[] };
	const declared = pkg.files ?? [];
	const exactFiles = new Set<string>();
	const dirPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/") || isDirectory(packageDir, entry)) dirPrefixes.push(entry.endsWith("/") ? entry : `${entry}/`);
		else exactFiles.add(entry);
	}
	const onDisk = walkProductionTs(packageDir, packageDir);
	const missing = onDisk.filter(
		(file) => !exactFiles.has(file) && !dirPrefixes.some((prefix) => file.startsWith(prefix)),
	);
	const stale = declared.filter((entry) => !entry.startsWith("!") && !existsSync(resolve(packageDir, entry)));
	return { declared, onDisk, missing, stale };
}

function isDirectory(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		return false;
	}
}

function walkProductionTs(root: string, dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const absolute = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkProductionTs(root, absolute));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
		if (SKIP_FILES.has(entry.name)) continue;
		files.push(relative(root, absolute));
	}
	return files;
}
