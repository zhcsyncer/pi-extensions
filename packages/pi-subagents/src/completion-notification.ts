import type { AgentRecord } from "./types.js";
import { getStatusNote, previousResultSuffix } from "./status-note.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";

/** Model-facing content only; renderer details are not sent to the model. */
export const NOTIFICATION_MAX_BYTES = 16 * 1024;

type NotificationRecord = Pick<AgentRecord,
  "id" | "status" | "error" | "description" | "result" | "previousResult" | "toolCallId" | "outputFile" |
  "completedAt" | "startedAt" | "lifetimeUsage" | "session" | "compactionCount" | "toolUses"
>;

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusLabel(record: NotificationRecord): string {
  switch (record.status) {
    case "error": return `Error: ${record.error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Cut before escaping, on code-point boundaries, never inside an XML entity. */
function escapedPrefix(text: string, budget: number): string {
  const parts: string[] = [];
  for (const character of text) {
    const escaped = escapeXml(character);
    const size = Buffer.byteLength(escaped, "utf8");
    if (size > budget) break;
    parts.push(escaped);
    budget -= size;
  }
  return parts.join("");
}

function taskParts(record: NotificationRecord, compact: boolean) {
  const context = getSessionContextPercent(record.session);
  const before = [
    "<task-notification>",
    `<task-id>${escapeXml(record.id)}</task-id>`,
    !compact && record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    !compact && record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(compact ? record.status : statusLabel(record))}</status>`,
    !compact ? `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>` : null,
    compact ? `<metadata-truncated>${escapeXml(`Retrieve details: get_subagent_result(agent_id=${JSON.stringify(record.id)}).`)}</metadata-truncated>` : null,
    "<result>",
  ].filter(Boolean).join("\n");
  const after = [
    "</result>",
    !compact ? `<usage><total_tokens>${getLifetimeTotal(record.lifetimeUsage)}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${context !== null ? `<context_percent>${Math.round(context)}</context_percent>` : ""}${record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : ""}<duration_ms>${record.completedAt ? record.completedAt - record.startedAt : 0}</duration_ms></usage>` : null,
    "</task-notification>",
  ].filter(Boolean).join("\n");
  const result = (record.result || "No output.") + previousResultSuffix(record);
  const full = escapeXml(result);
  const marker = escapeXml(`\n[Report truncated. Retrieve full output: get_subagent_result(agent_id=${JSON.stringify(record.id)}).]`);
  return { before, after, result, full, marker };
}

/**
 * One budget for the whole notification, including XML, escaping and group label.
 * Preserve complete reports first; under pressure reserve retrieval markers for
 * every member, then spend spare bytes in input order. Metadata is expendable.
 */
export function formatCompletionNotification(
  records: readonly NotificationRecord[],
  options: { group?: boolean; partial?: boolean } = {},
): string {
  const header = options.group
    ? `Background agent group completed: ${records.length} agent(s) finished${options.partial ? " (partial — others still running)" : ""}\n\n`
    : "";
  const join = (bodies: string[]) => header + bodies.join("\n\n");
  const render = (part: ReturnType<typeof taskParts>, result: string) => part.before + result + part.after;
  let parts = records.map(record => taskParts(record, false));
  const full = join(parts.map(part => render(part, part.full)));
  if (Buffer.byteLength(full, "utf8") <= NOTIFICATION_MAX_BYTES) return full;

  const minimum = (part: ReturnType<typeof taskParts>) =>
    Buffer.byteLength(part.full) <= Buffer.byteLength(part.marker) ? part.full : part.marker;
  const minimumSize = () => Buffer.byteLength(join(parts.map(part => render(part, minimum(part)))));
  if (minimumSize() > NOTIFICATION_MAX_BYTES) {
    parts = records.map(record => taskParts(record, true));
  }
  if (minimumSize() <= NOTIFICATION_MAX_BYTES) {
    let remaining = NOTIFICATION_MAX_BYTES - minimumSize();
    return join(parts.map(part => {
      const reserved = minimum(part);
      const extra = Buffer.byteLength(part.full) - Buffer.byteLength(reserved);
      if (extra <= remaining) {
        remaining -= extra;
        return render(part, part.full);
      }
      const preview = escapedPrefix(part.result, remaining);
      remaining -= Buffer.byteLength(preview);
      return render(part, preview + part.marker);
    }));
  }

  // Even minimal XML may not fit a huge group. IDs are lossless and quoted;
  // never slice an ID into an invalid retrieval key. An unbounded set of IDs
  // cannot fit a fixed budget, so retain a deterministic prefix and explain how
  // to recover the remainder from launch receipts (no invented listing tool).
  const prefix = header + "[Reports and metadata truncated. Retrieve full output with get_subagent_result(agent_id=<ID>) for each quoted ID below.]\n";
  const omitted = (count: number) => count > 0
    ? `\n[${count} additional agent ID(s) omitted by the notification budget. Use their IDs from the original Agent launch responses with get_subagent_result(agent_id=<ID>).]`
    : "";
  let content = prefix;
  let included = 0;
  for (const record of records) {
    const entry = escapeXml(JSON.stringify(record.id)) + "\n";
    if (Buffer.byteLength(content + entry + omitted(records.length - included - 1)) > NOTIFICATION_MAX_BYTES) break;
    content += entry;
    included++;
  }
  return content + omitted(records.length - included);
}
