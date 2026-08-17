export type BtwRoute =
	| { kind: "open" }
	| { kind: "ask"; question: string }
	| { kind: "merge"; prompt: string }
	| { kind: "help" };

export const BTW_HELP = `/btw usage:
/btw                        open an empty Herdr Pi side thread
/btw <question...>          open a side thread and submit the question
/btw ask <question...>      explicit form for a question beginning with a reserved word
/btw merge                  parent: rescan pending merges; child: edit a parent follow-up
/btw merge <prompt...>      child: merge and continue in the parent with this prompt
/btw help                   show this grammar`;

export function parseBtwCommand(input: string): BtwRoute {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "open" };
	const split = trimmed.search(/\s/);
	const first = split < 0 ? trimmed : trimmed.slice(0, split);
	const rest = split < 0 ? "" : trimmed.slice(split).trim();
	switch (first) {
		case "ask": return rest ? { kind: "ask", question: rest } : { kind: "open" };
		case "merge": return { kind: "merge", prompt: rest };
		case "help": return { kind: "help" };
		default: return { kind: "ask", question: trimmed };
	}
}
