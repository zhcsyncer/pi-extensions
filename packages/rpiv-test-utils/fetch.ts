import { vi } from "vitest";

export interface FetchMatcher {
	match: (url: string, init?: RequestInit) => boolean;
	response: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface FetchCall {
	url: string;
	init?: RequestInit;
	signal?: AbortSignal;
}

export interface FetchStub {
	calls: FetchCall[];
}

export function stubFetch(matchers: FetchMatcher[]): FetchStub {
	const calls: FetchCall[] = [];
	const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
		calls.push({ url, init, signal: init?.signal ?? undefined });
		for (const m of matchers) {
			if (m.match(url, init)) return m.response(url, init);
		}
		throw new Error(`stubFetch: no matcher for ${url}`);
	};
	vi.stubGlobal("fetch", vi.fn(impl));
	return { calls };
}
