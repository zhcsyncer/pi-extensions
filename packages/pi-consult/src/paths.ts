import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const CONSULT_EXTENSION_ID = "pi-consult";

export interface ConsultPaths {
	dataDir: string;
	configFile: string;
	eventsFile: string;
}

export function getConsultPaths(agentDir = getAgentDir()): ConsultPaths {
	const dataDir = join(agentDir, "extension-data", CONSULT_EXTENSION_ID);
	return {
		dataDir,
		configFile: join(dataDir, "config.json"),
		eventsFile: join(dataDir, "events.jsonl"),
	};
}

export function sessionIdFrom(file: string | null | undefined): string {
	if (!file) return "ephemeral";
	const base = file.split(/[/\\]/).pop() ?? file;
	return base.replace(/\.jsonl?$/, "") || "ephemeral";
}
