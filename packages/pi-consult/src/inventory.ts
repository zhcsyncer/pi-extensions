/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Stable tool-inventory Message for prompt-cache parity: key-sorted JSON and a
 * name-signature cache on globalThis so /new, /fork, and /resume do not bust it.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

const CONSULT_STATE_KEY = Symbol.for("zhcsyncer-pi-consult");

interface ConsultInventoryState {
	inventorySignature?: string;
	inventoryMessage?: Message;
}

function getInventoryState(): ConsultInventoryState {
	const globalState = globalThis as unknown as { [k: symbol]: ConsultInventoryState | undefined };
	let state = globalState[CONSULT_STATE_KEY];
	if (!state) {
		state = {};
		globalState[CONSULT_STATE_KEY] = state;
	}
	return state;
}

export function __resetInventoryCache(): void {
	const globalState = globalThis as unknown as { [k: symbol]: ConsultInventoryState | undefined };
	delete globalState[CONSULT_STATE_KEY];
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => (entry === undefined ? "null" : stableStringify(entry))).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const entries: string[] = [];
	for (const key of Object.keys(obj).sort()) {
		const entry = obj[key];
		if (entry === undefined) continue;
		entries.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
	}
	return `{${entries.join(",")}}`;
}

function buildInventoryBlock(tools: ToolInfo[]): string {
	return tools
		.map((tool) => `### ${tool.name}\n${tool.description}\n\nParameters: ${stableStringify(tool.parameters)}`)
		.join("\n\n---\n\n");
}

export function getInventoryMessage(tools: ToolInfo[]): Message | undefined {
	if (tools.length === 0) return undefined;
	const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const signature = sorted.map((tool) => tool.name).join("|");
	const state = getInventoryState();
	if (state.inventorySignature === signature && state.inventoryMessage) {
		return state.inventoryMessage;
	}
	const text = `## Available Executor Tools\n\n${buildInventoryBlock(sorted)}`;
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	state.inventorySignature = signature;
	state.inventoryMessage = message;
	return message;
}
