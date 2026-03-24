import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createGitHubProvider } from "../src/providers/github.ts";

// Helper to mock Bun.spawn
function mockSpawn(responses: Array<{ stdout: string; stderr: string; exitCode: number }>) {
  let callIndex = 0;
  return spyOn(Bun, "spawn").mockImplementation((() => {
    const resp = responses[callIndex] ?? { stdout: "", stderr: "no mock", exitCode: 1 };
    callIndex++;
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(resp.stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(resp.stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(resp.exitCode),
    };
  }) as any);
}

describe("GitHubProvider", () => {
  let spawnSpy: ReturnType<typeof mockSpawn>;

  afterEach(() => {
    spawnSpy?.mockRestore();
  });

  describe("fetchReadyTickets", () => {
    test("returns issues matching agent label", () => {
      const issues = [
        { number: 1, title: "Task A", body: "Do A", labels: [{ name: "agent:marketing" }] },
        { number: 2, title: "Task B", body: "Do B", labels: [{ name: "agent:marketing" }] },
      ];
      spawnSpy = mockSpawn([{ stdout: JSON.stringify(issues), stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.fetchReadyTickets().then((tickets) => {
        expect(tickets).toHaveLength(2);
        expect(tickets[0].id).toBe("1");
        expect(tickets[0].title).toBe("Task A");
        expect(tickets[0].description).toBe("Do A");
        expect(tickets[1].id).toBe("2");
      });
    });

    test("excludes issues with done label", () => {
      const issues = [
        { number: 1, title: "Task A", body: "Do A", labels: [{ name: "agent:marketing" }] },
        { number: 2, title: "Done Task", body: "", labels: [{ name: "agent:marketing" }, { name: "done" }] },
      ];
      spawnSpy = mockSpawn([{ stdout: JSON.stringify(issues), stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.fetchReadyTickets().then((tickets) => {
        expect(tickets).toHaveLength(1);
        expect(tickets[0].title).toBe("Task A");
      });
    });

    test("excludes issues with needs-approval label", () => {
      const issues = [
        { number: 1, title: "Pending", body: "", labels: [{ name: "agent:marketing" }, { name: "needs-approval" }] },
      ];
      spawnSpy = mockSpawn([{ stdout: JSON.stringify(issues), stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.fetchReadyTickets().then((tickets) => {
        expect(tickets).toHaveLength(0);
      });
    });

    test("handles empty result set gracefully", () => {
      spawnSpy = mockSpawn([{ stdout: "[]", stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.fetchReadyTickets().then((tickets) => {
        expect(tickets).toHaveLength(0);
      });
    });

    test("excludes in-progress and failed issues", () => {
      const issues = [
        { number: 1, title: "WIP", body: "", labels: [{ name: "agent:marketing" }, { name: "in-progress" }] },
        { number: 2, title: "Failed", body: "", labels: [{ name: "agent:marketing" }, { name: "failed" }] },
        { number: 3, title: "Ready", body: "Go", labels: [{ name: "agent:marketing" }] },
      ];
      spawnSpy = mockSpawn([{ stdout: JSON.stringify(issues), stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.fetchReadyTickets().then((tickets) => {
        expect(tickets).toHaveLength(1);
        expect(tickets[0].title).toBe("Ready");
      });
    });
  });

  describe("transitionStatus", () => {
    test("adds in-progress label when claiming", () => {
      spawnSpy = mockSpawn([{ stdout: "", stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.transitionStatus("42", "in-progress").then(() => {
        const args = (spawnSpy.mock.calls[0] as any)[0];
        expect(args).toContain("--add-label");
        expect(args).toContain("in-progress");
      });
    });

    test("removes in-progress and adds done when completing", () => {
      spawnSpy = mockSpawn([{ stdout: "", stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.transitionStatus("42", "done").then(() => {
        const args = (spawnSpy.mock.calls[0] as any)[0];
        expect(args).toContain("--remove-label");
        expect(args).toContain("in-progress");
        expect(args).toContain("--add-label");
        expect(args).toContain("done");
      });
    });

    test("adds failed label on failure", () => {
      spawnSpy = mockSpawn([
        { stdout: "", stderr: "", exitCode: 0 }, // remove in-progress
        { stdout: "", stderr: "", exitCode: 0 }, // add failed
      ]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.transitionStatus("42", "failed").then(() => {
        const secondArgs = (spawnSpy.mock.calls[1] as any)[0];
        expect(secondArgs).toContain("--add-label");
        expect(secondArgs).toContain("failed");
      });
    });
  });

  describe("postComment", () => {
    test("posts comment on correct issue", () => {
      spawnSpy = mockSpawn([{ stdout: "", stderr: "", exitCode: 0 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.postComment("42", "## Done\n\nTask completed.").then(() => {
        const args = (spawnSpy.mock.calls[0] as any)[0];
        expect(args).toContain("issue");
        expect(args).toContain("comment");
        expect(args).toContain("42");
        expect(args).toContain("--body-file");
      });
    });

    test("handles markdown with backticks and special chars", () => {
      spawnSpy = mockSpawn([{ stdout: "", stderr: "", exitCode: 0 }]);

      const body = "## Output\n\n```typescript\nconst x = `hello ${world}`;\n```";
      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return provider.postComment("99", body).then(() => {
        const args = (spawnSpy.mock.calls[0] as any)[0];
        expect(args).toContain("--body-file");
        // Using body-file means special chars are safely written to temp file
      });
    });

    test("throws on gh failure", () => {
      spawnSpy = mockSpawn([{ stdout: "", stderr: "not found", exitCode: 1 }]);

      const provider = createGitHubProvider({ repo: "getmora/Agent-Team", agentLabel: "agent:marketing" });
      return expect(provider.postComment("42", "test")).rejects.toThrow("Failed to post comment");
    });
  });
});
