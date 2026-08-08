import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import { resolveReviewerRoutes } from "./command/resolve-routes.ts";
import type { ParsedReviewCommand, ReviewerRoute } from "./types.ts";

export const ADVERSARIAL_REVIEW_COMMAND = "adversarial-review";

export interface ReviewCommandPreflight {
  command: ParsedReviewCommand;
  routes: ReviewerRoute[];
}

export function preflightReviewCommand(
  args: string,
  ctx: ExtensionCommandContext,
): ReviewCommandPreflight {
  const command = parseReviewCommand(args);
  const routes = resolveReviewerRoutes(command.reviewerSpecs, ctx.scopedModels);
  return { command, routes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function adversarialReviewExtension(pi: ExtensionAPI): void {
  let activeRun: AbortController | undefined;

  pi.registerCommand(ADVERSARIAL_REVIEW_COMMAND, {
    description: "Run deterministic multi-model adversarial code review",
    handler: async (args, ctx) => {
      try {
        const { command, routes } = preflightReviewCommand(args, ctx);
        ctx.ui.notify(
          `Validated ${routes.length} reviewer routes for ${command.target.mode} review.`,
          "info",
        );
      } catch (error) {
        const prefix = error instanceof ReviewCommandError ? "Adversarial review" : "Adversarial review failed";
        ctx.ui.notify(`${prefix}: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    activeRun?.abort(new Error("Pi session shut down"));
    activeRun = undefined;
  });
}
