import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADVERSARIAL_REVIEW_EXTENSION_ID } from "./output/audit-store.ts";

export interface AdversarialReviewConfig {
  /** Persist reviewer/refuter/format-repair runs as parent-linked Pi sessions. */
  persistRouteSessions: boolean;
}

export const DEFAULT_ADVERSARIAL_REVIEW_CONFIG: Readonly<AdversarialReviewConfig> = Object.freeze({
  persistRouteSessions: false,
});

export function getAdversarialReviewConfigFile(agentDir = getAgentDir()): string {
  return join(
    agentDir,
    "extension-data",
    ADVERSARIAL_REVIEW_EXTENSION_ID,
    "config.json",
  );
}

function invalidConfig(path: string, detail: string): Error {
  return new Error(`Invalid adversarial review config at ${path}: ${detail}`);
}

/**
 * Load the user-owned privacy/storage policy. Missing means memory-only; invalid
 * input fails loud rather than silently changing whether child sessions exist.
 */
export function loadAdversarialReviewConfig(
  path = getAdversarialReviewConfigFile(),
): AdversarialReviewConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_ADVERSARIAL_REVIEW_CONFIG };
    }
    throw invalidConfig(path, error instanceof Error ? error.message : String(error));
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidConfig(path, error instanceof Error ? error.message : "malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidConfig(path, "root must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "persistRouteSessions");
  if (unknown.length > 0) {
    throw invalidConfig(path, `unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  if (
    record.persistRouteSessions !== undefined &&
    typeof record.persistRouteSessions !== "boolean"
  ) {
    throw invalidConfig(path, "persistRouteSessions must be a boolean");
  }
  return {
    persistRouteSessions: record.persistRouteSessions ?? false,
  };
}
