import type { Logger } from "./logger.ts";
import type { Config } from "./config.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";
import { executePipeline } from "./pipeline/pipeline.ts";
import { createExecutor, type CodeExecutor } from "./pipeline/executor.ts";

function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

export async function processTicket(options: {
  ticket: Ticket;
  provider: TicketProvider;
  config: Config;
  logger: Logger;
  executor?: CodeExecutor;
}): Promise<void> {
  const { ticket, provider, config, logger } = options;

  // Claim the ticket
  try {
    await provider.transitionStatus(ticket.id, "in-progress");
    logger.info("Ticket claimed", { ticketId: ticket.identifier });
  } catch (err) {
    logger.warn("Failed to claim ticket", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const executor = options.executor ?? createExecutor(config.executor.type);

  // Set environment variables for worker hooks
  const agentName = config.agent?.name ?? "";
  process.env.AGENT_MODE = "1";
  process.env.AGENT_NAME = agentName;
  process.env.AGENT_LABEL = config.github.agent_label;
  process.env.ISSUE_NUMBER = ticket.identifier;
  process.env.ISSUE_TITLE = ticket.title;
  process.env.ISSUE_BODY = ticket.description ?? "";
  process.env.VAULT_DIR = config.repo.path;
  process.env.GITHUB_REPO = config.github.repo;
  if (config.teams) {
    process.env.MAX_TEAMMATES = String(config.teams.max_teammates);
  }

  // Use worker hooks (resolved paths) if available, fall back to hooks.pre/post
  const preHooks = config._resolved_pre_hooks.length > 0
    ? config._resolved_pre_hooks
    : config.hooks.pre;
  const postHooks = config._resolved_post_hooks.length > 0
    ? config._resolved_post_hooks
    : config.hooks.post;

  // Run pipeline with retries
  let lastResult: Awaited<ReturnType<typeof executePipeline>> | undefined;

  for (let attempt = 0; attempt <= config.executor.retries; attempt++) {
    if (attempt > 0) {
      logger.warn("Retrying pipeline", {
        ticketId: ticket.identifier,
        attempt,
        maxRetries: config.executor.retries,
      });
    }

    try {
      lastResult = await executePipeline({
        ticket,
        preHooks,
        postHooks,
        repoCwd: config.repo.path,
        executor,
        timeoutMs: config.executor.timeout_seconds * 1000,
        logger,
      });

      if (lastResult.success) break;
    } catch (err) {
      logger.error("Pipeline threw unexpected error", {
        ticketId: ticket.identifier,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      lastResult = {
        success: false,
        stage: "executor" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Update final status
  try {
    if (lastResult?.success) {
      await provider.transitionStatus(ticket.id, "done");

      const output = lastNLines(lastResult.output ?? "", 50);
      const comment = [
        "## Agent Worker Completed",
        "",
        "Task completed successfully.",
        ...(output ? ["", "**Output (last 50 lines):**", "```", output, "```"] : []),
      ].join("\n");
      await provider.postComment(ticket.id, comment);

      logger.info("Ticket completed", { ticketId: ticket.identifier });
    } else {
      await provider.transitionStatus(ticket.id, "failed");

      const errorOutput = lastNLines(lastResult?.error ?? "Unknown error", 50);
      const comment = [
        "## Agent Worker Failure",
        "",
        `**Stage:** ${lastResult?.stage ?? "unknown"}`,
        "**Error:**",
        "```",
        errorOutput,
        "```",
      ].join("\n");

      await provider.postComment(ticket.id, comment);
      logger.error("Ticket failed", {
        ticketId: ticket.identifier,
        stage: lastResult?.stage,
      });
    }
  } catch (err) {
    logger.error("Failed to update ticket status", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Clean up env vars
    delete process.env.AGENT_MODE;
    delete process.env.ISSUE_NUMBER;
    delete process.env.ISSUE_TITLE;
    delete process.env.ISSUE_BODY;
  }
}
