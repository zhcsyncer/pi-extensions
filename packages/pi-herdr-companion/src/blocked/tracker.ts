export const HERDR_BLOCKED_EVENT = "herdr:blocked";

export interface BlockedSignal {
	active: boolean;
	label?: string;
}

export type BlockedEmitter = (signal: BlockedSignal) => void;

/** Per-source nested depth; unmatched clears are ignored and force-clear stays balanced. */
export class BlockedDepthTracker {
	private depth = 0;
	private currentLabel: string;

	constructor(
		label: string,
		private readonly emit: BlockedEmitter,
	) {
		this.currentLabel = label;
	}

	get activeDepth(): number {
		return this.depth;
	}

	get label(): string {
		return this.currentLabel;
	}

	/** Preserve active depth while atomically rebroadcasting it under a new label. */
	relabel(label: string): void {
		if (label === this.currentLabel) return;
		const activeDepth = this.depth;
		this.clear();
		this.currentLabel = label;
		for (let index = 0; index < activeDepth; index += 1) this.update(true);
	}

	update(active: boolean): void {
		if (active) {
			this.depth += 1;
			this.emit({ active: true, label: this.currentLabel });
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
