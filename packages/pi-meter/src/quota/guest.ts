import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaSnapshot } from "./types.ts";
import { QUOTA_PROVIDERS, quotaProviderTitle } from "./types.ts";

export const QUOTA_ADAPTERS_KEY = Symbol.for("@zhcsyncer/pi-meter/quota-adapters");

export interface QuotaAdapter {
	id: string;
	title: string;
	matchProvider(modelProvider: string): boolean;
	fetch(ctx: Pick<ExtensionContext, "modelRegistry">, fetchedAt?: number): Promise<QuotaSnapshot>;
}

export interface QuotaAdapterHost {
	register(adapter: QuotaAdapter): void;
	list(): QuotaAdapter[];
	mailbox?: unknown[];
}

const adapters = new Map<string, QuotaAdapter>();

function isAdapter(value: unknown): value is QuotaAdapter {
	if (!value || typeof value !== "object") return false;
	const adapter = value as QuotaAdapter;
	return typeof adapter.id === "string"
		&& adapter.id.length > 0
		&& typeof adapter.title === "string"
		&& typeof adapter.matchProvider === "function"
		&& typeof adapter.fetch === "function";
}

function readHost(): QuotaAdapterHost | undefined {
	return (globalThis as unknown as Record<symbol, QuotaAdapterHost | undefined>)[QUOTA_ADAPTERS_KEY];
}

function writeHost(host: QuotaAdapterHost): void {
	(globalThis as unknown as Record<symbol, QuotaAdapterHost>)[QUOTA_ADAPTERS_KEY] = host;
}

export function registerQuotaAdapter(adapter: QuotaAdapter): void {
	if (!isAdapter(adapter)) return;
	adapters.set(adapter.id, adapter);
}

export function listQuotaAdapters(): QuotaAdapter[] {
	return [...adapters.values()];
}

export function getQuotaAdapter(id: string): QuotaAdapter | undefined {
	return adapters.get(id);
}

export function quotaSourceTitle(id: string): string {
	return getQuotaAdapter(id)?.title ?? quotaProviderTitle(id);
}

export function listedQuotaSourceIds(): string[] {
	const ids: string[] = [...QUOTA_PROVIDERS];
	const seen = new Set<string>(QUOTA_PROVIDERS);
	for (const adapter of adapters.values()) {
		if (seen.has(adapter.id)) continue;
		seen.add(adapter.id);
		ids.push(adapter.id);
	}
	return ids;
}

export function installQuotaAdapterHost(): void {
	const current = readHost();
	const pending = Array.isArray(current?.mailbox) ? [...current.mailbox] : [];
	writeHost({
		register: registerQuotaAdapter,
		list: listQuotaAdapters,
		mailbox: [],
	});
	for (const item of pending) {
		if (isAdapter(item)) registerQuotaAdapter(item);
	}
}

export function resetQuotaAdapters(): void {
	adapters.clear();
	installQuotaAdapterHost();
}

installQuotaAdapterHost();
