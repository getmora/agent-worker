import { describe, test, expect } from "bun:test";
import { processTicket } from "../src/scheduler.ts";
import type { Ticket, TicketProvider } from "../src/providers/types.ts";
import type { CodeExecutor } from "../src/pipeline/executor.ts";
import type { Config } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ticket: Ticket = {
  id: "42",
  identifier: "42",
  title: "Test ticket",
  description: "Do something",
};

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    github: {
      repo: "getmora/Agent-Team",
      agent_label: "agent:marketing",
      poll_interval_seconds: 10,
    },
    repo: { path: "/tmp" },
    hooks: { pre: [], post: [] },
    executor: { type: "claude", timeout_seconds: 5, retries: 0 },
    log: { level: "info" },
    worker_pre_hooks: [],
    worker_post_hooks: [],
    _resolved_pre_hooks: [],
    _resolved_post_hooks: [],
    _config_dir: "/tmp",
    ...overrides,
  };
}

function makeProvider(overrides?: Partial<TicketProvider>): {
  provider: TicketProvider;
  transitions: string[];
  comments: string[];
} {
  const transitions: string[] = [];
  const comments: string[] = [];
  return {
    transitions,
    comments,
    provider: {
      fetchReadyTickets: async () => [],
      transitionStatus: async (_id, status) => {
        transitions.push(status);
      },
      postComment: async (_id, body) => {
        comments.push(body);
      },
      ...overrides,
    },
  };
}

function mockExecutor(result: Partial<{ success: boolean; output: string }>): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: false,
    run: async () => ({
      success: result.success ?? true,
      output: result.output ?? "mock output",
      timedOut: false,
      exitCode: result.success === false ? 1 : 0,
    }),
  };
}

describe("processTicket", () => {
  test("skips processing when claim fails", async () => {
    const { provider, transitions } = makeProvider({
      transitionStatus: async (_id, status) => {
        if (status === "in-progress") throw new Error("Already claimed");
        transitions.push(status);
      },
    });

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      logger: noopLogger,
      executor: mockExecutor({ success: true }),
    });

    expect(transitions).toEqual([]);
  });

  test("transitions to failed when pipeline fails", async () => {
    const { provider, transitions, comments } = makeProvider();

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ hooks: { pre: ["exit 1"], post: [] } }),
      logger: noopLogger,
      executor: mockExecutor({ success: true }),
    });

    expect(transitions).toContain("in-progress");
    expect(transitions).toContain("failed");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("Agent Worker Failure");
    expect(comments[0]).toContain("pre-hook");
  });

  test("transitions to done and posts comment on success", async () => {
    const { provider, transitions, comments } = makeProvider();

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      logger: noopLogger,
      executor: mockExecutor({ success: true, output: "all done" }),
    });

    expect(transitions).toContain("in-progress");
    expect(transitions).toContain("done");
    expect(transitions).not.toContain("failed");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("Agent Worker Completed");
    expect(comments[0]).toContain("all done");
  });

  test("executor is called during pipeline execution", async () => {
    let executorCallCount = 0;
    const { provider } = makeProvider();

    const countingExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        executorCallCount++;
        return { success: true, output: "ok", timedOut: false, exitCode: 0 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      logger: noopLogger,
      executor: countingExecutor,
    });

    expect(executorCallCount).toBe(1);
  });

  test("retries executor on failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const { provider, transitions } = makeProvider();

    const flakyExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: false, output: "transient error", timedOut: false, exitCode: 1 };
        }
        return { success: true, output: "recovered", timedOut: false, exitCode: 0 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ executor: { type: "claude", timeout_seconds: 5, retries: 1 } }),
      logger: noopLogger,
      executor: flakyExecutor,
    });

    expect(callCount).toBe(2);
    expect(transitions).toContain("done");
    expect(transitions).not.toContain("failed");
  });

  test("transitions to failed after all retries exhausted", async () => {
    let callCount = 0;
    const { provider, transitions, comments } = makeProvider();

    const alwaysFailingExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        callCount++;
        return { success: false, output: "always fails", timedOut: false, exitCode: 1 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ executor: { type: "claude", timeout_seconds: 5, retries: 2 } }),
      logger: noopLogger,
      executor: alwaysFailingExecutor,
    });

    // retries: 2 means 3 total attempts (attempt 0, 1, 2)
    expect(callCount).toBe(3);
    expect(transitions).toContain("failed");
    expect(transitions).not.toContain("done");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("Agent Worker Failure");
  });
});
