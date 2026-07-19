import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export function writeGuidanceTree(projectDir: string, spec: Record<string, string>): void {
	for (const [relPath, content] of Object.entries(spec)) {
		const abs = join(projectDir, relPath.split("/").join(sep));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}
}
