import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveLibraryIdTool } from "../lib/tools/resolve-library-id.ts";
import { queryDocsTool } from "../lib/tools/query-docs.ts";

function context7(pi: ExtensionAPI): void {
  pi.registerTool(resolveLibraryIdTool);
  pi.registerTool(queryDocsTool);
}

export default context7;
