import { collectGitSnapshot } from "../git.js";
import type { GitConfig } from "../types.js";

const config: GitConfig = {
	showDirty: true,
	showAheadBehind: true,
	shaMode: "off",
	timeoutMs: 1000,
	refreshDebounceMs: 0,
	pollIntervalMs: 5000,
};

const cwd = process.argv[2] || process.cwd();
const snapshot = await collectGitSnapshot(cwd, config);
console.log(JSON.stringify({ cwd, ...snapshot }, null, 2));
