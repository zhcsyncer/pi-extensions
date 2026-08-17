import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { INPUT_STASH_STATUS_KEY } from "./input-stash.js";

export interface StatusOnlyFooterOptions {
	theme: Theme;
	footerData: ReadonlyFooterDataProvider;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export function renderExtensionStatusLine(statuses: ReadonlyMap<string, string>, width: number, theme: Theme): string | undefined {
	if (width <= 0 || statuses.size === 0) return undefined;
	const parts = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([key, status]) => {
			const sanitized = sanitizeStatusText(status);
			if (!sanitized) return [];
			return [key === INPUT_STASH_STATUS_KEY ? theme.fg("warning", sanitized) : sanitized];
		});
	const text = parts.join(" ");
	return text ? truncateToWidth(text, width, theme.fg("dim", "...")) : undefined;
}

export class StatusOnlyFooter implements Component {
	constructor(private readonly options: StatusOnlyFooterOptions) {}

	dispose(): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const extensionStatus = renderExtensionStatusLine(
			this.options.footerData.getExtensionStatuses(),
			width,
			this.options.theme,
		);
		return extensionStatus ? [extensionStatus] : [];
	}
}
