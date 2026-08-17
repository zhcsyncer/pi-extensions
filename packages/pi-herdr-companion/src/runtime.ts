export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface RuntimeSnapshot {
	inside: boolean;
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	socketPath?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Capture immutable caller facts once, when the extension module is loaded. */
export function captureRuntimeSnapshot(environment: RuntimeEnvironment = process.env): RuntimeSnapshot {
	return Object.freeze({
		inside: environment.HERDR_ENV === "1",
		paneId: nonEmpty(environment.HERDR_PANE_ID),
		tabId: nonEmpty(environment.HERDR_TAB_ID),
		workspaceId: nonEmpty(environment.HERDR_WORKSPACE_ID),
		socketPath: nonEmpty(environment.HERDR_SOCKET_PATH),
	});
}

export function hasUsableHerdrRuntime(snapshot: RuntimeSnapshot): boolean {
	return snapshot.inside && Boolean(snapshot.paneId && snapshot.socketPath);
}

export function buildRuntimePrompt(
	snapshot: RuntimeSnapshot,
	options: { includeTuiFeatures?: boolean } = {},
): string {
	// Unusable runtimes are strict no-ops: returning an empty block makes prompt
	// injection safe even if a caller forgets the extension-level activation gate.
	if (!hasUsableHerdrRuntime(snapshot)) return "";

	return [
		"## Runtime: Herdr companion",
		"inside: true",
		`pane: ${snapshot.paneId ?? "unknown"}`,
		`tab: ${snapshot.tabId ?? "unknown"}`,
		`workspace: ${snapshot.workspaceId ?? "unknown"}`,
		"For dev/preview/watch use herdr_process; do not probe HERDR_ENV or use nohup/&/disown.",
		...(options.includeTuiFeatures
			? ["/btw is session-scoped: in a parent session, /btw <question> opens an independent side thread; in a side pane, /btw merge <follow-up> requests an explicit merge back to the parent."]
			: []),
	].join("\n");
}

export function appendRuntimePrompt(systemPrompt: string, runtimePrompt: string): string {
	if (!runtimePrompt || systemPrompt.includes(runtimePrompt)) return systemPrompt;
	return systemPrompt ? `${systemPrompt}\n\n${runtimePrompt}` : runtimePrompt;
}
