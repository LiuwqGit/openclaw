import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { markRuntimeCompactionDelegate } from "../../context-engine/compaction-watchdog.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { registerAgentHarness, resolveHostByteAuthority } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import { consumeHostByteClaim, setHostByteClaim } from "./transcript-byte-preflight-authority.js";

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

type ConsumeOverrides = {
  lockedHarnessRuntime?: string;
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
  preflightRequired?: boolean;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  trigger?: "budget" | "overflow" | "manual";
};

describe("host transcript-byte preflight authority", () => {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let registry = createEmptyPluginRegistry();
  let authority: NonNullable<ReturnType<typeof resolveHostByteAuthority>>;

  beforeEach(() => {
    snapshot = captureActivePluginRegistrySnapshot();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
    withPluginRegistrationContext(registry, "codex", () => {
      registerAgentHarness(makeCodexHarness(), { nativeCompaction });
    });
    authority = expectDefined(
      resolveHostByteAuthority("codex"),
      "Codex transcript-byte preflight authority",
    );
  });

  afterEach(() => {
    restoreActivePluginRegistrySnapshot(snapshot);
  });

  const consume = (
    runtimeContext: ContextEngineRuntimeContext,
    {
      lockedHarnessRuntime = "codex",
      sessionTarget: target = sessionTarget,
      ...overrides
    }: ConsumeOverrides = {},
  ) =>
    Boolean(
      consumeHostByteClaim(
        {
          contextEngineRuntimeContext: runtimeContext,
          preflightCompactionTrigger: "transcript_bytes",
          preflightRequired: true,
          trigger: "budget",
          ...overrides,
        },
        target,
        lockedHarnessRuntime,
      ),
    );

  it("consumes the exact claim once and clears its scope", () => {
    const runtimeContext = { sessionTarget };
    const clearClaim = setHostByteClaim(runtimeContext, authority, compact);
    expect(consume(runtimeContext)).toBe(true);
    expect(consume(runtimeContext)).toBe(false);
    clearClaim?.();
    expect(consume(runtimeContext)).toBe(false);
  });

  it.each([
    ["missing claim", {}],
    [
      "forged public properties",
      {
        hostOwnsTranscriptBytePreflight: true,
        preflightCompactionTrigger: "transcript_bytes",
        preflightRequired: true,
      },
    ],
  ])("rejects %s", (_case, runtimeContext) => {
    expect(consume(runtimeContext)).toBe(false);
  });

  const rejectedClaims: Array<{
    name: string;
    compact?: ContextEngine["compact"];
    consume?: ConsumeOverrides;
    mutate?: () => void;
  }> = [
    { name: "wrong agent", consume: { sessionTarget: { ...sessionTarget, agentId: "other" } } },
    {
      name: "wrong session",
      consume: { sessionTarget: { ...sessionTarget, sessionId: "session-2" } },
    },
    {
      name: "wrong key",
      consume: { sessionTarget: { ...sessionTarget, sessionKey: "agent:main:session-2" } },
    },
    {
      name: "wrong store",
      consume: { sessionTarget: { ...sessionTarget, storePath: "/tmp/other.json" } },
    },
    { name: "wrong owner", consume: { lockedHarnessRuntime: "openclaw" } },
    { name: "optional", consume: { preflightRequired: undefined } },
    { name: "token", consume: { preflightCompactionTrigger: "tokens" } },
    { name: "manual", consume: { trigger: "manual" } },
    { name: "custom engine", compact: vi.fn<ContextEngine["compact"]>() },
    {
      name: "replacement",
      mutate: () => {
        withPluginRegistrationContext(registry, "codex", () => {
          registerAgentHarness(authority.harness, {
            nativeCompaction: authority.nativeCompaction,
          });
        });
      },
    },
    { name: "retirement", mutate: () => markPluginRegistryRetired(registry) },
  ];

  it.each(rejectedClaims)(
    "rejects $name claims",
    ({ compact: candidate, consume: input, mutate }) => {
      const runtimeContext = { sessionTarget };
      const clearClaim = setHostByteClaim(runtimeContext, authority, candidate ?? compact);
      mutate?.();
      expect(consume(runtimeContext, input)).toBe(false);
      clearClaim?.();
    },
  );

  it("clears an unconsumed claim", () => {
    const runtimeContext = { sessionTarget };
    setHostByteClaim(runtimeContext, authority, compact)?.();
    expect(consume(runtimeContext)).toBe(false);
  });
});
