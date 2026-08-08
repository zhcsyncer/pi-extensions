import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MergedReviewReport, ReviewerRoute } from "../types.ts";

export const ADVERSARIAL_REVIEW_MESSAGE_TYPE = "adversarial-review-report";

function routeIdentity(route: ReviewerRoute) {
  return {
    key: route.key,
    provider: route.provider,
    modelId: route.modelId,
    thinking: route.thinking,
    thinkingSource: route.thinkingSource,
    ordinal: route.ordinal,
  };
}

export function serializeMergedReviewReport(report: MergedReviewReport) {
  return {
    ...report,
    requestedRoutes: report.requestedRoutes.map(routeIdentity),
    routeResults: report.routeResults.map(({ route, ...result }) => ({
      ...result,
      route: routeIdentity(route),
    })),
  };
}

export function buildMergedReportText(report: MergedReviewReport): string {
  const lines = [
    `Adversarial review: ${report.overall}`,
    `Reviewers: ${report.successfulReviewerCount}/${report.requestedRoutes.length} valid ` +
      `(minimum ${report.minSuccessfulReviewerCount})`,
    `Target: ${report.target.description}`,
  ];

  if (report.stale) {
    lines.push("WARNING: The target changed during review. Re-run before treating findings as current.");
  } else if (report.overall === "inconclusive") {
    lines.push("WARNING: Too few reviewers completed successfully; this run cannot support approval.");
  } else if (report.overall === "failed") {
    lines.push("WARNING: No reviewer returned a valid report.");
  } else if (report.overall === "candidate-approve") {
    lines.push("No blocking cluster met the configured gate. This is a candidate result, not final approval.");
  }

  if (report.overall === "needs-adjudication" && report.blocking.length === 0) {
    lines.push(
      "Multiple reviewers raised distinct advisory concerns. They did not form a safe lexical cluster, so adjudication is still required.",
    );
  }

  if (report.blocking.length > 0) {
    lines.push("", `Blocking findings (${report.blocking.length}):`);
    for (const finding of report.blocking) {
      lines.push(
        `- [${finding.severity}] ${finding.file}:${finding.lineStart}-${finding.lineEnd} ` +
          `${finding.issue} (votes ${finding.votes}, confidence ${finding.confidence.toFixed(2)})`,
      );
    }
  }
  if (report.advisory.length > 0) {
    lines.push("", `Advisory findings: ${report.advisory.length} (see report details).`);
  }

  const failedRoutes = report.routeResults.filter((result) => result.status !== "completed");
  if (failedRoutes.length > 0) {
    lines.push("", "Reviewer route failures:");
    for (const result of failedRoutes) {
      lines.push(`- ${result.route.key}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  lines.push("", "The main model was not triggered automatically. Ask it to adjudicate this report when ready.");
  return lines.join("\n");
}

export interface PublishReportResult {
  deliveryWarning?: string;
}

export function publishMergedReviewReport(
  pi: ExtensionAPI,
  report: MergedReviewReport,
  mode: "tui" | "rpc" | "json" | "print",
): PublishReportResult {
  const content = buildMergedReportText(report);
  const details = serializeMergedReviewReport(report);
  // Durable audit/output channel. Unlike sendMessage this never enters LLM context.
  pi.appendEntry(ADVERSARIAL_REVIEW_MESSAGE_TYPE, details);

  if (mode === "print") {
    console.log(content);
    return {};
  }
  try {
    pi.sendMessage({
      customType: ADVERSARIAL_REVIEW_MESSAGE_TYPE,
      content,
      display: true,
      details,
    }, { deliverAs: "nextTurn" });
    return {};
  } catch (error) {
    return {
      deliveryWarning: `Merged report was persisted but could not be queued for the next turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
