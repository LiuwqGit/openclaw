// Covers isolated heartbeat rollover archival of the previous wake transcript (#131770).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

/**
 * Test-controlled gate around the rollover lifecycle mutation: the first
 * matching call is held before it reaches the storage writer lane, so a second
 * overlapping wake can run its own rollover first. This reproduces the
 * interleaving where both wakes observe the same predecessor generation
 * (#131770).
 */
const lifecycleMutationGate = vi.hoisted(() => ({
  shouldHold: null as ((params: { activeSessionKey?: string }) => boolean) | null,
  entered: false,
  held: false,
  release: null as (() => void) | null,
}));

/** Session work admission leases held by tests; released after each test. */
const releaseLeases: Array<() => void> = [];

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    applySessionEntryLifecycleMutation: async (
      params: Parameters<typeof actual.applySessionEntryLifecycleMutation>[0],
    ) => {
      if (lifecycleMutationGate.shouldHold?.(params) && !lifecycleMutationGate.held) {
        lifecycleMutationGate.held = true;
        lifecycleMutationGate.entered = true;
        await new Promise<void>((resolve) => {
          lifecycleMutationGate.release = resolve;
        });
      }
      return await actual.applySessionEntryLifecycleMutation(params);
    },
  };
});

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
  lifecycleMutationGate.shouldHold = null;
  lifecycleMutationGate.entered = false;
  lifecycleMutationGate.held = false;
  lifecycleMutationGate.release = null;
  for (const release of releaseLeases.splice(0)) {
    try {
      release();
    } catch {
      // A lease may already be released when its run finished.
    }
  }
});

function makeIsolatedLastTargetConfig(tmpDir: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          isolatedSession: true,
        },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

