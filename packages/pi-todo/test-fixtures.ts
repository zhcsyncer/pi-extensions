import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
}

export function createMockPi(): { pi: ExtensionAPI; captured: CapturedPi } {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		events: new Map(),
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => captured.tools.set(tool.name, tool)),
		registerCommand: vi.fn(
			(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
				captured.commands.set(name, command),
		),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		}),
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
}

export function createMockUI(): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
	};
}

export function createMockCtx(options: {
	hasUI?: boolean;
	branch?: SessionEntry[];
} = {}): ExtensionContext {
	const branch = options.branch ?? [];
	return {
		hasUI: options.hasUI ?? false,
		cwd: "/tmp/pi-todo-test",
		ui: createMockUI() as unknown as ExtensionUIContext,
		sessionManager: {
			getBranch: vi.fn(() => branch),
			getEntries: vi.fn(() => branch),
			getLeafId: vi.fn(() => (branch.length > 0 ? branch.at(-1)?.id ?? null : null)),
			getSessionFile: vi.fn(() => "/tmp/pi-todo-test/session.jsonl"),
			getSessionId: vi.fn(() => "pi-todo-test"),
		},
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

export function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
}

export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function makeToolResult(details: unknown, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-todo-${Date.now()}`,
		toolName: "todo",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return makeToolResult(details, text);
}

export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map((message) => ({ type: "message", message }) as unknown as SessionEntry);
}

const SKIP_DIRS = new Set(["node_modules", "docs"]);
const SKIP_FILES = new Set(["test-fixtures.ts"]);

export interface ShipManifestResult {
	declared: readonly string[];
	onDisk: readonly string[];
	missing: readonly string[];
	stale: readonly string[];
}

export function verifyShipManifest(packageDirOrUrl: string): ShipManifestResult {
	const packageDir = packageDirOrUrl.startsWith("file:")
		? dirname(fileURLToPath(packageDirOrUrl))
		: packageDirOrUrl;
	const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
		files?: string[];
	};
	const declared = manifest.files ?? [];
	const exactFiles = new Set<string>();
	const directoryPrefixes: string[] = [];
	for (const entry of declared) {
		if (entry.endsWith("/")) directoryPrefixes.push(entry);
		else if (isDirectory(packageDir, entry)) directoryPrefixes.push(`${entry}/`);
		else exactFiles.add(entry);
	}
	const onDisk = walkProductionTypescript(packageDir, packageDir);
	const missing = onDisk.filter(
		(file) =>
			!exactFiles.has(file) &&
			!directoryPrefixes.some((prefix) => file.startsWith(prefix)),
	);
	const stale = declared.filter((entry) => !existsSync(resolve(packageDir, entry)));
	return { declared, onDisk, missing, stale };
}

function isDirectory(packageDir: string, entry: string): boolean {
	try {
		return statSync(resolve(packageDir, entry)).isDirectory();
	} catch {
		return false;
	}
}

function walkProductionTypescript(root: string, directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const absolutePath = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkProductionTypescript(root, absolutePath));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (entry.name.endsWith(".test.ts") || SKIP_FILES.has(entry.name)) continue;
		files.push(relative(root, absolutePath));
	}
	return files;
}
