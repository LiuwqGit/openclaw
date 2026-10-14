import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { threadStartResult as createThreadStartResult } from "./codex-app-server.test-fixtures.js";
import { DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT } from "./run-attempt.context-engine.test-support.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams as createThreadLifecycleParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThreadWithoutSkills as startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-thread-adoption-");
let tempDir: string;

function threadStartResult(threadId = "thread-1") {
  return createThreadStartResult(threadId, tempDir);
}

function createThreadLifecycleAppServerOptions(): ReturnType<typeof createAppServerOptions> {
  return {
    ...createAppServerOptions(),
    connectionClass: "local-loopback",
  };
}

function readEmptyNativeConfig(method: string) {
  if (method === "config/read") {
    return { config: {}, origins: {}, layers: [] };
  }
  if (method === "configRequirements/read") {
    return { requirements: null };
  }
  throw new Error(`unexpected method: ${method}`);
}

async function seedAdoptedThreadBinding(params: EmbeddedRunAttemptParams, cwd: string) {
  const threadId = "thread-adopted";
  const request = vi.fn(async (method: string) => {
    if (method === "thread/start") {
      return threadStartResult(threadId);
    }
    return readEmptyNativeConfig(method);
  });
  await startOrResumeThread({
    client: { request } as never,
    params,
    cwd,
    dynamicTools: [],
    appServer: createThreadLifecycleAppServerOptions(),
  });
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const patched = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "patch",
    threadId,
    patch: {
      model: undefined,
      modelProvider: undefined,
      preserveNativeModel: true,
    },
  });
  if (!patched) {
    throw new Error("failed to seed adopted Codex thread binding");
  }
  return { identity, threadId };
}

