import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ToolRenderContextLike {
	toolCallId?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
}

const liveToolCallIds = new Set<string>();

function toolCallIdFromEvent(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
	return typeof toolCallId === "string" && toolCallId ? toolCallId : undefined;
}

export function registerLiveToolCallEvents(pi: ExtensionAPI): void {
	liveToolCallIds.clear();
	pi.on("session_start", async () => liveToolCallIds.clear());
	pi.on("tool_execution_start", async (event) => {
		const toolCallId = toolCallIdFromEvent(event);
		if (toolCallId) liveToolCallIds.add(toolCallId);
	});
	pi.on("tool_execution_end", async (event) => {
		const toolCallId = toolCallIdFromEvent(event);
		if (toolCallId) liveToolCallIds.delete(toolCallId);
	});
}

export function clearLiveToolCalls(): void {
	liveToolCallIds.clear();
}

export function shouldShowDeterministicFallback(context?: ToolRenderContextLike): boolean {
	if (!context) return true;
	if (context.toolCallId && liveToolCallIds.has(context.toolCallId)) return true;
	if (context.executionStarted === false) return false;
	if (context.argsComplete === true) return false;
	return true;
}
