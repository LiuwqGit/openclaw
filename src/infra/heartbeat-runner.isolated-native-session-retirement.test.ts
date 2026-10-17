import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarness, AgentHarnessResetParams } from "../agents/harness/types.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { buildChannelOutboundSessionRoute } from "../plugin-sdk/core.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
  type HeartbeatReplySpy,
} from "./heartbeat-runner.test-utils.js";

type MockDeliveryRequest = {
  channel?: string;
  to?: string;
  payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
};

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn(async (_request: MockDeliveryRequest) => [{ channel: "whatsapp", messageId: "msg-1" }]),
);

// mock-isolation: heartbeat delivery must not perform real channel sends; only the mocked replies are observed
vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: heartbeatRunnerWhatsAppPlugin, source: "test" },
    ]),
  );
});

function installWhatsAppRoute() {
  const plugin: ChannelPlugin = {
    ...heartbeatRunnerWhatsAppPlugin,
    capabilities: {
      ...heartbeatRunnerWhatsAppPlugin.capabilities,
      chatTypes: ["direct"],
    },
    messaging: {
      ...heartbeatRunnerWhatsAppPlugin.messaging,
      targetResolver: { looksLikeId: () => true },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) =>
        buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: "whatsapp",
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: target },
          chatType: "direct",
          from: target,
          to: target,
        }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]));
}

/** A native thread binding persisted by a completed run, as the Codex binding store does. */
type FakeNativeBinding = { threadId: string };

type NativeOwnershipRead = {
  sessionId: string;
  sessionKey: string;
  previousSessionId?: string;
};

/**
 * Registers a native-thread-shaped harness that mirrors the Codex app-server
 * binding contract: bindings persist per session identity, the reset hook
 * clears the identity's binding, and a later generation adopts a predecessor
 * binding through previousSessionId lineage.
 */
function registerNativeThreadHarness(): {
  seedNativeBinding: (sessionKey: string, sessionId: string, threadId: string) => void;
  nativeBindings: ReadonlyMap<string, FakeNativeBinding>;
  resetCalls: readonly AgentHarnessResetParams[];
  /** Native ownership resolution exactly as the harness answers it in production. */
  resolveOwnership: (read: NativeOwnershipRead) => "native" | "none";
} {
  const bindings = new Map<string, FakeNativeBinding>();
  const resetCalls: AgentHarnessResetParams[] = [];
  const bindingKey = (sessionKey: string, sessionId: string) => `${sessionKey}:${sessionId}`;
  const findBinding = ({ sessionId, sessionKey, previousSessionId }: NativeOwnershipRead) =>
    bindings.get(bindingKey(sessionKey, sessionId)) ??
    (previousSessionId ? bindings.get(bindingKey(sessionKey, previousSessionId)) : undefined);
  const harness: AgentHarness = {
    id: "fake-native-thread",
    label: "fake-native-thread",
    supports: () => ({ supported: false }),
    async runAttempt() {
      throw new Error("not used");
    },
    async reset(params: AgentHarnessResetParams) {
      resetCalls.push(params);
      if (params.sessionId) {
        bindings.delete(
          bindingKey(params.sessionKey ?? params.sessionFile ?? "", params.sessionId),
        );
      }
    },
    resolveSessionRuntimeOwnership({
      sessionId,
      sessionKey,
      readPreviousSessionId,
    }): { model: "native"; auth: "host" } | undefined {
      const binding = findBinding({
        sessionId,
        sessionKey: sessionKey ?? "",
        previousSessionId: readPreviousSessionId?.(),
      });
      return binding ? { model: "native", auth: "host" } : undefined;
    },
  };
  registerAgentHarness(harness);
  return {
    seedNativeBinding: (sessionKey, sessionId, threadId) =>
      bindings.set(bindingKey(sessionKey, sessionId), { threadId }),
    nativeBindings: bindings,
    resetCalls,
    resolveOwnership: (read) => (findBinding(read) ? "native" : "none"),
  };
}

type RetirementFixture = {
  storePath: string;
  baseKey: string;
  isolatedKey: string;
  replySpy: HeartbeatReplySpy;
  seedNativeBinding: (sessionKey: string, sessionId: string, threadId: string) => void;
  nativeBindings: ReadonlyMap<string, FakeNativeBinding>;
  resetCalls: readonly AgentHarnessResetParams[];
  resolveOwnership: (read: NativeOwnershipRead) => "native" | "none";
  run: () => Promise<Awaited<ReturnType<typeof runHeartbeatOnce>>>;
};

