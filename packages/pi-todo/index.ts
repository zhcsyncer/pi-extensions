/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todo` visual
 * settings command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveTodoVisualConfig, saveTodoVisualConfig } from "./config.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { TODO_STATE_CUSTOM_TYPE, replayFromBranch } from "./state/replay.js";
import { formatCurrentTodoState, formatCurrentTodoStateUpdate } from "./state/selectors.js";
import { resetTaskState } from "./state/state.js";
import { createTodoStore } from "./state/store.js";
import { registerTodoCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { ResetDetailsV2 } from "./tool/types.js";
import { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// Every extension runtime owns an isolated store. This matters for SDK hosts
	// that keep multiple AgentSession instances alive in one Node.js process.
	const store = createTodoStore();
	const loadedConfig = loadConfig();
	let visualConfig = resolveTodoVisualConfig(loadedConfig);
	let todoOverlay: TodoOverlay | undefined;
	let agentRunStarted = false;
	let runStartTodoSummary: string | undefined;

	registerTodoTool(pi, store, loadedConfig);
	registerTodoCommand(pi, {
		getConfig: () => visualConfig,
		updateConfig: (next) => {
			saveTodoVisualConfig(next);
			visualConfig = next;
			todoOverlay?.setConfig(next);
		},
		getState: () => store.getState(),
		resetTodos: () => {
			const state = resetTaskState(store.getState());
			const checkpoint: ResetDetailsV2 = {
				schemaVersion: 2,
				kind: "checkpoint",
				action: "reset",
				state,
			};
			// Persist first: if the session write fails, live state and widget remain intact.
			pi.appendEntry(TODO_STATE_CUSTOM_TYPE, checkpoint);
			store.commitState(state);
			todoOverlay?.resetCompletedDisplayState();
			todoOverlay?.update();
			return state;
		},
	});

	pi.on("before_agent_start", async (event) => {
		agentRunStarted = true;
		runStartTodoSummary = formatCurrentTodoState(store.getState());
		if (!runStartTodoSummary) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${runStartTodoSummary}` };
	});

	// Pi 0.84 keeps one system-prompt override across overflow compact/retry.
	// If Todo mutates later in that same run, append an ephemeral exact update
	// to each subsequent model context; this is not persisted to session JSONL.
	pi.on("context", async (event) => {
		if (!agentRunStarted) return;
		const current = formatCurrentTodoState(store.getState());
		if (current === runStartTodoSummary) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "pi-todo-current-state",
					content: formatCurrentTodoStateUpdate(store.getState()),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("agent_settled", async () => {
		agentRunStarted = false;
		runStartTodoSummary = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		store.replaceState(replayFromBranch(ctx));
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay(store, visualConfig);
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			todoOverlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		try {
			store.replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			store.replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_shutdown", async () => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
	});

	// The overlay reads its runtime store at render time; do NOT replay here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});
}
