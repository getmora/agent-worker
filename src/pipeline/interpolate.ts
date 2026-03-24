import type { Ticket } from "../providers/types.ts";

export type TaskVars = {
  id: string;
  title: string;
  raw_title: string;
  branch: string;
  worktree: string;
  issue_number: string;
  agent_label: string;
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sanitizeTitle(text: string): string {
  return text.replace(/['`$\\]/g, "");
}

export function buildTaskVars(ticket: Ticket, options: { worktree?: string; agentLabel?: string } = {}): TaskVars {
  return {
    id: ticket.identifier,
    title: slugify(ticket.title),
    raw_title: sanitizeTitle(ticket.title),
    branch: `agent/task-${ticket.identifier}`,
    worktree: options.worktree ?? "",
    issue_number: ticket.identifier,
    agent_label: options.agentLabel ?? "",
  };
}

export function interpolate(template: string, vars: TaskVars): string {
  return template
    .replaceAll("{id}", vars.id)
    .replaceAll("{title}", vars.title)
    .replaceAll("{raw_title}", vars.raw_title)
    .replaceAll("{branch}", vars.branch)
    .replaceAll("{worktree}", vars.worktree)
    .replaceAll("{issue_number}", vars.issue_number)
    .replaceAll("{agent_label}", vars.agent_label)
    .replaceAll("{date}", new Date().toISOString());
}
