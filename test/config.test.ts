import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("loadConfig", () => {
  const validYaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
repo:
  path: "/tmp/repo"
`;

  test("parses valid config with defaults", () => {
    const config = loadConfig(writeConfig(validYaml));

    expect(config.github.repo).toBe("getmora/Agent-Team");
    expect(config.github.agent_label).toBe("agent:marketing");
    expect(config.github.poll_interval_seconds).toBe(60);
    expect(config.repo.path).toBe("/tmp/repo");
    expect(config.hooks.pre).toEqual([]);
    expect(config.hooks.post).toEqual([]);
    expect(config.executor.type).toBe("claude");
    expect(config.executor.timeout_seconds).toBe(300);
    expect(config.executor.retries).toBe(0);
    expect(config.log.level).toBe("info");
  });

  test("parses config with all fields set", () => {
    const fullYaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:ceo"
  poll_interval_seconds: 30
repo:
  path: "/home/user/project"
hooks:
  pre:
    - "git pull"
    - "git checkout -b feature"
  post:
    - "npm test"
executor:
  type: claude
  timeout_seconds: 600
  retries: 2
log:
  file: "./test.log"
`;
    const config = loadConfig(writeConfig(fullYaml));

    expect(config.github.repo).toBe("getmora/Agent-Team");
    expect(config.github.agent_label).toBe("agent:ceo");
    expect(config.github.poll_interval_seconds).toBe(30);
    expect(config.hooks.pre).toEqual(["git pull", "git checkout -b feature"]);
    expect(config.hooks.post).toEqual(["npm test"]);
    expect(config.executor.type).toBe("claude");
    expect(config.executor.timeout_seconds).toBe(600);
    expect(config.executor.retries).toBe(2);
    expect(config.log.file).toBe("./test.log");
  });

  test("parses config with codex executor", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:visual"
repo:
  path: "/tmp/repo"
executor:
  type: codex
  timeout_seconds: 120
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.executor.type).toBe("codex");
    expect(config.executor.timeout_seconds).toBe(120);
  });

  test("backward compat: maps claude key to executor", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
repo:
  path: "/tmp/repo"
claude:
  timeout_seconds: 600
  retries: 2
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.executor.type).toBe("claude");
    expect(config.executor.timeout_seconds).toBe(600);
    expect(config.executor.retries).toBe(2);
  });

  test("throws on missing repo (github.repo)", () => {
    const yaml = `
github:
  agent_label: "agent:marketing"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing agent_label", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing github block entirely", () => {
    const yaml = `
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing repo path", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects retries greater than 3", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
repo:
  path: "/tmp/repo"
executor:
  retries: 5
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects negative poll interval", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
  poll_interval_seconds: -1
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("parses full worker.yaml format with agent, hooks, harness, teams", () => {
    const yaml = `
agent:
  name: HeadOfMarketing
  soul: agents/HeadOfMarketing/SOUL.md
  heartbeat: agents/HeadOfMarketing/HEARTBEAT.md
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
  poll_interval_seconds: 3600
repo:
  path: "/tmp/repo"
executor:
  type: claude
  model: claude-sonnet-4-6
  timeout_seconds: 600
  retries: 1
  max_turns: 50
worker_pre_hooks:
  - inject-agent-context
worker_post_hooks:
  - commit-outputs
  - validate-outputs
  - report-to-issue
harness:
  max_phase_retries: 3
teams:
  enable_agent_teams: true
  max_teammates: 5
  teammate_model: claude-sonnet-4-6
`;
    const config = loadConfig(writeConfig(yaml));

    expect(config.agent?.name).toBe("HeadOfMarketing");
    expect(config.agent?.soul).toBe("agents/HeadOfMarketing/SOUL.md");
    expect(config.executor.model).toBe("claude-sonnet-4-6");
    expect(config.executor.max_turns).toBe(50);
    expect(config.worker_pre_hooks).toEqual(["inject-agent-context"]);
    expect(config.worker_post_hooks).toEqual(["commit-outputs", "validate-outputs", "report-to-issue"]);
    expect(config._resolved_pre_hooks.length).toBe(1);
    expect(config._resolved_pre_hooks[0]).toContain("inject-agent-context.sh");
    expect(config._resolved_post_hooks.length).toBe(3);
    expect(config.harness?.max_phase_retries).toBe(3);
    expect(config.teams?.enable_agent_teams).toBe(true);
    expect(config.teams?.max_teammates).toBe(5);
    expect(config.teams?.teammate_model).toBe("claude-sonnet-4-6");
  });

  test("worker hooks resolve to hooks/worker/*.sh paths", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
repo:
  path: "/my/vault"
worker_pre_hooks:
  - inject-agent-context
worker_post_hooks:
  - commit-outputs
`;
    const config = loadConfig(writeConfig(yaml));

    expect(config._resolved_pre_hooks[0]).toBe("/my/vault/hooks/worker/inject-agent-context.sh");
    expect(config._resolved_post_hooks[0]).toBe("/my/vault/hooks/worker/commit-outputs.sh");
  });

  test("absolute paths and commands pass through hook resolution", () => {
    const yaml = `
github:
  repo: "getmora/Agent-Team"
  agent_label: "agent:marketing"
repo:
  path: "/tmp/repo"
worker_pre_hooks:
  - /usr/local/bin/my-hook.sh
  - echo hello world
`;
    const config = loadConfig(writeConfig(yaml));

    expect(config._resolved_pre_hooks[0]).toBe("/usr/local/bin/my-hook.sh");
    expect(config._resolved_pre_hooks[1]).toBe("echo hello world");
  });
});
