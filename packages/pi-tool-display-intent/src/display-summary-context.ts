import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripDisplaySummary } from "./display-summary.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { isRecord } from "./tool-metadata.js";

const registeredApis = new WeakSet<ExtensionAPI>();
const MAX_CONTENT_DEPTH = 16;

function sanitizeContent(
	content: unknown[],
	depth = 0,
	seen = new WeakSet<object>(),
): { content: unknown[]; changed: boolean } {
	if (depth > MAX_CONTENT_DEPTH || seen.has(content)) {
		return { content, changed: false };
	}

	seen.add(content);
	let changed = false;
	const next = content.map((block) => {
		if (Array.isArray(block)) {
			const nested = sanitizeContent(block, depth + 1, seen);
			if (nested.changed) {
				changed = true;
				return nested.content;
			}
			return block;
		}

		if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) {
			return block;
		}

		const nextArguments = stripDisplaySummary(block.arguments);
		if (nextArguments === block.arguments) {
			return block;
		}

		changed = true;
		return { ...block, arguments: nextArguments };
	});

	return { content: changed ? next : content, changed };
}

export function stripDisplaySummariesFromContextMessages(messages: unknown): unknown {
	if (!Array.isArray(messages)) {
		return messages;
	}

	let changed = false;
	const next = messages.map((message) => {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}

		const sanitized = sanitizeContent(message.content);
		if (!sanitized.changed) {
			return message;
		}

		changed = true;
		return { ...message, content: sanitized.content };
	});

	return changed ? next : messages;
}

function handleContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
	try {
		if (!isRecord(event) || !Array.isArray(event.messages)) {
			return;
		}

		const sanitized = stripDisplaySummariesFromContextMessages(event.messages);
		if (sanitized !== event.messages && Array.isArray(sanitized)) {
			event.messages.splice(0, event.messages.length, ...sanitized);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		ctx?.ui?.notify(`Tool intent context sanitization failed: ${message}`, "warning");
	}
}

export function registerDisplaySummaryContextSanitizer(pi: ExtensionAPI): void {
	if (registeredApis.has(pi)) {
		return;
	}
	registeredApis.add(pi);

	onReloadShutdown(pi, () => {
		registeredApis.delete(pi);
	});

	pi.on("context", async (event, ctx) => {
		handleContextEvent(event, ctx);
	});
}
