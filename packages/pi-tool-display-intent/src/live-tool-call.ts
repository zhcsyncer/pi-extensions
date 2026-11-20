import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ToolRenderContextLike {
	toolCallId?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
}

const liveToolCallIds = new Map<string, Set<symbol>>();

function toolCallIdFromEvent(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
	return typeof toolCallId === "string" && toolCallId ? toolCallId : undefined;
}

export function registerLiveToolCallEvents(pi: ExtensionAPI): () => void {
	const owner = Symbol();
	const owned = new Set<string>();
	const release = (id: string) => {
		const owners = liveToolCallIds.get(id);
		owners?.delete(owner);
		if (owners?.size === 0) liveToolCallIds.delete(id);
		owned.delete(id);
	};
	const clear = () => { for (const id of owned) release(id); };
	pi.on("session_start", clear);
	pi.on("tool_execution_start", (event) => {
		const id = toolCallIdFromEvent(event);
		if (!id) return;
		const owners = liveToolCallIds.get(id) ?? new Set<symbol>();
		owners.add(owner);
		liveToolCallIds.set(id, owners);
		owned.add(id);
	});
	pi.on("tool_execution_end", (event) => {
		const id = toolCallIdFromEvent(event);
		if (id) release(id);
	});
	return clear;
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
