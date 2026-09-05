import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { markRuntimeCompactionDelegate } from "../../context-engine/compaction-watchdog.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { registerAgentHarness } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import {
  consumeTranscriptBytePreflightClaim,
  resolveTranscriptBytePreflightAuthority,
  setTranscriptBytePreflightClaim,
} from "./transcript-byte-preflight-authority.js";

const sessionTarget: SessionTranscriptRuntimeTarget = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  storePath: "/tmp/sessions.json",
};
const compact = markRuntimeCompactionDelegate(
  vi.fn<ContextEngine["compact"]>(async () => ({ ok: true, compacted: true })),
);

function makeCodexHarness(): AgentHarness {
  return {
    id: "codex",
    label: "Codex",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("not used");
    },
  };
}

describe("transcript-byte preflight authority", () => {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let registry = createEmptyPluginRegistry();
  let authority: NonNullable<ReturnType<typeof resolveTranscriptBytePreflightAuthority>>;

  beforeEach(() => {
    snapshot = captureActivePluginRegistrySnapshot();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    withPluginRegistrationContext(registry, "codex", () => {
      registerAgentHarness(makeCodexHarness(), {
        nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
      });
    });
    const harness = expectDefined(registry.agentHarnesses[0]?.harness, "registered Codex harness");
    authority = expectDefined(
      resolveTranscriptBytePreflightAuthority(harness),
      "transcript-byte preflight authority",
    );
  });

  afterEach(() => {
    restoreActivePluginRegistrySnapshot(snapshot);
  });

  function consume(
    runtimeContext: ContextEngineRuntimeContext,
    overrides: {
      lockedHarnessRuntime?: string;
      sessionTarget?: SessionTranscriptRuntimeTarget;
      preflightRequired?: boolean;
      preflightCompactionTrigger?: "tokens" | "transcript_bytes";
    } = {},
  ) {
    return consumeTranscriptBytePreflightClaim(
      {
        contextEngineRuntimeContext: runtimeContext,
        preflightRequired: overrides.preflightRequired ?? true,
        preflightCompactionTrigger: overrides.preflightCompactionTrigger ?? "transcript_bytes",
        trigger: "budget",
      },
      overrides.sessionTarget ?? sessionTarget,
      overrides.lockedHarnessRuntime ?? "codex",
    );
  }

  it("consumes the exact runtime-delegate claim once", () => {
    const runtimeContext = { sessionTarget };
    const clearClaim = setTranscriptBytePreflightClaim(runtimeContext, authority, compact);

    expect(consume(runtimeContext)).toBe(authority);
    expect(consume(runtimeContext)).toBeUndefined();
    clearClaim();
  });

  it.each([
    ["forged public state", { hostOwnsTranscriptBytePreflight: true }],
    ["wrong owner", {}, { lockedHarnessRuntime: "openclaw" }],
    ["wrong target", {}, { sessionTarget: { ...sessionTarget, sessionId: "session-2" } }],
    ["token trigger", {}, { preflightCompactionTrigger: "tokens" as const }],
  ])("rejects %s", (_name, runtimeContext, overrides = {}) => {
    setTranscriptBytePreflightClaim(runtimeContext, authority, compact);
    expect(consume(runtimeContext, overrides)).toBeUndefined();
  });

  it("rejects claims from a custom context engine", () => {
    const runtimeContext = { sessionTarget };
    setTranscriptBytePreflightClaim(runtimeContext, authority, vi.fn());
    expect(consume(runtimeContext)).toBeUndefined();
  });
});
