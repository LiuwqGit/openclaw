import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let buildHealthAgentSummaries: typeof import("./collector.js").buildHealthAgentSummaries;
let resolveHealthAgentOrder: typeof import("./collector.js").resolveHealthAgentOrder;

/** Wraps `agents.entries` in a counting getter (test-local instrumentation). */
function countRosterReads(config: OpenClawConfig): () => number {
  const agents = (config as { agents: Record<string, unknown> }).agents;
  const entries = agents.entries;
  let reads = 0;
  Object.defineProperty(agents, "entries", {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return entries;
    },
  });
  return () => reads;
}

describe("health heartbeat roster scaling (#137570)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(vi.fn());

  beforeAll(async () => {
    // Store paths reach real SQLite target resolution, which inspects the
    // agent database beside them; keep the projection hermetic instead.
    const sessionStorePath = path.join(
      tempDirs.make("openclaw-health-roster-sessions-"),
      "sessions.json",
    );
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../../config/sessions/session-accessor.js", () => ({
      readSessionStoreSummaryReadOnly: () => ({ count: 0, recent: [], byAgent: new Map() }),
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => [],
    }));
    const health = await import("./collector.js");
    buildHealthAgentSummaries = health.buildHealthAgentSummaries;
    resolveHealthAgentOrder = health.resolveHealthAgentOrder;
  });

  it("resolves the heartbeat roster once per health collection on large fleets", async () => {
    // 300 heartbeat-enabled agents previously re-walked the full roster per
    // agent through resolveHeartbeatSummaryForAgent -> resolveHeartbeatAgents
    // -> resolveAgentConfig -> resolveAgentEntry (O(agents²) entry
    // resolutions per health tick, all synchronous), blocking the event loop
    // long enough for /health probes to time out. One collection must read
    // the roster a bounded number of times instead of once per agent.
    const agentCount = 300;
    const entries: Record<string, { heartbeat?: { every: string } }> = {};
    for (let i = 0; i < agentCount; i++) {
      entries[`agent-${i}`] = { heartbeat: { every: "5m" } };
    }
    const cfg = {
      agents: {
        ownership: "explicit",
        entries,
        defaults: { heartbeat: { every: "6m" } },
      },
    } as OpenClawConfig;

    const order = resolveHealthAgentOrder(cfg);
    const rosterReads = countRosterReads(cfg);

    const agents = await buildHealthAgentSummaries(cfg, order);

    expect(agents).toHaveLength(agentCount);
    expect(agents.every((agent) => agent.heartbeat.enabled)).toBe(true);
    expect(rosterReads()).toBeLessThanOrEqual(16);
  });
});
