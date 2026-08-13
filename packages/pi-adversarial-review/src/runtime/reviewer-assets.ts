import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REVIEWER_PROMPT_PATH = fileURLToPath(
  new URL("../../assets/adversarial-reviewer.md", import.meta.url),
);
const CHARTER_PATH = fileURLToPath(
  new URL("../../assets/adversarial-charter.md", import.meta.url),
);
const REFUTER_PROMPT_PATH = fileURLToPath(
  new URL("../../assets/adversarial-refuter.md", import.meta.url),
);

export async function loadReviewerSystemPrompt(): Promise<string> {
  const [rolePrompt, charter] = await Promise.all([
    readFile(REVIEWER_PROMPT_PATH, "utf8"),
    readFile(CHARTER_PATH, "utf8"),
  ]);
  return `${rolePrompt.trim()}\n\n# Trusted charter\n\n${charter.trim()}\n`;
}

export function loadRefuterSystemPrompt(): Promise<string> {
  return readFile(REFUTER_PROMPT_PATH, "utf8");
}
