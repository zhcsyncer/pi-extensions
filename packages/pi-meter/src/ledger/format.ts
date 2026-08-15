export function fmtNum(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

export function fmtCost(n: number): string {
	if (!Number.isFinite(n)) return "n/a";
	return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtCompactTokens(n: number): string {
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	if (abs < 1_000_000) {
		const value = n / 1000;
		return `${trimFloat(value)}k`;
	}
	return `${trimFloat(n / 1_000_000)}M`;
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

function trimFloat(n: number): string {
	const rounded = Math.round(n * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function padRight(str: string, width: number, visible = (value: string) => [...value.replace(/\x1b\[[0-9;]*m/g, "")].length): string {
	const current = visible(str);
	if (current >= width) return str;
	return str + " ".repeat(width - current);
}
