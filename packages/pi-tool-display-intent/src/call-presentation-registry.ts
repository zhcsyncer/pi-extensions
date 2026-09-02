export interface AggregateCallPresentation {
	target: string;
	metadata?: string[];
}

type AggregateCallPresentationLookup = (
	toolName: string,
	args: unknown,
) => AggregateCallPresentation | undefined;

let lookup: AggregateCallPresentationLookup | undefined;

export function setAggregateCallPresentationLookup(
	next: AggregateCallPresentationLookup | undefined,
): void {
	lookup = next;
}

export function lookupAggregateCallPresentation(
	toolName: string,
	args: unknown,
): AggregateCallPresentation | undefined {
	if (!toolName || !lookup) return undefined;
	try {
		const presentation = lookup(toolName, args);
		if (!presentation?.target) return undefined;
		return presentation;
	} catch {
		return undefined;
	}
}
