// Regression coverage for #128755: the all-agent Sessions dashboard must
// attribute durable (store-backed) session rows to their stored owning agent,
// not to a subagent that reused the parent sessionId in discovery.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
    session: {},
  })),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: vi.fn(actual.loadGatewaySessionEntryReadOnly),
    loadCombinedSessionStoreForGatewayCore: vi.fn(() => ({
      durableTargets: [],
      storePath: "(multiple)",
      store: {},
    })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    resolveExistingUsageSessionFile: vi.fn(actual.resolveExistingUsageSessionFile),
    discoverAllSessions: vi.fn(async () => []),
    loadSessionCostSummariesFromCache: vi.fn(async (params: { sessions: unknown[] }) => ({
      summaries: params.sessions.map(() => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        totalCost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 0,
      })),
      cacheStatus: {
        status: "fresh",
        cachedFiles: params.sessions.length,
        pendingFiles: 0,
        staleFiles: 0,
      },
    })),
  };
});

import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  resolveExistingUsageSessionFile,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGatewayCore } from "../session-utils.js";
import { testApi, usageHandlers } from "./usage.js";

const TEST_RUNTIME_CONFIG = {
  agents: { list: [{ id: "main", default: true }, { id: "opus" }] },
  session: {},
} as OpenClawConfig;

const BASE_USAGE_RANGE = { startDate: "2026-02-01", endDate: "2026-02-02", limit: 10 } as const;

