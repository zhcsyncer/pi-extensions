import { stripVTControlCharacters } from "node:util";

const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const STRING_CONTROL_SEQUENCE = /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Remove terminal control sequences from child-sourced text before it reaches
 * the parent TUI. Preserve tabs, line feeds, printable Unicode, and wide text.
 */
export function sanitizeDisplayText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return stripVTControlCharacters(
    normalized
      .replace(OSC_SEQUENCE, "")
      .replace(STRING_CONTROL_SEQUENCE, ""),
  ).replace(UNSAFE_CONTROL_CHARACTERS, "");
}
