import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import * as activity from "../../src/aggregate-activity.ts";
import * as thinking from "../../src/aggregate-thinking-placeholder.ts";
import * as viewport from "../../src/aggregate-viewport.ts";

export const modules = { Tui, activity, thinking, viewport };

/** Export through the real loader's event bus, without a process-global test registry. */
export default function aggregateReloadEntry(pi: ExtensionAPI): void {
	pi.events.emit("aggregate-reload-test:modules", modules);
}
