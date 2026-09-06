// Nested (subagent) requester settle-wake coverage: a yielded batch must reach
// one internal continuation instead of being cleared undispatched. The
// top-level requester drain gating lives in
// subagent-announce.requester-settle-wake.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const deliverSpy = vi.fn(
  async (
    _params: Record<string, unknown>,
  ): Promise<{ delivered: boolean; path: string; disposition?: string; reason?: string }> => ({
    delivered: true,
    path: "direct",
  }),
);

let sessionStore: Record<string, { sessionId?: string }>;

const { registryRuntimeMock, descendantWakeSpy, replaceRunStub } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countActiveDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    countPendingDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    isSubagentSessionRunActive: vi.fn((_childSessionKey: string) => true),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn((_childSessionKey: string) => false),
    hasDescendantRunAwaitingSettle: vi.fn(
      (_rootSessionKey: string, _excludeRunId?: string) => false,
    ),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(
      (
        _childSessionKey: string,
      ): Pick<SubagentRunRecord, "runId" | "requesterSessionKey"> | undefined => undefined,
    ),
    getLatestLiveSubagentRunByChildSessionKey: vi.fn(
      (
        _childSessionKey: string,
        _matches?: (entry: SubagentRunRecord) => boolean,
      ): Pick<SubagentRunRecord, "runId" | "childSessionKey" | "task" | "label"> | null => null,
    ),
    resolveRequesterForChildSession: vi.fn((_childSessionKey: string) => null),
  },
  descendantWakeSpy: vi.fn(async () => true),
  replaceRunStub: vi.fn(() => true),
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);

vi.mock("./subagent-announce-descendant-wake.js", () => ({
  runDescendantWake: descendantWakeSpy,
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: vi.fn(() => undefined),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: sessionStore[sessionKey],
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

import { testing as subagentAnnounceTesting } from "./subagent-announce.js";
import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

type SubagentRegistryRuntime = typeof import("../registry/subagent-registry-runtime.js");

const NESTED_REQUESTER = "agent:main:subagent:middle";

function makeSettledChild(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-leaf";
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: NESTED_REQUESTER,
    requesterDisplayKey: "middle",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...overrides,
  } as SubagentRunRecord;
}

/** The reported composition: an explicit yield batch over one settled child. */
function makeYieldedChild(overrides?: Partial<SubagentRunRecord>): SubagentRunRecord {
  return makeSettledChild({
    delivery: { status: "pending", disposition: "intentional_non_delivery" },
    completion: { required: true, resultText: "leaf findings" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      batchRunIds: ["run-leaf"],
      requesterYieldBatch: true,
      afterRequesterYield: true,
      rearmGeneration: 1,
    },
    ...overrides,
  });
}

const transitionBatchSpy = vi.fn();
const completeBatchSpy = vi.fn();

function transitionBatch(
  batch: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
): void {
  transitionBatchSpy(batch.map((entry) => entry.runId).toSorted(), state);
  for (const entry of batch) {
    if (entry.requesterSettleWake) {
      entry.requesterSettleWake = { ...state };
    }
  }
}

function completeBatch(
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
): void {
  const runIds = batch.map((entry) => entry.runId).toSorted();
  if (outcome) {
    completeBatchSpy(runIds, rearmGeneration, outcome);
  } else if (rearmGeneration === undefined) {
    completeBatchSpy(runIds);
  } else {
    completeBatchSpy(runIds, rearmGeneration);
  }
  for (const entry of batch) {
    if (entry.requesterSettleWake?.rearmGeneration === rearmGeneration) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function wakeParams(settledEntry: SubagentRunRecord) {
  return {
    requesterSessionKey: NESTED_REQUESTER,
    settledEntry,
    transitionBatch,
    completeBatch,
  };
}

function continuationArg(): Record<string, unknown> {
  const call = descendantWakeSpy.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected a nested requester continuation");
  }
  return call as unknown as Record<string, unknown>;
}

describe("maybeWakeRequesterAfterAllChildrenSettled (nested requester)", () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    transitionBatchSpy.mockClear();
    completeBatchSpy.mockClear();
    descendantWakeSpy.mockReset().mockResolvedValue(true);
    replaceRunStub.mockClear();
    sessionStore = { [NESTED_REQUESTER]: { sessionId: "sess-middle" } };
    registryRuntimeMock.countActiveDescendantRuns.mockReset().mockReturnValue(0);
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockReset().mockReturnValue(null);
    subagentAnnounceTesting.setDepsForTest({
      loadSubagentRegistryRuntime: (async () => ({
        replaceSubagentRunAfterSteer: replaceRunStub,
      })) as unknown as () => Promise<SubagentRegistryRuntime>,
    });
  });

  it("wakes a yielded nested requester through one internal continuation", async () => {
    registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-middle",
      childSessionKey: NESTED_REQUESTER,
      task: "synthesize the leaf result",
    });
    const child = makeYieldedChild();
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child));

    expect(woke).toBe(true);
    expect(descendantWakeSpy).toHaveBeenCalledOnce();
    expect(continuationArg().runId).toBe("run-middle");
    expect(continuationArg().childSessionKey).toBe(NESTED_REQUESTER);
    expect(String(continuationArg().findings)).toContain("leaf findings");
    // The nested continuation owns this wake; the top-level dispatcher stays out.
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenCalledWith(
      ["run-leaf"],
      expect.objectContaining({ status: "dispatching", attemptCount: 1 }),
    );
    // Completion ownership clears only after the recorded continuation outcome.
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-leaf"], 1, {
      delivered: true,
      path: "direct",
    });
    expect(child.requesterSettleWake).toBeUndefined();
  });

  it("keeps a yielded nested batch pending when its paused requester row is gone", async () => {
    const child = makeYieldedChild();
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child));

    expect(woke).toBe(false);
    expect(descendantWakeSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
    // Not silently dropped: the batch keeps its retry budget instead of clearing.
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenLastCalledWith(
      ["run-leaf"],
      expect.objectContaining({ status: "pending", attemptCount: 1 }),
    );
    expect(child.requesterSettleWake).toMatchObject({ rearmGeneration: 1 });
  });

  it("records a bounded outcome when the continuation cannot be adopted", async () => {
    registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockReturnValue({
      runId: "run-middle",
      childSessionKey: NESTED_REQUESTER,
      task: "synthesize the leaf result",
    });
    descendantWakeSpy.mockResolvedValue(false);
    const child = makeYieldedChild();
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child));

    expect(woke).toBe(false);
    expect(descendantWakeSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenLastCalledWith(
      ["run-leaf"],
      expect.objectContaining({
        status: "pending",
        attemptCount: 1,
        lastError: "nested requester yield continuation was not adopted",
      }),
    );
  });

  it("still leaves an ordinary nested wave to the descendant-settle wake", async () => {
    // No yield markers: two drained children of a nested orchestrator.
    const children = ["run-a", "run-b"].map((runId) =>
      makeSettledChild({ runId, requesterSessionKey: NESTED_REQUESTER }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams(children[1]!));

    expect(woke).toBe(false);
    expect(descendantWakeSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-a", "run-b"]);
  });
});
