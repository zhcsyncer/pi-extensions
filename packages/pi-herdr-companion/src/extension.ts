import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserBlockedAdapter } from "./blocked/ask-user.ts";
import { CompanionConfigStore, DEFAULT_CONFIG, type CompanionConfig } from "./config.ts";
import { registerBtwChild } from "./btw/child.ts";
import { BtwContextStore, defaultBtwStateRoot } from "./btw/context-store.ts";
import { BtwLauncher } from "./btw/launch.ts";
import { registerBtwParent } from "./btw/parent.ts";
import { BTW_PAYLOAD_ENV } from "./btw/types.ts";
import { HerdrClient } from "./herdr-client.ts";
import { ProcessManager } from "./process/manager.ts";
import { restoreProcessRegistry, PROCESS_STATE_CUSTOM_TYPE } from "./process/registry.ts";
import { registerHerdrProcessTool } from "./process/tool.ts";
import {
	appendRuntimePrompt,
	buildRuntimePrompt,
	captureRuntimeSnapshot,
	hasUsableHerdrRuntime,
} from "./runtime.ts";

function cloneDefaults(): CompanionConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CompanionConfig;
}

export default async function herdrCompanionExtension(pi: ExtensionAPI): Promise<void> {
	// These caller facts are intentionally captured exactly once per extension instance.
	const runtime = captureRuntimeSnapshot(process.env);
	const runtimePrompt = buildRuntimePrompt(runtime);
	const configStore = new CompanionConfigStore();
	let config = cloneDefaults();

	const client = new HerdrClient((command, args, options) => pi.exec(command, args, options));
	const btwStore = new BtwContextStore(defaultBtwStateRoot(runtime));
	const btwLauncher = new BtwLauncher(client, btwStore);

	pi.on("session_start", async (_event, ctx) => {
		try {
			config = await configStore.load();
		} catch (error) {
			config = cloneDefaults();
			ctx.ui.notify(
				`Invalid Herdr companion config at ${configStore.path}; defaults are active: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!config.runtime.injectSystemPrompt) return;
		return { systemPrompt: appendRuntimePrompt(event.systemPrompt, runtimePrompt) };
	});

	registerAskUserBlockedAdapter(pi, runtime, () => config);

	if (hasUsableHerdrRuntime(runtime)) {
		const processManager = new ProcessManager({
			client,
			runtime,
			getConfig: () => config,
			persist: (snapshot) => pi.appendEntry(PROCESS_STATE_CUSTOM_TYPE, snapshot),
		});
		registerHerdrProcessTool(pi, processManager);

		pi.on("session_start", async (event, ctx) => {
			try {
				await processManager.rehydrate(restoreProcessRegistry(ctx.sessionManager.getBranch()), event.reason);
			} catch (error) {
				ctx.ui.notify(`Could not reconcile Herdr process ownership: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		});
		pi.on("session_tree", async (_event, ctx) => {
			try {
				await processManager.rebindTree(
					restoreProcessRegistry(ctx.sessionManager.getBranch()),
					ctx.sessionManager.getSessionId(),
				);
			} catch (error) {
				ctx.ui.notify(`Could not reconcile Herdr process ownership after tree navigation: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		});
		pi.on("session_shutdown", async (event) => {
			await processManager.shutdown(event.reason);
		});
	}

	const childPayloadPath = process.env[BTW_PAYLOAD_ENV]?.trim();
	if (childPayloadPath) {
		await registerBtwChild(pi, { store: btwStore, client, payloadPath: childPayloadPath, runtime });
		return;
	}

	registerBtwParent(pi, {
		runtime,
		store: btwStore,
		launcher: btwLauncher,
		config: {
			path: configStore.path,
			get: () => config,
			async save(next) {
				config = await configStore.save(next);
				return config;
			},
			async reset() {
				config = await configStore.reset();
				return config;
			},
		},
	});
}
