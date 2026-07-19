import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, validateGuidanceFields } from "@juicesharp/rpiv-config";

const CONFIG_PATH = configPath("rpiv-todo");

interface TodoConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export { validateGuidanceFields };
