import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type NoticeSink = (message: string) => void;

/** Single-line, bounded diagnostics; never render arbitrary terminal control bytes. */
export function sanitizeDiagnosticText(text: string, maxLength = 300): string {
	return stripVTControlCharacters(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		// Remove complete labeled values first. Matching "token" inside a value
		// before this step could consume the next secret's label across whitespace.
		.replace(/\b(x-api-key|api[-_]?key|bearer|token|authorization|secret|password)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:(?:bearer|token|basic)\s+)?[^\s,;}\]]+)/gi, "$1=[redacted]")
		.replace(/(^|[\s:(])(bearer|token)[ \t]+[^\s,;}\]]+/gi, "$1$2 [redacted]")
		.slice(0, maxLength);
}

/** An extension/session owns UI deduplication; each call owns its result diagnostics. */
export function createDiagnosticReporter() {
	const notified = new Set<string>();
	const pending = new Set<string>();
	const remember = (set: Set<string>, message: string) => {
		if (set.size >= 256) set.delete(set.values().next().value!);
		set.add(message);
	};
	return {
		reset() { notified.clear(); pending.clear(); },
		sink(ctx: Pick<ExtensionContext, "hasUI" | "ui">, warnings?: string[]): NoticeSink {
			const report: NoticeSink = (message) => {
				const safe = sanitizeDiagnosticText(message, 500);
				if (!safe) return;
				if (warnings && !warnings.includes(safe) && warnings.length < 32) warnings.push(safe);
				if (ctx.hasUI === false) {
					if (!warnings) remember(pending, safe);
					return;
				}
				if (notified.has(safe)) return;
				try {
					ctx.ui.notify(safe, "warning");
					remember(notified, safe);
				} catch {
					// A disposed UI must not turn a successful provider request into failure.
					if (!warnings) remember(pending, safe);
				}
			};
			if (warnings || ctx.hasUI !== false) {
				const queued = [...pending];
				pending.clear();
				for (const message of queued) report(message);
			}
			return report;
		},
	};
}
