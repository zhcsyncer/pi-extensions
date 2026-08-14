import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumeGlanceConfigNotices, loadConfig, loadConfigSync, saveConfig } from "./config.js";
import { showGlancePane } from "./pane.js";
import { createGlanceRuntime } from "./runtime.js";

export default function piGlance(pi: ExtensionAPI): void {
	const runtime = createGlanceRuntime({
		getThinkingLevel: () => pi.getThinkingLevel(),
		loadConfigSync,
		loadConfig,
		saveConfig,
		consumeConfigNotices: consumeGlanceConfigNotices,
		showPane: showGlancePane,
	});

	pi.registerCommand("glance", {
		description: "Open pi-glance configuration pane",
		handler: runtime.commands.openPane,
	});

	pi.registerCommand("diff", {
		description: "Review the current Git working tree with revdiff",
		handler: runtime.commands.openDiff,
	});

	pi.on("session_start", runtime.events.sessionStart);
	pi.on("session_shutdown", runtime.events.sessionShutdown);
	pi.on("session_info_changed", runtime.events.sessionInfoChanged);
	pi.on("model_select", runtime.events.modelSelect);
	pi.on("thinking_level_select", runtime.events.thinkingLevelSelect);
	pi.on("turn_start", runtime.events.turnStart);
	pi.on("message_update", runtime.events.messageUpdate);
	pi.on("tool_execution_start", runtime.events.toolExecutionStart);
	pi.on("tool_execution_end", runtime.events.toolExecutionEnd);
	pi.on("session_tree", runtime.events.sessionTree);
	pi.on("session_compact", runtime.events.sessionCompact);
	pi.on("message_end", runtime.events.messageEnd);
	pi.on("turn_end", runtime.events.turnEnd);
	pi.on("agent_start", runtime.events.agentStart);
	pi.on("agent_end", runtime.events.agentEnd);
	pi.on("agent_settled", runtime.events.agentSettled);
}
