import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrExecutor } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import { cleanupCurrentWorktree } from "./cleanup.ts";
import { HERDR_WORKTREE_USAGE, parseHerdrWorktreeCommand } from "./router.ts";
import { createStartController, registerStartRenderers, type DistillCompleter, type StartClient } from "./start.ts";

const COMPLETIONS = [
	{
		value: "start",
		label: "start",
		description: "Distill a plan, then create a linked worktree and start Pi",
	},
	{
		value: "cleanup",
		label: "cleanup",
		description: "Remove this linked worktree and delete the local branch",
	},
	{
		value: "cleanup --keep-branch",
		label: "cleanup --keep-branch",
		description: "Remove this linked worktree and keep the local branch",
	},
];

export function registerHerdrWorktreeCommand(
	pi: ExtensionAPI,
	options: {
		runtime: RuntimeSnapshot;
		client: StartClient;
		exec: HerdrExecutor;
		completeModel?: DistillCompleter;
	},
): void {
	registerStartRenderers(pi);
	const start = createStartController(pi, options);

	pi.registerCommand("herdr-worktree", {
		description: "start [branch] | cleanup [--keep-branch] — Dispatch or remove a linked Herdr worktree",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.trim().toLowerCase();
			return COMPLETIONS.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const route = parseHerdrWorktreeCommand(args);
			if (route.kind === "usage") {
				ctx.ui.notify(HERDR_WORKTREE_USAGE, "info");
				return;
			}
			if (route.kind === "start") {
				await start.beginDistill(route.branch, ctx);
				return;
			}
			try {
				const result = await cleanupCurrentWorktree({
					client: options.client,
					exec: options.exec,
					runtime: options.runtime,
					keepBranch: route.keepBranch,
					ui: ctx.ui,
				});
				if (result.status === "rejected") {
					ctx.ui.notify(result.message, "error");
					return;
				}
				if (result.status === "cancelled") {
					ctx.ui.notify("Worktree cleanup cancelled.", "info");
				}
			} catch (error) {
				ctx.ui.notify(
					`/herdr-worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
