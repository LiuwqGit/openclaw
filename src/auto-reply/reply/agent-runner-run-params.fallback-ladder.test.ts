// Reply preparation must route spawn-owned children to the subagent fallback
// ladder even when the stored entry carries no effective model override.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

function makeRun(overrides: Partial<FollowupRun["run"]>): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "main",
    provider: "openai",
    model: "gpt-global-primary",
    requestedRouteResolution: "resolved",
    agentDir: "/tmp/agent",
    sessionKey: "agent:main:dashboard:spawned",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  } as unknown as FollowupRun["run"];
}

const inheritedPrimaryConfig: OpenClawConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-global-primary",
        fallbacks: ["openai/gpt-global-fallback"],
      },
      subagents: { model: { fallbacks: [] } },
    },
    list: [{ id: "main" }],
  },
};

describe("resolveModelFallbackOptions for spawn-owned children", () => {
  it("keeps an explicitly empty subagent ladder when the primary is inherited", () => {
    const resolved = resolveModelFallbackOptions(
      makeRun({
        config: inheritedPrimaryConfig,
        // `agents.defaults.model` is not a configured subagent selection, so the
        // stored entry has no origin metadata and reads back as no override.
        hasSessionModelOverride: false,
        modelOverrideSource: undefined,
        subagentSpawnLineage: true,
      }),
    );

    expect(resolved.modelFallbackAvailability).toEqual({
      kind: "none_configured",
      source: "explicit",
    });
    expect(resolved.fallbacksOverride).toEqual([]);
  });

  it("keeps a distinct subagent ladder when the primary is inherited", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-global-primary",
            fallbacks: ["openai/gpt-global-fallback"],
          },
          subagents: { model: { fallbacks: ["custom/subagent-backup"] } },
        },
        list: [{ id: "main" }],
      },
    };

    const resolved = resolveModelFallbackOptions(
      makeRun({
        config,
        hasSessionModelOverride: false,
        modelOverrideSource: undefined,
        subagentSpawnLineage: true,
      }),
    );

    expect(resolved.fallbacksOverride).toEqual(["custom/subagent-backup"]);
  });

  it("leaves ordinary dashboard sessions on the inherited global ladder", () => {
    const resolved = resolveModelFallbackOptions(
      makeRun({
        config: inheritedPrimaryConfig,
        sessionKey: "agent:main:dashboard:operator",
        hasSessionModelOverride: false,
        modelOverrideSource: undefined,
      }),
    );

    expect(resolved.modelFallbackAvailability).toEqual({
      kind: "active",
      models: ["openai/gpt-global-fallback"],
      source: "inherited",
    });
    // Inherited availability projects to `undefined` so the candidate resolver
    // still appends the configured primary as the final hop.
    expect(resolved.fallbacksOverride).toBeUndefined();
  });
});
