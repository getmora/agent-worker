import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Ticket, TicketProvider } from "./types.ts";

export function createGitHubProvider(options: {
  repo: string;
  agentLabel: string;
}): TicketProvider {
  const { repo, agentLabel } = options;

  async function gh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    return { stdout, stderr, exitCode };
  }

  return {
    async fetchReadyTickets(): Promise<Ticket[]> {
      const { stdout, exitCode, stderr } = await gh([
        "issue", "list",
        "--repo", repo,
        "--label", agentLabel,
        "--state", "open",
        "--json", "number,title,body,labels",
        "--limit", "50",
      ]);

      if (exitCode !== 0) {
        throw new Error(`gh issue list failed: ${stderr.trim()}`);
      }

      const issues = JSON.parse(stdout || "[]") as Array<{
        number: number;
        title: string;
        body: string;
        labels: Array<{ name: string }>;
      }>;

      return issues
        .filter((issue) => {
          const labelNames = issue.labels.map((l) => l.name);
          return (
            !labelNames.includes("done") &&
            !labelNames.includes("needs-review") &&
            !labelNames.includes("in-progress") &&
            !labelNames.includes("failed")
          );
        })
        .map((issue) => ({
          id: String(issue.number),
          identifier: String(issue.number),
          title: issue.title,
          description: issue.body || undefined,
        }));
    },

    async transitionStatus(ticketId: string, statusName: string): Promise<void> {
      // Map status to project board column name
      const boardStatus: Record<string, string> = {
        "in-progress": "In progress",
        "done": "Done",
        "failed": "Failed",
      };

      switch (statusName) {
        case "in-progress": {
          const { exitCode, stderr } = await gh([
            "issue", "edit", ticketId,
            "--repo", repo,
            "--add-label", "in-progress",
          ]);
          if (exitCode !== 0) throw new Error(`Failed to add in-progress label: ${stderr.trim()}`);
          break;
        }
        case "done": {
          const { exitCode, stderr } = await gh([
            "issue", "edit", ticketId,
            "--repo", repo,
            "--remove-label", "in-progress",
            "--add-label", "done",
          ]);
          if (exitCode !== 0) throw new Error(`Failed to transition to done: ${stderr.trim()}`);
          break;
        }
        case "failed": {
          await gh([
            "issue", "edit", ticketId,
            "--repo", repo,
            "--remove-label", "in-progress",
          ]);
          // Ignore remove failure (label might not exist)
          const { exitCode, stderr } = await gh([
            "issue", "edit", ticketId,
            "--repo", repo,
            "--add-label", "failed",
          ]);
          if (exitCode !== 0) throw new Error(`Failed to add failed label: ${stderr.trim()}`);
          break;
        }
        default:
          throw new Error(`Unknown status: ${statusName}`);
      }

      // Sync project board status (best-effort, don't fail on error)
      const projectStatus = boardStatus[statusName];
      if (projectStatus) {
        const scriptPath = process.env.VAULT_DIR
          ? `${process.env.VAULT_DIR}/hooks/lib/project-board.sh`
          : null;
        if (scriptPath) {
          try {
            const proc = Bun.spawn(["bash", "-c", `source "${scriptPath}" && set_project_status "${ticketId}" "${projectStatus}"`], {
              env: { ...process.env, GITHUB_REPO: repo },
              stdout: "pipe",
              stderr: "pipe",
            });
            await proc.exited;
          } catch {
            // Best-effort — don't fail the transition if board sync fails
          }
        }
      }
    },

    async postComment(ticketId: string, body: string): Promise<void> {
      const tmpFile = join(tmpdir(), `agent-worker-comment-${ticketId}-${Date.now()}.md`);
      try {
        writeFileSync(tmpFile, body, "utf-8");
        const { exitCode, stderr } = await gh([
          "issue", "comment", ticketId,
          "--repo", repo,
          "--body-file", tmpFile,
        ]);
        if (exitCode !== 0) {
          throw new Error(`Failed to post comment: ${stderr.trim()}`);
        }
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          // Ignore cleanup failure
        }
      }
    },
  };
}
