/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Tail-compatibility helpers: strip the in-flight consult() toolCall (providers
 * reject orphan toolCalls) and guarantee a user-role tail (some providers reject
 * assistant prefill). Consult adds a why-bearing user tail on top of that.
 */

import type { Message } from "@earendil-works/pi-ai";
import { CONSULT_TOOL_NAME, MSG_CONSULT_NUDGE } from "./messages.ts";

export function stripInflightConsultCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter((c) => !(c.type === "toolCall" && c.name === CONSULT_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

export function ensureUserTailForConsult(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const nudge: Message = {
		role: "user",
		content: [{ type: "text", text: MSG_CONSULT_NUDGE }],
		timestamp: Date.now(),
	};
	return [...messages, nudge];
}

export function appendWhyToLastUser(messages: Message[], why: string): Message[] {
	const whyBlock = `${MSG_CONSULT_NUDGE}\n\nWhy the executor is asking now: ${why}`;
	if (messages.length === 0) {
		return [{ role: "user", content: [{ type: "text", text: whyBlock }], timestamp: Date.now() }];
	}
	const last = messages[messages.length - 1];
	if (last.role === "user") {
		const existing = (typeof last.content === "string"
			? last.content
			: last.content
				.filter((part): part is Extract<(typeof last.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n")).trim();
		const text = existing && existing !== MSG_CONSULT_NUDGE ? `${existing}\n\n${whyBlock}` : whyBlock;
		return [...messages.slice(0, -1), { ...last, content: [{ type: "text", text }] }];
	}
	return [...messages, { role: "user", content: [{ type: "text", text: whyBlock }], timestamp: Date.now() }];
}

export function prepareConsultMessages(messages: Message[], why: string): Message[] {
	return appendWhyToLastUser(ensureUserTailForConsult(stripInflightConsultCall(messages)), why);
}