describe("Codex app-server adopted thread lifecycle", () => {
  beforeEach(() => {
    tempDir = tempDirs.make();
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  it.each(["native-tools", "delegation"] as const)(
    "preserves expected native ownership instead of starting a fresh %s-restricted thread",
    async (restriction) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const nativeModel = threadStartResult(threadId);
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { model: nativeModel.model, modelProvider: nativeModel.modelProvider },
      });
      params.expectedSessionRuntimeOwnership = {
        model: "native",
        auth: "host",
        modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
      };
      if (restriction === "delegation") {
        params.delegationCapability = "report_only";
      }
      const before = testCodexAppServerBindingStore.read(identity);
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        persistedThreads: [threadId],
        respond: readEmptyNativeConfig,
      });
      try {
        await expect(
          startOrResumeThread({
            client: fixture.client,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
            ...(restriction === "native-tools" ? { nativeCodeModeEnabled: false } : {}),
          }),
        ).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
        expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(
          false,
        );
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
      } finally {
        fixture.client.close();
      }
    },
  );

  it("preserves the cold native thread after host rotation with changed tools", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const storePath = path.join(tempDir, "sessions.json");
    params.config = { session: { store: storePath } };
    const scope = { agentId: "main", sessionKey: params.sessionKey!, storePath };
    await upsertSessionEntry({ ...scope, entry: { sessionId: params.sessionId, updatedAt: 1 } });
    const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
    const nativeModel = threadStartResult(threadId);
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "patch",
      threadId,
      patch: { model: nativeModel.model, modelProvider: nativeModel.modelProvider },
    });
    params.expectedSessionRuntimeOwnership = {
      model: "native",
      auth: "host",
      modelRef: { model: nativeModel.model, provider: nativeModel.modelProvider },
    };
    const before = testCodexAppServerBindingStore.read(identity);
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: "compacted-successor" }) });
    params.sessionId = "compacted-successor";
    const successor = { ...identity, sessionId: params.sessionId };
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      persistedThreads: [threadId],
      respond: (method) => {
        if (method === "thread/resume") {
          return nativeModel;
        }
        return readEmptyNativeConfig(method);
      },
    });
    const resuming = startOrResumeThread({
      client: fixture.client,
      signal: new AbortController().signal,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        { type: "function", name: "new_tool", description: "New tool", inputSchema: {} },
      ],
      appServer: createThreadLifecycleAppServerOptions(),
    });
    await expect(resuming).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message: expect.stringContaining("changing the dynamic tool catalog"),
    });
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(testCodexAppServerBindingStore.read(successor)).toEqual(before);
    expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
  });

  it.each([
    { status: "active", canAcceptDirectInput: true, error: "active in another runner" },
    { status: "idle", canAcceptDirectInput: false, error: "controlled by its parent" },
  ])(
    "preserves retained adopted ownership when native preflight rejects: $error",
    async ({ status, canAcceptDirectInput, error }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const params = createThreadLifecycleParams(sessionFile, workspaceDir);
      const { identity, threadId } = await seedAdoptedThreadBinding(params, workspaceDir);
      const harness = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond: readEmptyNativeConfig,
      });
      harness.seed(
        {
          ...threadStartResult(threadId),
          thread: {
            ...(threadStartResult(threadId).thread as object),
            status: { type: status },
            canAcceptDirectInput,
          },
        },
        { loaded: true, subscribed: true },
      );
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: workspaceDir });
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "patch",
        threadId,
        patch: { clientId: harness.client.getInstanceId() },
      });
      const release = vi.fn();
      await retainCodexAppServerLiveThread(harness.client, threadId, release);
      const reserveResumeThread = vi.fn(() => ({ release: vi.fn() }));
      const before = testCodexAppServerBindingStore.read(identity);
      try {
        await expect(
          startOrResumeThread({
            client: harness.client,
            reserveResumeThread,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer: createThreadLifecycleAppServerOptions(),
          }),
        ).rejects.toThrow(error);

        expect(harness.request.mock.calls.map(([method]) => method)).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/read",
        ]);
        expect(release).not.toHaveBeenCalled();
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        expect(reserveResumeThread).not.toHaveBeenCalled();
        const retryOwnership = await consumeCodexAppServerLiveThread(harness.client, threadId);
        expect(retryOwnership).toBeDefined();
        expect(() => retryOwnership?.assertCurrent()).not.toThrow();
        await retryOwnership?.release(threadId);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        harness.client.close();
      }
    },
  );

  it("resumes a settled failed thread after zero-delay unload while a sibling stays active", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const threadId = "thread-settled-failed";
    const siblingId = "thread-active-sibling";
    type LifecycleHarness = Awaited<ReturnType<typeof createLeasedCodexLifecycleHarness>>;
    const wire: { current?: LifecycleHarness } = {};
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        return readEmptyNativeConfig(method);
      },
      unsubscribe: (releasedThreadId) => {
        // A zero-delay server finishes this unload just after the response.
        setTimeout(() => {
          wire.current?.notify({
            method: "thread/status/changed",
            params: { threadId: releasedThreadId, status: { type: "notLoaded" } },
          });
        }, 0);
        return { status: "notLoaded" };
      },
    });
    wire.current = fixture;
    const settled = threadStartResult(threadId);
    fixture.seed(
      { ...settled, thread: { ...settled.thread, status: { type: "systemError" } } },
      { loaded: true, subscribed: true },
    );
    const siblingResponse = threadStartResult(siblingId);
    fixture.seed(
      {
        ...siblingResponse,
        thread: { ...siblingResponse.thread, status: { type: "active", activeFlags: [] } },
      },
      { loaded: true, subscribed: true },
    );
    const identity = sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.config,
    });
    expect(
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId,
          cwd: workspaceDir,
          webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
        },
      }),
    ).toBe(true);
    await retainCodexAppServerLiveThread(fixture.client, threadId);
    const siblingClient = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
    const siblingClaim = await claimCodexAppServerLiveThread(siblingClient, siblingId);
    try {
      expect(siblingClaim).toBeDefined();
      const resumed = await startOrResumeThread({
        client: fixture.client,
        params,
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createThreadLifecycleAppServerOptions(),
          start: {
            ...createThreadLifecycleAppServerOptions().start,
            commandSource: "managed",
            homeScope: "agent",
            args: ["app-server", "-c", "thread_unload_delay_secs=0"],
          },
        },
        developerInstructions: "changed policy after the settled failure",
      });
      expect(resumed).toMatchObject({ threadId, lifecycle: { action: "resumed" } });
      const methods = fixture.request.mock.calls.map(([method]) => method as string);
      const unsubscribeIndex = methods.indexOf("thread/unsubscribe");
      expect(unsubscribeIndex).toBeGreaterThanOrEqual(0);
      expect(methods.lastIndexOf("thread/resume")).toBeGreaterThan(unsubscribeIndex);
      expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
      expect(() => siblingClaim!.assertCurrent()).not.toThrow();
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      await siblingClaim?.release(siblingId);
      releaseLeasedSharedCodexAppServerClient(siblingClient);
    }
  });

  it("keeps refusing a settled failed thread without managed zero-delay unload", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createThreadLifecycleParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const threadId = "thread-settled-failed-no-delay";
    const siblingId = "thread-active-sibling-no-delay";
    const fixture = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "agent"),
      respond: async (method) => {
        if (method === "thread/resume") {
          return threadStartResult(threadId);
        }
        return readEmptyNativeConfig(method);
      },
    });
    const settled = threadStartResult(threadId);
    fixture.seed(
      { ...settled, thread: { ...settled.thread, status: { type: "systemError" } } },
      { loaded: true, subscribed: true },
    );
    const siblingResponse = threadStartResult(siblingId);
    fixture.seed(
      {
        ...siblingResponse,
        thread: { ...siblingResponse.thread, status: { type: "active", activeFlags: [] } },
      },
      { loaded: true, subscribed: true },
    );
    const identity = sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.config,
    });
    expect(
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId,
          cwd: workspaceDir,
          webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
        },
      }),
    ).toBe(true);
    await retainCodexAppServerLiveThread(fixture.client, threadId);
    const siblingClient = await getLeasedSharedCodexAppServerClient(fixture.acquireOptions);
    const siblingClaim = await claimCodexAppServerLiveThread(siblingClient, siblingId);
    try {
      expect(siblingClaim).toBeDefined();
      await expect(
        startOrResumeThread({
          client: fixture.client,
          params,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          developerInstructions: "changed policy after the settled failure",
        }),
      ).rejects.toThrow("did not confirm unloading its previous configuration");
      expect(fixture.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
      expect(() => siblingClaim!.assertCurrent()).not.toThrow();
      expect(fixture.client.getCloseError()).toBeUndefined();
    } finally {
      await siblingClaim?.release(siblingId);
      releaseLeasedSharedCodexAppServerClient(siblingClient);
    }
  });
});
