import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const AgentSchema = z.object({
  name: z.string(),
  soul: z.string().optional(),
  heartbeat: z.string().optional(),
  tools: z.string().optional(),
}).optional();

const GitHubSchema = z.object({
  repo: z.string(),
  agent_label: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
});

const RepoSchema = z.object({
  path: z.string(),
}).optional();

const HooksSchema = z.object({
  pre: z.array(z.string()).default([]),
  post: z.array(z.string()).default([]),
}).default({ pre: [], post: [] });

const ExecutorSchema = z.object({
  type: z.enum(["claude", "codex"]).default("claude"),
  mode: z.enum(["print", "conversation"]).default("print"),
  model: z.string().optional(),
  timeout_seconds: z.number().positive().default(300),
  retries: z.number().int().min(0).max(3).default(0),
  max_turns: z.number().int().positive().optional(),
}).default({ type: "claude", mode: "print", timeout_seconds: 300, retries: 0 });

const LogSchema = z.object({
  file: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).default({ level: "info" });

const HarnessSchema = z.object({
  max_phase_retries: z.number().int().min(0).default(3),
}).optional();

const TeamsSchema = z.object({
  enable_agent_teams: z.boolean().default(false),
  max_teammates: z.number().int().min(0).default(0),
  teammate_model: z.string().optional(),
}).optional();

const ConfigFileSchema = z.object({
  agent: AgentSchema,
  github: GitHubSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  executor: ExecutorSchema,
  log: LogSchema,
  worker_pre_hooks: z.array(z.string()).default([]),
  worker_post_hooks: z.array(z.string()).default([]),
  claude_hooks: z.any().optional(),
  harness: HarnessSchema,
  teams: TeamsSchema,
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type Config = ConfigFile & {
  /** Resolved absolute paths to worker hook scripts */
  _resolved_pre_hooks: string[];
  _resolved_post_hooks: string[];
  /** Directory containing the config file (for resolving relative paths) */
  _config_dir: string;
  /** Vault root directory (repo.path or derived from config location) */
  _vault_root: string;
};

/**
 * Resolve a hook name to an absolute script path.
 * Looks in hooks/worker/ relative to the vault root (repo.path or config dir parent).
 */
function resolveHookPaths(hookNames: string[], vaultRoot: string): string[] {
  return hookNames.map((name) => {
    // If already an absolute path or command, pass through
    if (name.startsWith("/") || name.includes(" ")) return name;
    // Resolve to hooks/worker/{name}.sh
    return resolve(vaultRoot, "hooks", "worker", `${name}.sh`);
  });
}

export function loadConfig(filePath: string): Config {
  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;
  const configDir = dirname(resolve(filePath));

  // Backward compat: map `claude` key to `executor` with type "claude"
  if (raw.claude && !raw.executor) {
    raw.executor = { ...(raw.claude as Record<string, unknown>), type: "claude" };
    delete raw.claude;
  }

  const parsed = ConfigFileSchema.parse(raw);

  // Determine vault root for hook resolution
  const vaultRoot = parsed.repo?.path || resolve(configDir, "..", "..");

  // Read frontmatter overrides from SOUL.md if agent.soul is set
  if (parsed.agent?.soul) {
    try {
      const soulPath = resolve(vaultRoot, parsed.agent.soul);
      const soulText = readFileSync(soulPath, "utf-8");
      const fmMatch = soulText.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
        // Apply frontmatter overrides
        if (fm.agent_label && typeof fm.agent_label === "string") {
          parsed.github.agent_label = fm.agent_label;
        }
        if (fm.poll_interval_seconds && typeof fm.poll_interval_seconds === "number") {
          parsed.github.poll_interval_seconds = fm.poll_interval_seconds;
        }
        if (fm.model && typeof fm.model === "string") {
          parsed.executor.model = fm.model;
        }
        if (fm.timeout_seconds && typeof fm.timeout_seconds === "number") {
          parsed.executor.timeout_seconds = fm.timeout_seconds;
        }
        if (fm.max_turns && typeof fm.max_turns === "number") {
          parsed.executor.max_turns = fm.max_turns;
        }
        if (fm.retries != null && typeof fm.retries === "number") {
          parsed.executor.retries = fm.retries;
        }
        if (fm.enable_teams != null) {
          if (!parsed.teams) parsed.teams = { enable_agent_teams: false, max_teammates: 0 };
          parsed.teams.enable_agent_teams = !!fm.enable_teams;
        }
        if (fm.max_teammates != null && typeof fm.max_teammates === "number") {
          if (!parsed.teams) parsed.teams = { enable_agent_teams: false, max_teammates: 0 };
          parsed.teams.max_teammates = fm.max_teammates;
        }
      }
    } catch {
      // SOUL.md not found or unreadable — use worker.yaml values
    }
  }

  return {
    ...parsed,
    _resolved_pre_hooks: resolveHookPaths(parsed.worker_pre_hooks, vaultRoot),
    _resolved_post_hooks: resolveHookPaths(parsed.worker_post_hooks, vaultRoot),
    _config_dir: configDir,
    _vault_root: vaultRoot,
  };
}
