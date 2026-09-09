import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { markRequesterTurnYieldedInRuns } from "./subagents/registry/subagent-registry-requester-yield.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const CRON_RUN_KEY = "agent:main:cron:daily-report:run:run-42";

function seedRequiredChild(requesterSessionKey = CRON_RUN_KEY): SubagentRunRecord {
  const run: SubagentRunRecord = {
    runId: "run-child",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: "run-requester",
    task: "child work",
    cleanup: "keep",
    createdAt: 1_000,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running" },
  };
  addSubagentRunForTests(run);
  return run;
}

function createTestOpenClawTools(
  options: NonNullable<Parameters<typeof createOpenClawTools>[0]> = {},
) {
  return createOpenClawTools({
    ...options,
    config: {
      ...options.config,
      agents: options.config?.agents ?? { entries: { main: { default: true } } },
    } satisfies OpenClawConfig,
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
  });
}

describe("requester yield ownership", () => {
  beforeEach(() => resetSubagentRegistryForTests({ persist: false }));
  afterEach(() => resetSubagentRegistryForTests({ persist: false }));

  it("models an owned child the old cron claim could mark", () => {
    const childRun = seedRequiredChild();
    const marked = markRequesterTurnYieldedInRuns({
      requesterSessionKey: CRON_RUN_KEY,
      requesterAgentId: "main",
      requesterTurnRunId: "run-requester",
      runs: new Map([[childRun.runId, childRun]]),
      persistOrThrow: () => {},
    });

    expect(marked).toBe(1);
    expect(childRun.requesterTurnYielded).toBe(true);
  });

  it.each([CRON_RUN_KEY, "agent:main:cron:daily-report"])(
    "rejects %s before runtime claim, durable intent, or runtime yield",
    async (requesterSessionKey) => {
      seedRequiredChild(requesterSessionKey);
      const before = structuredClone(getSubagentRunByRunId("run-child"));
      const runtimeClaim = vi.fn(() => true);
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "requester-session",
        claimYield: createRequesterYieldCallback({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: "run-requester",
          claimYieldCompletion: runtimeClaim,
        }),
        onYield,
      });

      const result = await tool.execute("yield-call", {});

      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("no requester continuation"),
      });
      expect(runtimeClaim).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
      expect(getSubagentRunByRunId("run-child")).toEqual(before);
    },
  );

  it("rejects a cron requester without another claim source", async () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: CRON_RUN_KEY,
      requesterAgentId: "main",
    });
    expect(await claim?.()).toEqual({
      error: expect.stringContaining("no requester continuation"),
    });
  });

  it("omits yield for the execution identity and leaves its child owned", () => {
    seedRequiredChild();
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const tools = createTestOpenClawTools({
      agentSessionKey: "agent:main:telegram:default:direct:1234",
      runSessionKey: CRON_RUN_KEY,
      sessionId: "cron-requester-session",
      runId: "run-requester",
      onYield: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });

  it("omits yield when only the controller identity is cron", () => {
    const tools = createTestOpenClawTools({
      agentSessionKey: "agent:main:cron:daily-report",
      sessionId: "cron-controller-session",
      runId: "run-requester",
    });
    expect(tools.map((tool) => tool.name)).not.toContain("sessions_yield");
  });

  it.each([
    "agent:main:telegram:default:direct:1234",
    "agent:main:subagent:worker",
    "agent:main:main",
  ])("preserves assembled owned yield for %s", async (agentSessionKey) => {
    seedRequiredChild(agentSessionKey);
    const onYield = vi.fn(() => {
      expect(getSubagentRunByRunId("run-child")?.requesterTurnYielded).toBe(true);
    });
    const tool = createTestOpenClawTools({
      agentSessionKey,
      sessionId: "requester-session",
      runId: "run-requester",
      onYield,
    }).find((candidate) => candidate.name === "sessions_yield");
    assert.isDefined(tool);

    expect((await tool.execute("yield-call", {})).details).toMatchObject({ status: "yielded" });
    expect(onYield).toHaveBeenCalledOnce();
  });

  it.each([
    { requesterSessionKey: "agent:main:main", runtimeClaim: true, accepted: true },
    { requesterSessionKey: "agent:main:subagent:worker", runtimeClaim: false, accepted: true },
    { requesterSessionKey: "agent:main:main", runtimeClaim: false, accepted: false },
  ])(
    "preserves claim without a registry child: $requesterSessionKey/$runtimeClaim",
    async (test) => {
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "requester-session",
        claimYield: createRequesterYieldCallback({
          requesterSessionKey: test.requesterSessionKey,
          requesterAgentId: "main",
          claimYieldCompletion: () => test.runtimeClaim,
        }),
        onYield,
      });
      expect((await tool.execute("yield-call", {})).details).toMatchObject({
        status: test.accepted ? "yielded" : "error",
      });
      expect(onYield).toHaveBeenCalledTimes(test.accepted ? 1 : 0);
    },
  );

  it("does not persist or yield after a runtime claim failure", async () => {
    seedRequiredChild("agent:main:main");
    const before = structuredClone(getSubagentRunByRunId("run-child"));
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "requester-session",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
        claimYieldCompletion: () => {
          throw new Error("runtime claim failed");
        },
      }),
      onYield,
    });
    await expect(tool.execute("yield-call", {})).rejects.toThrow("runtime claim failed");
    expect(onYield).not.toHaveBeenCalled();
    expect(getSubagentRunByRunId("run-child")).toEqual(before);
  });
});
