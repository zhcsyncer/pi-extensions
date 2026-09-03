/*
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Tail-compatibility helpers: remove the current in-flight consult() call,
 * then guarantee a user-role tail. Consult adds a why-bearing user tail
 * without dropping user images. Guidance requires consult to run alone.
 */

import type { Message } from "@earendil-works/pi-ai";
import { CONSULT_TOOL_NAME, MSG_CONSULT_NUDGE } from "./messages.ts";

export function stripInflightConsultCall(messages: Message[], currentToolCallId?: string): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;
	const filtered = last.content.filter(
		(part) =>
			!(part.type === "toolCall" && (currentToolCallId ? part.id === currentToolCallId : part.name === CONSULT_TOOL_NAME)),
	);
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

export function ensureUserTailForConsult(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant" && last.role !== "toolResult") return messages;
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
		const content = typeof last.content === "string"
			? [{ type: "text" as const, text: last.content }]
			: [...last.content];
		const withoutStandaloneNudge = content.filter(
			(part) => !(part.type === "text" && part.text.trim() === MSG_CONSULT_NUDGE),
		);
		return [
			...messages.slice(0, -1),
			{ ...last, content: [...withoutStandaloneNudge, { type: "text", text: whyBlock }] },
		];
	}
	return [...messages, { role: "user", content: [{ type: "text", text: whyBlock }], timestamp: Date.now() }];
}

export function prepareConsultMessages(messages: Message[], why: string, currentToolCallId?: string): Message[] {
	return appendWhyToLastUser(ensureUserTailForConsult(stripInflightConsultCall(messages, currentToolCallId)), why);
}
