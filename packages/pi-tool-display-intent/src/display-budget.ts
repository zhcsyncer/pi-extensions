/** Budgets apply to derived display data, never to execution results or model input. */
export const DISPLAY_LIMITS = { units: 1_000_000, lines: 20_000, blocks: 1000, nodes: 6000, depth: 24 } as const;
export const DISPLAY_OMISSION = "[Truncated: display safety limit reached; remaining content omitted.]";

export function displayField(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch { return undefined; }
}

export function displayPropertyOmitted(value: unknown, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return !!descriptor && !("value" in descriptor);
	} catch { return true; }
}

export function clipDisplaySource(text: string, units: number): string {
	let clipped = text.slice(0, Math.max(0, units));
	if (clipped.length < text.length) {
		const last = clipped.charCodeAt(clipped.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
		clipped = clipped.replace(/\x1b(?:\[[0-9;:]*)?$/, "");
	}
	return clipped;
}

export function boundDisplayText(text: string, units: number = DISPLAY_LIMITS.units, lines: number = DISPLAY_LIMITS.lines) {
	const limit = Math.min(text.length, Math.max(0, units));
	let count = 1;
	let end = limit;
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10 && ++count > lines) { end = i; break; }
	}
	return { text: clipDisplaySource(text, end), truncated: end < text.length, lines: Math.min(count, lines) };
}

/** Reads only data properties: getters, array iterators and toJSON are not display inputs. */
export function boundDisplayLines(value: unknown, units: number = DISPLAY_LIMITS.units, lineLimit: number = DISPLAY_LIMITS.lines, countEmbeddedLines = true) {
	const rows: string[] = [];
	let remaining = units;
	let remainingLines = lineLimit;
	const length = displayField(value, "length");
	try { if (!Array.isArray(value) || !Number.isSafeInteger(length) || (length as number) < 0) return { rows, truncated: true }; }
	catch { return { rows, truncated: true }; }
	const count = length as number;
	let truncated = count > lineLimit;
	for (let i = 0; i < Math.min(count, lineLimit); i++) {
		const line = displayField(value, String(i));
		if (typeof line !== "string") { truncated = true; break; }
		const bounded = countEmbeddedLines
			? boundDisplayText(line, remaining, Math.max(1, remainingLines))
			: { text: clipDisplaySource(line, remaining), truncated: line.length > remaining, lines: 1 };
		rows.push(bounded.text);
		remaining -= bounded.text.length + 1;
		remainingLines -= bounded.lines;
		if (bounded.truncated || remaining < 0 || ((remaining === 0 || remainingLines <= 0) && i + 1 < count)) { truncated = true; break; }
	}
	return { rows, truncated };
}

export function displayOmissionRows(width: number): string[] {
	const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
	const rows: string[] = [];
	for (let i = 0; i < DISPLAY_OMISSION.length; i += columns) rows.push(DISPLAY_OMISSION.slice(i, i + columns));
	return rows;
}

export function capFormattedRows(rows: string[], units: number = DISPLAY_LIMITS.units, width: number = DISPLAY_OMISSION.length): string[] {
	const bounded = boundDisplayLines(rows, units, DISPLAY_LIMITS.lines, false);
	return bounded.truncated ? [...bounded.rows, ...displayOmissionRows(width)] : bounded.rows;
}

export function displayTextFits(value: string): boolean {
	return value.length <= DISPLAY_LIMITS.units && !boundDisplayText(value).truncated;
}

