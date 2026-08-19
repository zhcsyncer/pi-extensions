import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { registerBlockedAdapters } from "./blocked/adapter.ts";
import {
	CompanionConfigStore,
	cloneCompanionConfig,
	type CompanionConfig,
} from "./config.ts";
import {
	openCompanionConfigUi,
	type CompanionConfigController,
} from "./config-ui.ts";
import { registerBtwChild } from "./btw/child.ts";
import { BtwContextStore, defaultBtwStateRoot } from "./btw/context-store.ts";
import { BtwLauncher } from "./btw/launch.ts";
import { registerBtwParent } from "./btw/parent.ts";
import { BTW_PAYLOAD_ENV } from "./btw/types.ts";
import { HerdrClient } from "./herdr-client.ts";
import { ProcessManager } from "./process/manager.ts";
import { registerHerdrWorktreeCommand } from "./worktree/command.ts";
import { restoreProcessRegistry, PROCESS_STATE_CUSTOM_TYPE } from "./process/registry.ts";
import { registerHerdrProcessTool } from "./process/tool.ts";
import { ProcessWidgetController } from "./process/ui.ts";
import {
	appendRuntimePrompt,
	buildRuntimePrompt,
	captureRuntimeSnapshot,
	hasUsableHerdrRuntime,
} from "./runtime.ts";

export default async function herdrCompanionExtension(pi: ExtensionAPI): Promise<void> {
	// These caller facts are intentionally captured exactly once per extension instance.
	const runtime = captureRuntimeSnapshot(process.env);
	// Outside Herdr, or with an incomplete caller identity, this extension is a
	// strict no-op: no handlers, commands, tools, config reads, or prompt content.
	if (!hasUsableHerdrRuntime(runtime)) return;

	const coreRuntimePrompt = buildRuntimePrompt(runtime);
	const tuiRuntimePrompt = buildRuntimePrompt(runtime, { includeTuiFeatures: true });
	const configStore = new CompanionConfigStore();
	const client = new HerdrClient((command, args, options) => pi.exec(command, args, options));
	const childPayloadPath = process.env[BTW_PAYLOAD_ENV]?.trim();
	let config = cloneCompanionConfig();
	let coreActivation: Promise<void> | undefined;
	let tuiActivation: Promise<void> | undefined;
	let blockedAdapters: ReturnType<typeof registerBlockedAdapters> | undefined;
	let processManager: ProcessManager | undefined;
	let processWidget: ProcessWidgetController | undefined;

	const configController: CompanionConfigController = {
		path: configStore.path,
		get: () => config,
		async save(next) {
			config = await configStore.save(next);
			blockedAdapters?.sync();
			return config;
		},
		async reset() {
			config = await configStore.reset();
			blockedAdapters?.sync();
			return config;
		},
	};

	async function activateCore(initialEvent: SessionStartEvent, initialCtx: ExtensionContext): Promise<void> {
		pi.on("before_agent_start", (event, ctx) => {
			if (!config.runtime.injectSystemPrompt) return;
			// A BTW child gets its merge semantics from SIDE_PANE_INSTRUCTIONS. Its
			// current-session block must not advertise the parent-only launch action;
			// native replay may still retain the parent's cache prefix, whose wording
			// is deliberately session-neutral.
			const runtimePrompt = ctx.mode === "tui" && !childPayloadPath
				? tuiRuntimePrompt
				: coreRuntimePrompt;
			return { systemPrompt: appendRuntimePrompt(event.systemPrompt, runtimePrompt) };
		});

		blockedAdapters = registerBlockedAdapters(pi, runtime, () => config);
		blockedAdapters.startSession(initialCtx);

		const manager = new ProcessManager({
			client,
			runtime,
			getConfig: () => config,
			persist: (snapshot) => pi.appendEntry(PROCESS_STATE_CUSTOM_TYPE, snapshot),
		});
		processManager = manager;
		registerHerdrProcessTool(pi, manager);
		// worker.ts stays in-tree, but herdr_worker is not registered: its
		// prompt/report contract leaks into Agent/subagent context.

		let processSessionContext: ExtensionContext | undefined;
		const startProcessSession = async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			if (processSessionContext === ctx) return;
			processSessionContext = ctx;
			try {
				await manager.rehydrate(restoreProcessRegistry(ctx.sessionManager.getBranch()), event.reason);
			} catch (error) {
				ctx.ui.notify(`Could not reconcile Herdr process ownership: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		};
		pi.on("session_start", startProcessSession);
		pi.on("session_tree", async (_event, ctx) => {
			try {
				await manager.rebindTree(
					restoreProcessRegistry(ctx.sessionManager.getBranch()),
					ctx.sessionManager.getSessionId(),
				);
			} catch (error) {
				ctx.ui.notify(`Could not reconcile Herdr process ownership after tree navigation: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		});
		pi.on("session_shutdown", async (event) => {
			processSessionContext = undefined;
			await manager.shutdown(event.reason);
		});
		await startProcessSession(initialEvent, initialCtx);
	}

	async function activateTui(initialEvent: SessionStartEvent, initialCtx: ExtensionContext): Promise<void> {
		if (!processManager) throw new Error("Herdr process manager was not initialized");
		processWidget = new ProcessWidgetController(processManager);
		processWidget.setUICtx(initialCtx.ui);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode === "tui") processWidget?.setUICtx(ctx.ui);
		});
		pi.on("session_shutdown", () => processWidget?.dispose());

		pi.registerCommand("herdr-config", {
			description: "Configure Herdr Companion",
			handler: async (args, ctx) => {
				if (args.trim() === "reset") {
					config = await configController.reset();
					ctx.ui.notify(`Herdr Companion settings reset.\n${configController.path}`, "info");
					return;
				}
				if (args.trim()) {
					ctx.ui.notify("Usage: /herdr-config [reset]", "error");
					return;
				}
				await openCompanionConfigUi(ctx, configController);
			},
		});
		registerHerdrWorktreeCommand(pi, {
			runtime,
			client,
			exec: (command, args, execOptions) => pi.exec(command, args, execOptions),
		});

		const btwStore = new BtwContextStore(defaultBtwStateRoot(runtime));
		const btwLauncher = new BtwLauncher(client, btwStore);
		if (childPayloadPath) {
			const child = await registerBtwChild(pi, { store: btwStore, client, payloadPath: childPayloadPath, runtime });
			await child.startSession(initialEvent, initialCtx);
			return;
		}

		const parent = registerBtwParent(pi, {
			runtime,
			store: btwStore,
			launcher: btwLauncher,
			getDirection: () => config.process.defaultDirection,
		});
		await parent.startSession(initialCtx);
	}

	// Core Herdr capabilities are mode-agnostic. Only slash-command/TUI features
	// are delayed further until an interactive TUI session is present.
	pi.on("session_start", async (event, ctx) => {
		try {
			config = await configStore.load();
		} catch (error) {
			config = cloneCompanionConfig();
			ctx.ui.notify(
				`Could not load Herdr Companion config; defaults are active: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		coreActivation ??= activateCore(event, ctx);
		await coreActivation;
		if (ctx.mode === "tui") {
			tuiActivation ??= activateTui(event, ctx);
			await tuiActivation;
		}
	});
}
