import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REVIEWER_PROMPT_PATH = fileURLToPath(
  new URL("../../assets/adversarial-reviewer.md", import.meta.url),
);
const REFUTER_PROMPT_PATH = fileURLToPath(
  new URL("../../assets/adversarial-refuter.md", import.meta.url),
);

export function loadReviewerSystemPrompt(): Promise<string> {
  return readFile(REVIEWER_PROMPT_PATH, "utf8");
}

export function loadRefuterSystemPrompt(): Promise<string> {
  return readFile(REFUTER_PROMPT_PATH, "utf8");
}