async function runSessionsUsage(params: Record<string, unknown>) {
  const respond = vi.fn();
  await expectDefined(
    usageHandlers["sessions.usage"],
    'usageHandlers["sessions.usage"] test invariant',
  )({
    respond,
    params,
    context: { getRuntimeConfig: () => TEST_RUNTIME_CONFIG },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

function expectSuccessfulSessionsUsage(
  respond: ReturnType<typeof vi.fn>,
): Array<{ key: string; agentId: string }> {
  expect(respond).toHaveBeenCalledTimes(1);
  const call = expectDefined(respond.mock.calls[0], "sessions.usage respond call");
  expect(call[0]).toBe(true);
  const result = expectDefined(call[1], "sessions.usage result") as {
    sessions: Array<{ key: string; agentId: string }>;
  };
  return result.sessions;
}

const STORE_KEY = "agent:main:telegram:dm";
const SESSION_ID = "tg-dm-session";

describe("sessions.usage owner attribution (#128755)", () => {
  beforeEach(() => {
    testApi.sessionsUsageCache.clear();
    vi.clearAllMocks();
  });

  it("attributes a named session to its store owner when a subagent reuses its sessionId", async () => {
    // After spawning a subagent from a Telegram DM session, the all-agent
    // Sessions dashboard labeled the durable row with the subagent's id instead
    // of the owning agent. Discovery surfaces both the owner transcript and the
    // reused subagent transcript under the same sessionId; the durable store row
    // must win attribution.
    vi.mocked(discoverAllSessions)
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/main/sessions/${SESSION_ID}.jsonl`,
          mtime: 100,
        },
      ])
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/opus/sessions/${SESSION_ID}.jsonl`,
          mtime: 200,
        },
      ]);
    vi.mocked(resolveExistingUsageSessionFile).mockImplementationOnce(
      (params) =>
        `sqlite:${params.agentId}:${params.sessionId}:/tmp/agents/${params.agentId}/openclaw-agent.sqlite`,
    );
    vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
      durableTargets: [],
      storePath: "(multiple)",
      store: {
        [STORE_KEY]: {
          sessionId: SESSION_ID,
          sessionFile: `${SESSION_ID}.jsonl`,
          label: "Telegram DM",
          updatedAt: 1_500,
        },
      },
    });

    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentScope: "all" });
    const sessions = expectSuccessfulSessionsUsage(respond);
    // The reused subagent transcript must not duplicate or shadow the owner row.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe(STORE_KEY);
    expect(sessions[0]?.agentId).toBe("main");
    // Usage must be loaded under the owner agent, not the spawned subagent.
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: SESSION_ID,
            sessionFile: expect.stringContaining("sqlite:main:"),
          }),
        ]),
      }),
    );
    // The subagent transcript reuse must not produce an opus-attributed load.
    expect(
      vi
        .mocked(loadSessionCostSummariesFromCache)
        .mock.calls.some((call) => call[0]?.agentId === "opus"),
    ).toBe(false);
  });

  it("does not fall back to a subagent transcript when the owner transcript is absent", async () => {
    // Cross-agent fallback finding on #128755: when owner transcript resolution
    // returns no file, the durable row stays attributed to the owner with no
    // usage rather than load the subagent's reused transcript under another agent.
    vi.mocked(discoverAllSessions)
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/main/sessions/${SESSION_ID}.jsonl`,
          mtime: 100,
        },
      ])
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/opus/sessions/${SESSION_ID}.jsonl`,
          mtime: 200,
        },
      ]);
    // Owner transcript cannot be resolved (cold/stale cache).
    vi.mocked(resolveExistingUsageSessionFile).mockImplementationOnce(() => undefined);
    vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
      durableTargets: [],
      storePath: "(multiple)",
      store: {
        [STORE_KEY]: {
          sessionId: SESSION_ID,
          sessionFile: `${SESSION_ID}.jsonl`,
          label: "Telegram DM",
          updatedAt: 1_500,
        },
      },
    });

    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentScope: "all" });
    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe(STORE_KEY);
    expect(sessions[0]?.agentId).toBe("main");
    // No transcript is loaded for any agent: the owner file is absent and the
    // subagent's reused transcript must not be substituted.
    expect(vi.mocked(loadSessionCostSummariesFromCache)).not.toHaveBeenCalled();
  });

  it("ignores a store entry marker whose agent differs from the resolved owner", async () => {
    // Regression for the marker-ownership finding on #128755: a store entry
    // marker reusing the sessionId under a different agent must not be
    // substituted for the owner's transcript.
    const opusMarker = `sqlite:opus:${SESSION_ID}:/tmp/agents/opus/openclaw-agent.sqlite`;
    vi.mocked(discoverAllSessions)
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/main/sessions/${SESSION_ID}.jsonl`,
          mtime: 100,
        },
      ])
      .mockResolvedValueOnce([
        {
          sessionId: SESSION_ID,
          sessionFile: `/tmp/agents/opus/sessions/${SESSION_ID}.jsonl`,
          mtime: 200,
        },
      ]);
    // The store entry carries an opus marker reusing this sessionId. The
    // resolver now validates the entry marker's agentId against the requested
    // owner internally (collection.ts), so an opus marker is ignored and the
    // owner (main) file is returned instead.
    vi.mocked(resolveExistingUsageSessionFile).mockImplementationOnce((params) =>
      params.agentId === "main"
        ? `sqlite:main:${params.sessionId}:/tmp/agents/main/openclaw-agent.sqlite`
        : opusMarker,
    );
    vi.mocked(loadCombinedSessionStoreForGatewayCore).mockReturnValue({
      durableTargets: [],
      storePath: "(multiple)",
      store: {
        [STORE_KEY]: {
          sessionId: SESSION_ID,
          sessionFile: opusMarker,
          label: "Telegram DM",
          updatedAt: 1_500,
        },
      },
    });

    const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, agentScope: "all" });
    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe(STORE_KEY);
    expect(sessions[0]?.agentId).toBe("main");
    // The opus marker must not be substituted: usage loads under main with a
    // main-owned session file.
    expect(vi.mocked(loadSessionCostSummariesFromCache)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: SESSION_ID,
            sessionFile: expect.stringContaining("sqlite:main:"),
          }),
        ]),
      }),
    );
    expect(
      vi
        .mocked(loadSessionCostSummariesFromCache)
        .mock.calls.some((call) => call[0]?.agentId === "opus"),
    ).toBe(false);
  });
});
