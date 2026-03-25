import type { Logger } from "../logger.ts";
import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines } from "./executor.ts";

export type ClaudeExecutorOptions = {
  mode: "print" | "conversation";
  model?: string;
  maxTurns?: number;
};

export function createClaudeExecutor(options?: ClaudeExecutorOptions): CodeExecutor {
  const mode = options?.mode ?? "print";

  return {
    name: "claude",
    needsWorktree: false,
    async run(prompt: string, cwd: string, timeoutMs: number, logger: Logger): Promise<ExecutorResult> {
      logger.info("Claude Code started", { mode, timeoutMs });

      const args = buildArgs(mode, prompt, options);
      logger.info("Claude Code args", { args: args.join(" ") });

      const proc = Bun.spawn(args, {
        cwd,
        stdin: mode === "conversation" ? "pipe" : undefined,
        stdout: "pipe",
        stderr: "pipe",
      });

      // In conversation mode, write prompt to stdin and close it
      if (mode === "conversation" && proc.stdin) {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(prompt));
        await writer.close();
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr] = await Promise.all([
        streamToLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
          logger.info("claude", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          logger.info("claude", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        logger.error("Claude Code timed out", { timeoutMs });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        logger.error("Claude Code failed", { exitCode });
      } else {
        logger.info("Claude Code completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}

function buildArgs(mode: "print" | "conversation", prompt: string, options?: ClaudeExecutorOptions): string[] {
  const args = ["claude"];

  if (mode === "print") {
    // Single-shot mode: pass prompt as argument
    args.push("--print", "--dangerously-skip-permissions", "-p", prompt);
  } else {
    // Conversation mode: prompt piped via stdin, supports TeamCreate/SendMessage
    args.push("--dangerously-skip-permissions");
  }

  if (options?.model) {
    args.push("--model", options.model);
  }

  if (options?.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  return args;
}
