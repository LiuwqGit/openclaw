// Regression tests for requester yield claims: isolated automation (cron)
// requesters must be rejected before yield intent is recorded (#135282).
// The registry-backed tests exercise the real production registry with no
// mocks: the completion-required child row is the exact state that the
// pre-fix claim path accepted (proven by the control test below), and the
// assembled tool must reject the yield without touching it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Mirrors the production constant in openclaw-tools.requester-yield.ts, which
// stays module-local so the public tool surface does not grow (#135282).
const ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR =
  "Isolated automation turns do not support sessions_yield because no continuation owner resumes this session. Keep required child work bounded in this turn; spawned descendants deliver output through the scheduler-owned completion wait.";

const CRON_RUN_KEY = "agent:main:cron:daily-report:run:run-42";

// The reported #135282 state: a running, completion-required child whose
// completion is owned by the isolated automation turn. `expectsCompletionMessage`
// is what markRequesterTurnYieldedInRuns selects on, so this fixture — and only
// this shape — reproduces the pre-fix accepted-yield failure.
function seedCompletionRequiredCronChild(): void {
  addSubagentRunForTests({
    runId: "run-child",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: CRON_RUN_KEY,
    requesterAgentId: "main",
    requesterTurnRunId: "run-requester",
    requesterDisplayKey: "cron:daily-report",
    task: "child work",
    cleanup: "keep",
    createdAt: 1_000,
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    execution: { status: "running" },
  });
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
  });
}

function expectToolNamed(
  tools: ReturnType<typeof createOpenClawTools>,
  name: string,
): ReturnType<typeof createOpenClawTools>[number] {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected tool ${name} to be registered`);
  }
  return tool;
}

describe("createRequesterYieldCallback isolated automation rejection", () => {
  it("rejects a cron requester with the unsupported-lifecycle error", async () => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);

    try {
      const claim = createRequesterYieldCallback({
        requesterSessionKey: CRON_RUN_KEY,
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });

      expect(await claim?.()).toEqual({
        error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR,
      });
      expect(markRequesterTurnYielded).not.toHaveBeenCalled();
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });

  it("rejects a cron requester even when no other claim source exists", async () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: "agent:main:cron:daily-report",
      requesterAgentId: "main",
    });

    expect(await claim?.()).toEqual({
      error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR,
    });
  });

  it("still records yield intent for an ordinary requester", async () => {
    const registry = await import("./subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);

    try {
      const claim = createRequesterYieldCallback({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });

      await expect(claim?.()).resolves.toBe(true);
      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterTurnRunId: "run-requester",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});

describe("sessions_yield isolated automation ownership", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  // Control experiment: this exact fixture is the state the pre-fix claim path
  // accepted. If this stops holding, the regression test below would pass for
  // the wrong reason (an unclaimable row), so pin the claimability here.
  it("marks the completion-required cron child as the pre-fix accepted-yield state", () => {
    seedCompletionRequiredCronChild();
    const childRun = getSubagentRunByRunId("run-child") as SubagentRunRecord;
    expect(childRun.expectsCompletionMessage).toBe(true);

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

  // Real registry, real tool assembly, no mocks: the isolated automation turn
  // owns a genuinely pending completion-required child, and the rejection must
  // leave the run record free of any yield intent or settle-wake state.
  it("rejects an isolated automation requester and records no yield intent in the real registry", async () => {
    seedCompletionRequiredCronChild();
    const onYield = vi.fn(async () => undefined);

    const tool = expectToolNamed(
      createTestOpenClawTools({
        agentSessionKey: "agent:main:telegram:default:direct:1234",
        runSessionKey: CRON_RUN_KEY,
        sessionId: "cron-requester-session",
        runId: "run-requester",
        onYield,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      }),
      "sessions_yield",
    );

    const result = await tool.execute("yield-cron-requester", {});

    expect(result.details).toMatchObject({
      status: "error",
      error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR,
    });
    expect(onYield).not.toHaveBeenCalled();

    const childRun = getSubagentRunByRunId("run-child");
    expect(childRun).toBeDefined();
    // The turn still owns its pending child completion; no durable yield intent
    // or settle-wake handoff may exist after the rejection.
    expect(childRun?.requesterTurnYielded).toBeUndefined();
    expect(childRun?.requesterSettleWake).toBeUndefined();
    expect(childRun?.requesterTurnRunId).toBe("run-requester");
    expect(childRun?.execution.status).toBe("running");
  });
});
