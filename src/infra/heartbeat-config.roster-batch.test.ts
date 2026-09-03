import { describe, expect, it } from "vitest";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatAgents } from "./heartbeat-config.js";

describe("heartbeat enrollment batch memoization (#137570)", () => {
  it("reuses one enrollment resolution per roster batch", () => {
    const cfg = {
      agents: { entries: { main: { heartbeat: { every: "5m" } }, ops: {} } },
    } as OpenClawConfig;

    withAgentRosterFactsBatch(cfg, () => {
      // Health and status summaries resolve enrollment once per configured
      // agent; a batch must reuse the memoized resolution instead of
      // re-walking the roster per agent.
      expect(resolveHeartbeatAgents(cfg)).toBe(resolveHeartbeatAgents(cfg));
    });

    // Outside a batch every call resolves the enrollment directly again.
    expect(resolveHeartbeatAgents(cfg)).not.toBe(resolveHeartbeatAgents(cfg));
  });

  it("observes roster mutations made between batches", () => {
    const cfg = {
      agents: { entries: { main: { heartbeat: { every: "5m" } } } },
    } as OpenClawConfig;

    expect(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId)).toEqual(["main"]);

    const roster = (cfg as { agents: { entries: Record<string, unknown> } }).agents.entries;
    roster.ops = { heartbeat: { every: "5m" } };

    expect(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId)).toEqual(["main", "ops"]);
  });
});
