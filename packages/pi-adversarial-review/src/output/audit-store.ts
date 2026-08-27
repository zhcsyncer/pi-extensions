import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const ADVERSARIAL_REVIEW_AUDIT_VERSION = 1;
export const ADVERSARIAL_REVIEW_EXTENSION_ID = "pi-adversarial-review";

export type StandaloneAuditKind = "cancellation" | "error" | "report";

export interface StandaloneAuditRecord {
  version: typeof ADVERSARIAL_REVIEW_AUDIT_VERSION;
  kind: StandaloneAuditKind;
  recordedAt: string;
  mode: "tui" | "rpc" | "json" | "print";
  sessionId?: string;
  cwd?: string;
  payload: unknown;
}

export function getAdversarialReviewAuditDir(agentDir = getAgentDir()): string {
  return join(agentDir, "extension-data", ADVERSARIAL_REVIEW_EXTENSION_ID, "audit");
}

function ensureRealChildDirectory(parent: string, name: string, mode: number): string {
  const path = join(parent, name);
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Adversarial review audit path contains a non-directory or symlink: ${path}`);
  }
  return path;
}

function prepareAuditDirectory(agentDir: string): string {
  // The configured Pi agent root is the trust boundary and may itself be a
  // deliberate symlink. Every extension-owned child below it must be real so
  // a repository or stale local state cannot redirect complete audit payloads.
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (!statSync(agentDir).isDirectory()) {
    throw new Error(`Pi agent data path is not a directory: ${agentDir}`);
  }
  const extensionData = ensureRealChildDirectory(agentDir, "extension-data", 0o700);
  const packageData = ensureRealChildDirectory(extensionData, ADVERSARIAL_REVIEW_EXTENSION_ID, 0o700);
  return ensureRealChildDirectory(packageData, "audit", 0o700);
}

function safeTimestamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

/**
 * Persist one audit independently from Pi's session flush policy. Completed
 * reports/errors use this in non-TUI modes; pre-freeze cancellations use it in
 * every mode so shutdown cannot erase the only cancellation record.
 */
export function persistStandaloneAudit(options: {
  kind: StandaloneAuditKind;
  mode: "tui" | "rpc" | "json" | "print";
  payload: unknown;
  sessionId?: string;
  cwd?: string;
  now?: Date;
  id?: string;
  agentDir?: string;
}): string {
  const now = options.now ?? new Date();
  const id = options.id ?? randomUUID();
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error("Audit id contains unsupported characters.");

  const auditDir = prepareAuditDirectory(options.agentDir ?? getAgentDir());

  const record: StandaloneAuditRecord = {
    version: ADVERSARIAL_REVIEW_AUDIT_VERSION,
    kind: options.kind,
    recordedAt: now.toISOString(),
    mode: options.mode,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    payload: options.payload,
  };
  const filename = `${safeTimestamp(now)}-${options.kind}-${id}.json`;
  const finalPath = join(auditDir, filename);
  const temporaryPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, finalPath);
    rmSync(temporaryPath, { force: true });
    return finalPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
