export const HERDR_BLOCKED_EVENT = "herdr:blocked";
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

export interface BlockedSignal {
	active: boolean;
	label?: string;
}

export type BlockedEmitter = (signal: BlockedSignal) => void;

/** Per-adapter nested depth; unmatched clears are ignored and force-clear stays balanced. */
export class BlockedDepthTracker {
	private depth = 0;

	constructor(
		readonly label: string,
		private readonly emit: BlockedEmitter,
	) {}

	get activeDepth(): number {
		return this.depth;
	}

	update(active: boolean): void {
		if (active) {
			this.depth += 1;
			this.emit({ active: true, label: this.label });
			return;
		}
		if (this.depth === 0) return;
		this.depth -= 1;
		this.emit({ active: false });
	}

	clear(): void {
		while (this.depth > 0) this.update(false);
	}
}