export function extractDisplayText(result: unknown): string {
	let raw: unknown;
	try {
		const descriptor = result && typeof result === "object" ? Object.getOwnPropertyDescriptor(result, "content") : undefined;
		if (descriptor && !("value" in descriptor)) return DISPLAY_OMISSION;
		raw = descriptor?.value;
	} catch { return DISPLAY_OMISSION; }
	try { if (!Array.isArray(raw)) return ""; } catch { return DISPLAY_OMISSION; }
	const length = displayField(raw, "length");
	if (typeof length !== "number") return DISPLAY_OMISSION;
	const parts: string[] = [];
	// This text is input to later splitting/formatting, not final presentation.
	// Reserve its possible notice before traversal; no second scan of the body.
	let remaining = DISPLAY_LIMITS.units - DISPLAY_OMISSION.length - 1;
	let lines = DISPLAY_LIMITS.lines - 1;
	let truncated = length > DISPLAY_LIMITS.blocks;
	for (let i = 0; i < Math.min(length, DISPLAY_LIMITS.blocks); i++) {
		if (displayPropertyOmitted(raw, String(i))) { truncated = true; continue; }
		const block = displayField(raw, String(i));
		const type = displayField(block, "type");
		const text = displayField(block, "text");
		if (type !== "text") {
			if (displayPropertyOmitted(block, "type")) truncated = true;
			continue;
		}
		if (typeof text !== "string") {
			if (displayPropertyOmitted(block, "text")) truncated = true;
			continue;
		}
		if (remaining <= 0 || lines <= 0) { truncated = true; break; }
		const bounded = boundDisplayText(text, remaining, lines);
		parts.push(bounded.text);
		remaining -= bounded.text.length + 1;
		lines -= bounded.lines;
		if (bounded.truncated) { truncated = true; break; }
	}
	return parts.join("\n") + (truncated ? `\n${DISPLAY_OMISSION}` : "");
}

/** A notification-time view snapshot. No getters, iterators, toJSON or whole-object serialization. */
export function snapshotDisplayValue(input: unknown, limits: { units?: number; nodes?: number } = {}) {
	let remaining = Math.min(DISPLAY_LIMITS.units, Math.max(0, limits.units ?? DISPLAY_LIMITS.units));
	const nodeLimit = Math.min(DISPLAY_LIMITS.nodes, Math.max(0, limits.nodes ?? DISPLAY_LIMITS.nodes));
	let lines = DISPLAY_LIMITS.lines as number;
	let nodes = 0;
	let entries = 0;
	let truncated = false;
	const ancestors = new Set<object>();
	const omitted = () => {
		truncated = true;
		remaining = Math.max(0, remaining - DISPLAY_OMISSION.length);
		lines = Math.max(0, lines - 1);
		return DISPLAY_OMISSION;
	};
	const visit = (value: unknown, depth: number, content = false): any => {
		if (++nodes > nodeLimit || depth > DISPLAY_LIMITS.depth || remaining <= 0 || lines <= 0) return omitted();
		if (typeof value === "string") {
			const bounded = boundDisplayText(value, remaining, lines);
			remaining -= bounded.text.length;
			lines -= bounded.lines;
			if (bounded.truncated) return bounded.text + `\n${omitted()}`;
			return bounded.text;
		}
		if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
		if (typeof value !== "object") return omitted();
		if (ancestors.has(value)) {
			truncated = true;
			remaining = Math.max(0, remaining - "[Circular]".length);
			lines = Math.max(0, lines - 1);
			return "[Circular]";
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return omitted();
		ancestors.add(value);
		const array = Array.isArray(value);
		const output: any = array ? [] : {};
		const set = (key: string, value: unknown) => Object.defineProperty(output, key, { value, enumerable: true, configurable: true, writable: true });
		const copy = (key: string) => {
			if (++entries > nodeLimit || nodes >= nodeLimit || remaining <= 0 || lines <= 0) { omitted(); return false; }
			if (key.length > remaining) { omitted(); return false; }
			remaining -= key.length;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) { set(key, omitted()); return true; }
			set(key, visit(descriptor.value, depth + 1, key === "content"));
			return true;
		};
		try {
			if (array) {
				const length = displayField(value, "length");
				if (typeof length !== "number") omitted();
				else {
					const limit = content ? Math.min(DISPLAY_LIMITS.blocks, nodeLimit) : nodeLimit;
					for (let i = 0; i < Math.min(length, limit); i++) if (!copy(String(i))) break;
					if (length > output.length) omitted();
				}
			} else {
				for (const key in value) {
					if (!Object.hasOwn(value, key)) { if (++entries > nodeLimit) { omitted(); break; } continue; }
					if (!copy(key)) break;
				}
			}
		} catch { omitted(); }
		ancestors.delete(value);
		return output;
	};
	try { return { value: visit(input, 0), truncated }; }
	catch { return { value: DISPLAY_OMISSION, truncated: true }; }
}
