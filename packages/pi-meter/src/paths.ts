import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const METER_EXTENSION_ID = "pi-meter";

export interface MeterPaths {
	dataDir: string;
	configFile: string;
	quotaFile: string;
	usageFile: string;
	budgetsFile: string;
	warnedFile: string;
	footerFile: string;
	legacyAnalyticsDir: string;
	legacyUsageFile: string;
	legacyBudgetsFile: string;
	legacyWarnedFile: string;
	legacyFooterFile: string;
}

export function getMeterPaths(agentDir = getAgentDir()): MeterPaths {
	const dataDir = join(agentDir, "extension-data", METER_EXTENSION_ID);
	const legacyAnalyticsDir = join(agentDir, "analytics");
	return {
		dataDir,
		configFile: join(dataDir, "config.json"),
		quotaFile: join(dataDir, "quota.json"),
		usageFile: join(dataDir, "usage.jsonl"),
		budgetsFile: join(dataDir, "budgets.json"),
		warnedFile: join(dataDir, "warned.jsonl"),
		footerFile: join(dataDir, "footer.json"),
		legacyAnalyticsDir,
		legacyUsageFile: join(legacyAnalyticsDir, "usage.jsonl"),
		legacyBudgetsFile: join(legacyAnalyticsDir, "budgets.json"),
		legacyWarnedFile: join(legacyAnalyticsDir, "warned.jsonl"),
		legacyFooterFile: join(legacyAnalyticsDir, "footer.json"),
	};
}