async function withRetirementFixture(
  fn: (fixture: RetirementFixture) => Promise<void>,
  options: { seedIsolatedEntry?: boolean; isolatedSession?: boolean } = {},
) {
  installWhatsAppRoute();
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg = heartbeatTestConfig(tmpDir, "last", "whatsapp", storePath);
    cfg.agents!.defaults!.heartbeat!.isolatedSession = options.isolatedSession ?? true;
    cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
    const baseKey = resolveMainSessionKey(cfg);
    const isolatedKey = `${baseKey}:heartbeat`;
    const targetKey = "agent:main:whatsapp:direct:+15551234567";
    const nowMs = Date.now();
    const delivery = {
      updatedAt: nowMs - 1000,
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+15551234567",
    };
    await seedSessionStore(storePath, baseKey, { ...delivery, sessionId: "base-session" });
    await seedSessionStore(storePath, targetKey, {
      ...delivery,
      sessionId: "target-session",
      lifecycleRevision: "target-lifecycle-1",
    });
    if (options.seedIsolatedEntry !== false) {
      await seedSessionStore(storePath, isolatedKey, {
        ...delivery,
        sessionId: "isolated-generation-1",
        updatedAt: nowMs - 60_000,
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
    }
    replySpy.mockResolvedValueOnce({ text: "ok" });
    const native = registerNativeThreadHarness();
    const run = async () => {
      const result = await runHeartbeatOnce({
        cfg,
        deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => nowMs },
      });
      if (result.status === "failed") {
        throw new Error(`heartbeat failed: ${result.reason}`);
      }
      return result;
    };
    await fn({
      storePath,
      baseKey,
      isolatedKey,
      replySpy,
      seedNativeBinding: native.seedNativeBinding,
      nativeBindings: native.nativeBindings,
      resetCalls: native.resetCalls,
      resolveOwnership: native.resolveOwnership,
      run,
    });
  });
}

describe("runHeartbeatOnce - isolated heartbeat native session retirement", () => {
  it("retires the predecessor's persisted native binding before rolling the isolated session", async () => {
    await withRetirementFixture(
      async ({
        storePath,
        baseKey,
        isolatedKey,
        replySpy,
        seedNativeBinding,
        nativeBindings,
        resetCalls,
        resolveOwnership,
        run,
      }) => {
        // The predecessor generation finished with a persisted native binding.
        seedNativeBinding(isolatedKey, "isolated-generation-1", "thread-generation-1");

        await expect(run()).resolves.toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledOnce();

        // The rollover notified the harness to retire the predecessor generation.
        expect(resetCalls).toEqual([
          {
            agentId: "main",
            sessionId: "isolated-generation-1",
            sessionKey: isolatedKey,
            sessionFile: isolatedKey,
            reason: "new",
          },
        ]);

        // The retirement reached persisted binding state, not just a notification.
        expect(nativeBindings.has(`${isolatedKey}:isolated-generation-1`)).toBe(false);

        const store = readSessionStoreForTest(storePath);
        const rolledEntry = store[isolatedKey];
        expect(rolledEntry?.sessionId).toBeTruthy();
        expect(rolledEntry?.sessionId).not.toBe("isolated-generation-1");
        expect(rolledEntry?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
        // Lineage survives the rollover exactly as before, so usage attribution
        // and transcript history keep working with entries persisted pre-upgrade.
        expect(rolledEntry?.previousSessionId).toBe("isolated-generation-1");

        // Adoption contract: with the predecessor binding retired, the fresh
        // generation resolves no native ownership even through lineage, so the
        // harness must start a new native thread instead of resuming
        // thread-generation-1.
        expect(
          resolveOwnership({
            sessionId: rolledEntry!.sessionId!,
            sessionKey: isolatedKey,
            previousSessionId: rolledEntry?.previousSessionId,
          }),
        ).toBe("none");
      },
    );
  });

  it("does not retire a native session when the isolated heartbeat has no predecessor entry", async () => {
    await withRetirementFixture(
      async ({ storePath, baseKey, isolatedKey, replySpy, resetCalls, run }) => {
        await expect(run()).resolves.toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledOnce();
        expect(resetCalls).toEqual([]);

        const store = readSessionStoreForTest(storePath);
        expect(store[isolatedKey]?.sessionId).toBeTruthy();
        expect(store[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
      },
      { seedIsolatedEntry: false },
    );
  });

  it("keeps native session continuity for non-isolated heartbeats", async () => {
    await withRetirementFixture(
      async ({ baseKey, replySpy, seedNativeBinding, resetCalls, resolveOwnership, run }) => {
        seedNativeBinding(baseKey, "base-session", "thread-base");
        await expect(run()).resolves.toMatchObject({ status: "ran" });
        expect(replySpy).toHaveBeenCalledOnce();
        expect(resetCalls).toEqual([]);
        // The continuing session still owns its native binding and thread.
        expect(resolveOwnership({ sessionId: "base-session", sessionKey: baseKey })).toBe("native");
      },
      { isolatedSession: false },
    );
  });
});