describe("runHeartbeatOnce - isolated heartbeat transcript rollover", () => {
  it("archives the previous isolated wake transcript instead of orphaning it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "previous-wake.jsonl");
      await fs.writeFile(
        transcriptPath,
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      replySpy.mockResolvedValueOnce({ text: "All good." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      const store = readSessionStoreForTest<{ sessionId?: string }>(storePath);
      expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
      // The replaced transcript must not stay behind as an unreferenced primary
      // file; it is archived alongside other lifecycle artifacts.
      const remaining = await fs.readdir(sessionsDir);
      expect(remaining).not.toContain("previous-wake.jsonl");
      expect(remaining.some((name) => name.startsWith("previous-wake.jsonl."))).toBe(true);
    });
  });

  it("warns per failed transcript rename and still completes the rollover", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "previous-wake.jsonl");
      await fs.writeFile(
        transcriptPath,
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      replySpy.mockResolvedValueOnce({ text: "All good." });
      // Force a deterministic rename failure independent of user privileges:
      // pin the archive timestamp and pre-create the archive target as a
      // directory, so renameSync(file -> directory) fails with EISDIR. The
      // per-file error callback must surface that failure instead of
      // swallowing it.
      const fixedNow = nowMs;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
      const archiveStamp = formatSessionArchiveTimestamp(fixedNow);
      await fs.mkdir(path.join(sessionsDir, `previous-wake.jsonl.deleted.${archiveStamp}`), {
        recursive: true,
      });
      const warnSpy = vi.spyOn(heartbeatLog, "warn");
      try {
        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        expect(result.status).toBe("ran");
        const store = readSessionStoreForTest<{ sessionId?: string }>(storePath);
        expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
        expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
        // The rename failed, so the transcript stays in place; it must not be
        // silently dropped from observability.
        const remaining = await fs.readdir(sessionsDir);
        expect(remaining).toContain("previous-wake.jsonl");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("previous-wake.jsonl"),
          expect.objectContaining({ sessionKey: isolatedSessionKey }),
        );
      } finally {
        warnSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });
  });

  it("keeps a sandbox-required creation stamp across rollover archival", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      const createdAt = nowMs - 7 * 24 * 3_600_000;
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
        createdVia: "cron",
        createdActor: { type: "system" },
        createdAt,
        sandbox: "required",
      });
      replySpy.mockResolvedValueOnce({ text: "All good." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      const store = readSessionStoreForTest<{
        createdAt?: number;
        createdVia?: string;
        sandbox?: string;
        sessionId?: string;
      }>(storePath);
      expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
      expect(store[isolatedSessionKey]?.createdAt).toBe(createdAt);
      expect(store[isolatedSessionKey]?.createdVia).toBe("cron");
      expect(store[isolatedSessionKey]?.sandbox).toBe("required");
    });
  });

  it("archives the exact replaced generation when overlapping wakes interleave", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "previous-wake.jsonl"),
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      replySpy.mockResolvedValue({ text: "All good." });

      // Hold the first wake's rollover before it reaches the storage writer
      // lane, so the second wake runs its own rollover against the row the
      // first wake still believes it will replace.
      lifecycleMutationGate.shouldHold = (params) => params.activeSessionKey === isolatedSessionKey;
      const runA = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      await vi.waitFor(() => expect(lifecycleMutationGate.entered).toBe(true), { timeout: 10_000 });

      const runB = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      // Wake B's rollover commits while wake A is still held. Its wake
      // transcript materializes on disk before wake A's rollover lands.
      const bSessionId = await vi.waitFor(
        () => {
          const sessionId = readSessionStoreForTest<{ sessionId?: string }>(storePath)[
            isolatedSessionKey
          ]?.sessionId;
          expect(sessionId).toBeTruthy();
          expect(sessionId).not.toBe("previous-wake");
          return sessionId as string;
        },
        { timeout: 10_000 },
      );
      await fs.writeFile(
        path.join(sessionsDir, `${bSessionId}.jsonl`),
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );

      lifecycleMutationGate.release?.();
      const [resultA, resultB] = await Promise.all([runA, runB]);
      expect(resultA.status).toBe("ran");
      expect(resultB.status).toBe("ran");

      const store = readSessionStoreForTest<{ sessionId?: string }>(storePath);
      const finalSessionId = store[isolatedSessionKey]?.sessionId;
      expect(finalSessionId).toBeTruthy();
      expect(finalSessionId).not.toBe("previous-wake");
      expect(finalSessionId).not.toBe(bSessionId);

      // Both replaced generations must be archived, not orphaned: wake B
      // archives the original predecessor, and wake A — whose rollover
      // replaced wake B's committed row — archives that exact generation.
      const remaining = await fs.readdir(sessionsDir);
      expect(remaining).not.toContain("previous-wake.jsonl");
      expect(remaining.some((name) => name.startsWith("previous-wake.jsonl."))).toBe(true);
      expect(remaining).not.toContain(`${bSessionId}.jsonl`);
      expect(remaining.some((name) => name.startsWith(`${bSessionId}.jsonl.`))).toBe(true);
    });
  });

  it("reclaims a transcript that materializes after a competing rollover deferred it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "previous-wake.jsonl"),
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );

      // Hold the first wake's rollover before it reaches the storage writer lane.
      lifecycleMutationGate.shouldHold = (params) => params.activeSessionKey === isolatedSessionKey;
      const runA = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      await vi.waitFor(() => expect(lifecycleMutationGate.entered).toBe(true), { timeout: 10_000 });

      // Wake B rolls over the seeded row and starts its reply turn. The reply
      // spy stands in for the real turn: it holds a real session work admission
      // on the isolated session lane for the duration of the "run".
      const releaseBRun = (() => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { gate, release };
      })();
      replySpy.mockImplementationOnce(async () => {
        const lease = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [isolatedSessionKey],
          assertAllowed: () => {},
        });
        releaseLeases.push(lease.release);
        await releaseBRun.gate;
        lease.release();
        return { text: "All good." };
      });
      const runB = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      const bSessionId = await vi.waitFor(
        () => {
          const sessionId = readSessionStoreForTest<{ sessionId?: string }>(storePath)[
            isolatedSessionKey
          ]?.sessionId;
          expect(sessionId).toBeTruthy();
          expect(sessionId).not.toBe("previous-wake");
          return sessionId as string;
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(
        () => expect(isSessionWorkAdmissionActive(storePath, [isolatedSessionKey])).toBe(true),
        { timeout: 10_000 },
      );

      // Wake A's rollover finally lands while wake B's run is still admitted.
      // It must defer reclamation of wake B's generation onto the committed row
      // instead of racing B's still-absent transcript.
      lifecycleMutationGate.release?.();
      const resultA = await runA;
      expect(resultA.status).toBe("ran");
      const storeAfterA = readSessionStoreForTest<{
        sessionId?: string;
        pendingTranscriptArchiveSessionIds?: string[];
      }>(storePath);
      expect(storeAfterA[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(storeAfterA[isolatedSessionKey]?.sessionId).not.toBe(bSessionId);
      expect(storeAfterA[isolatedSessionKey]?.pendingTranscriptArchiveSessionIds).toEqual([
        bSessionId,
      ]);

      // Wake B's transcript materializes only now — after the competing
      // rollover already replaced its row.
      await fs.writeFile(
        path.join(sessionsDir, `${bSessionId}.jsonl`),
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      // The deferred generation is not reclaimed while its run is admitted.
      let remaining = await fs.readdir(sessionsDir);
      expect(remaining).toContain(`${bSessionId}.jsonl`);

      // Wake B's run ends; a fresh wake reclaims the deferred generation.
      releaseBRun.release();
      const resultB = await runB;
      expect(resultB.status).toBe("ran");
      const runC = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      expect(runC.status).toBe("ran");

      const store = readSessionStoreForTest<{
        sessionId?: string;
        pendingTranscriptArchiveSessionIds?: string[];
      }>(storePath);
      expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(store[isolatedSessionKey]?.pendingTranscriptArchiveSessionIds).toBeUndefined();
      remaining = await fs.readdir(sessionsDir);
      expect(remaining).not.toContain("previous-wake.jsonl");
      expect(remaining.some((name) => name.startsWith("previous-wake.jsonl."))).toBe(true);
      expect(remaining).not.toContain(`${bSessionId}.jsonl`);
      expect(remaining.some((name) => name.startsWith(`${bSessionId}.jsonl.`))).toBe(true);
    });
  });
});
