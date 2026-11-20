interface DisplayTheme {
	fg(color: string, text: string): string;
	getFgAnsi?(color: string): string;
	getColorMode?(): string;
	appearance?: string;
}

/** Pi's theme proxy keeps its identity; only the affected public color signals are relevant. */
export function displayThemeSignature(theme: DisplayTheme | undefined, tokens: readonly string[]): string {
	if (!theme) return "";
	return [theme.appearance, theme.getColorMode?.(), ...tokens.map(token =>
		// Compatibility themes may suppress empty strings, so use a fixed nonempty probe.
		(theme.getFgAnsi ? theme.getFgAnsi(token) : theme.fg(token, "x")).slice(0, 4096),
	)].join("\u0000");
}
