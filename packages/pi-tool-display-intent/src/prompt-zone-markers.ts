/**
 * OSC 133 prompt-zone markers.
 *
 * Pi's fullscreen transcript finds message boundaries by scanning painted rows
 * for a leading `OSC 133 ; A` sequence (see pi-tui `scrollToPrompt`, which tests
 * every row with `/^\x1b\]133;A(?:\x07|\x1b\\)/`). Pi core prepends that marker to
 * the first row of every non-empty user and assistant message render, and skips it
 * for an assistant message that carries tool calls. A component that rebuilds those
 * rows therefore has to ask whether the host render it rebuilds from was a boundary.
 *
 * The scan mirrors that consumer, so it tests every row: a foreign renderer may
 * legitimately hand us the host rows behind a leading blank row. It stays anchored
 * at byte 0 because an unanchored scan also matches a message that merely quotes
 * the sequence in its own text, which would strip that text and mark rows pi-tui
 * would never have treated as a boundary.
 */

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

/** True when a row would be found by pi-tui's prompt scan: a byte-0 marker. */
export function hasPromptZoneMarker(lines: readonly string[]): boolean {
	return lines.some((line) => OSC133_PROMPT_START.test(line));
}
