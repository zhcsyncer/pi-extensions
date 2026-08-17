import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	INPUT_STASH_CONFIRM_WINDOW_MS,
	INPUT_STASH_STATUS_KEY,
	formatInputStashConfirmPrompt,
	inputHasText,
	isInputStashConfirmArmed,
	resolveInputStashAction,
	type InputStashKey,
} from "./input-stash.js";
import type { InputStashStore } from "./input-stash-store.js";

export const INPUT_STASH_DISCARD_NOTIFY = "Discarded the stashed draft.";

export interface InputStashRuntimeHost {
	nowMs(): number;
	requestRender(): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
}

function sessionFileOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		return undefined;
	}
}

function readEditorText(ctx: ExtensionContext): string {
	try {
		return ctx.ui.getEditorText() ?? "";
	} catch {
		return "";
	}
}

function writeEditorText(ctx: ExtensionContext, text: string): void {
	ctx.ui.setEditorText(text);
}

export class InputStashController {
	private confirmArmedAtMs: number | undefined;
	private confirmKind: "overwrite" | "discard" | undefined;
	private confirmTimer: unknown;
	private promptCtx: ExtensionContext | undefined;

	constructor(
		private readonly store: InputStashStore,
		private readonly host: InputStashRuntimeHost,
	) {}

	occupied(ctx: ExtensionContext): boolean {
		return this.store.has(sessionFileOf(ctx));
	}

	refresh(): void {
		this.store.refresh();
		this.disarmConfirm();
	}

	handlePrimary(ctx: ExtensionContext): void {
		this.dispatch(ctx, "primary");
	}

	handleSecondary(ctx: ExtensionContext): void {
		this.dispatch(ctx, "secondary");
	}

	restoreOnSessionStart(ctx: ExtensionContext): void {
		this.refresh();
		const current = readEditorText(ctx);
		if (inputHasText(current)) return;
		const key = sessionFileOf(ctx);
		const stored = this.store.get(key);
		if (!inputHasText(stored) || stored === undefined) return;
		writeEditorText(ctx, stored);
		this.store.clear(key);
		this.disarmConfirm();
		this.host.requestRender();
	}

	private dispatch(ctx: ExtensionContext, key: InputStashKey): void {
		const nowMs = this.host.nowMs();
		const sessionFile = sessionFileOf(ctx);
		const editorText = readEditorText(ctx);
		const stored = this.store.get(sessionFile);
		const expectedKind = key === "secondary" ? "discard" : "overwrite";
		const action = resolveInputStashAction({
			editorHasText: inputHasText(editorText),
			slotHasContent: inputHasText(stored),
			confirmArmed: this.confirmKind === expectedKind && isInputStashConfirmArmed(this.confirmArmedAtMs, nowMs),
			key,
		});

		switch (action) {
			case "stash":
				this.store.set(sessionFile, editorText);
				writeEditorText(ctx, "");
				this.disarmConfirm();
				this.host.requestRender();
				return;
			case "restore":
				if (stored === undefined) return;
				writeEditorText(ctx, stored);
				this.store.clear(sessionFile);
				this.disarmConfirm();
				this.host.requestRender();
				return;
			case "arm-confirm":
				if (!inputHasText(stored) || stored === undefined) return;
				this.armConfirm(ctx, expectedKind, stored, nowMs);
				return;
			case "overwrite":
				if (stored === undefined) return;
				writeEditorText(ctx, stored);
				this.store.clear(sessionFile);
				this.disarmConfirm();
				this.host.requestRender();
				return;
			case "discard":
				this.store.clear(sessionFile);
				this.disarmConfirm();
				ctx.ui.notify(INPUT_STASH_DISCARD_NOTIFY, "info");
				this.host.requestRender();
				return;
			case "noop":
				return;
		}
	}

	private armConfirm(ctx: ExtensionContext, kind: "overwrite" | "discard", draft: string, nowMs: number): void {
		this.clearConfirmTimer();
		this.confirmArmedAtMs = nowMs;
		this.confirmKind = kind;
		this.promptCtx = ctx;
		ctx.ui.setStatus(INPUT_STASH_STATUS_KEY, formatInputStashConfirmPrompt(kind, draft));
		this.confirmTimer = this.host.setTimeout(() => {
			if (!isInputStashConfirmArmed(this.confirmArmedAtMs, this.host.nowMs())) this.disarmConfirm();
		}, INPUT_STASH_CONFIRM_WINDOW_MS);
		this.host.requestRender();
	}

	private clearConfirmTimer(): void {
		if (this.confirmTimer === undefined) return;
		this.host.clearTimeout(this.confirmTimer);
		this.confirmTimer = undefined;
	}

	private disarmConfirm(): void {
		this.clearConfirmTimer();
		this.confirmArmedAtMs = undefined;
		this.confirmKind = undefined;
		const ctx = this.promptCtx;
		this.promptCtx = undefined;
		ctx?.ui.setStatus(INPUT_STASH_STATUS_KEY, undefined);
	}
}
