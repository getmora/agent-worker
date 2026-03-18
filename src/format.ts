/**
 * TTY formatting utilities for human-readable console output.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

function c(code: string, text: string): string {
  return isTTY() ? `${code}${text}${RESET}` : text;
}

/** Print the startup splash banner. */
export function printSplash(executorName?: string): void {
  const subtitle = executorName
    ? `Linear → ${executorName} pipeline`
    : "Linear → Agent pipeline";

  console.log("");
  console.log(c(BOLD + CYAN, "  Agent Worker"));
  console.log(c(DIM, `  ${subtitle}`));
  console.log("");
}

const LEVEL_COLORS: Record<string, string> = {
  debug: DIM,
  info: RESET,
  warn: YELLOW,
  error: RED,
};

const LEVEL_LABELS: Record<string, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

/**
 * Format a structured log entry for TTY output.
 *
 * Executor output lines (those carrying a `line` field in ctx) get a clean
 * pipe-prefixed style regardless of which executor emitted them — matching
 * on `ctx.line` rather than a hardcoded executor name ensures codex, claude,
 * and any future executor all render consistently.
 */
export function formatLogLine(
  level: string,
  msg: string,
  ctx?: Record<string, unknown>
): string {
  // Executor output line — pipe-prefixed regardless of executor name
  if (ctx?.line !== undefined) {
    const prefix = ctx.stream === "stderr" ? c(DIM + RED, "  │ ") : c(DIM, "  │ ");
    return `${prefix}${ctx.line}`;
  }

  const ts = typeof ctx?.timestamp === "string"
    ? ctx.timestamp.slice(11, 19)  // HH:MM:SS from ISO string
    : "";

  const color = LEVEL_COLORS[level] ?? RESET;
  const label = LEVEL_LABELS[level] ?? level.toUpperCase().slice(0, 3);

  const parts = [
    ts ? c(DIM, ts) : "",
    c(color, label),
    msg,
  ].filter(Boolean).join(" ");

  if (ctx && Object.keys(ctx).some((k) => k !== "timestamp")) {
    const extra = Object.entries(ctx)
      .filter(([k]) => k !== "timestamp")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `${parts} ${c(DIM, extra)}`;
  }

  return parts;
}

/** Format a success or failure outcome line. */
export function formatOutcome(success: boolean, label: string): string {
  return success
    ? c(GREEN, `✓ ${label}`)
    : c(RED, `✗ ${label}`);
}
