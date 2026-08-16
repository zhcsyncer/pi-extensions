export function fmtNum(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function fmtCost(n: number): string {
	if (!Number.isFinite(n)) return "n/a";
	return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtCompactTokens(n: number): string {
	if (!Number.isFinite(n)) return "n/a";
	const sign = n < 0 ? "-" : "";
	const abs = Math.abs(n);
	if (abs < 1000) return `${sign}${Math.round(abs)}`;
	if (abs >= 1_000_000_000) return `${sign}${formatScaled(abs / 1_000_000_000, 2, "B")}`;
	if (abs >= 1_000_000) {
		const million = formatScaled(abs / 1_000_000, 2, "M");
		return million === "1000M" ? `${sign}1B` : `${sign}${million}`;
	}
	const thousand = formatScaled(abs / 1000, 1, "k");
	return thousand === "1000k" ? `${sign}1M` : `${sign}${thousand}`;
}

export function fmtCompactCost(n: number): string | undefined {
	if (!Number.isFinite(n)) return undefined;
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtBar(ratio: number, width: number): string {
	const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function formatScaled(value: number, decimals: number, suffix: string): string {
	const rounded = Number(value.toFixed(decimals));
	return `${rounded}${suffix}`;
}

export function padRight(str: string, width: number, visible = (value: string) => [...value.replace(/\x1b\[[0-9;]*m/g, "")].length): string {
	const current = visible(str);
	if (current >= width) return str;
	return str + " ".repeat(width - current);
}
