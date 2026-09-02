// Memory Core tests cover detached search-maintenance retry gating.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const { MemoryIndexManager } = await import("./manager.js");

describe("memory search maintenance retry gating", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig: createCfg, getPersistentManager } = fixture;

  it("coalesces concurrent search-triggered maintenance into a single detached attempt", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    const maintenanceStarted = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const maintenance = {
      sync: vi.fn(async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
      }),
      status: vi.fn(() => ({ dirty: false })),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const fields = manager as unknown as {
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };

    try {
      const first = fields.syncPublishedIndexInBackground({ reason: "search" });
      await maintenanceStarted.promise;
      const second = fields.syncPublishedIndexInBackground({ reason: "search" });
      // Give a wrongly-queued second attempt a chance to acquire another manager.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(maintenance.sync).toHaveBeenCalledTimes(1);

      releaseMaintenance.resolve();
      await Promise.allSettled([first, second]);
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(maintenance.close).toHaveBeenCalledTimes(1);
    } finally {
      releaseMaintenance.resolve();
      getSpy.mockRestore();
      await manager.close?.();
    }
  });

  it("defers search-triggered maintenance retries after a failed attempt and recovers later", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    const syncError = new Error("maintenance failed");
    let maintenanceAttempts = 0;
    const maintenance = {
      sync: vi.fn(async () => {
        maintenanceAttempts += 1;
        if (maintenanceAttempts === 1) {
          throw syncError;
        }
      }),
      status: vi.fn(() => ({ dirty: false })),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    Reflect.set(manager, "memoryFullRetryDirty", true);
    const fields = manager as unknown as {
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };

    try {
      await expect(fields.syncPublishedIndexInBackground({ reason: "search" })).rejects.toThrow(
        syncError,
      );
      expect(maintenance.sync).toHaveBeenCalledTimes(1);
      expect(Reflect.get(manager, "dirty")).toBe(true);
      expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);

      // An immediate retry stays deferred: no new detached maintenance starts.
      await fields.syncPublishedIndexInBackground({ reason: "search" });
      expect(maintenance.sync).toHaveBeenCalledTimes(1);

      // After the failure cooldown elapses, a later search retries and recovers.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
        await fields.syncPublishedIndexInBackground({ reason: "search" });
        expect(maintenance.sync).toHaveBeenCalledTimes(2);
        expect(Reflect.get(manager, "dirty")).toBe(false);
        expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);
        expect(manager.status().lastSyncError).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      getSpy.mockRestore();
      await manager.close?.();
    }
  });

  it("defers retries after an incomplete maintenance outcome that leaves the index dirty", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    const maintenance = {
      sync: vi.fn(async () => {}),
      status: vi.fn(() => ({ dirty: true, lastSyncError: "keyword-only fallback" })),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const fields = manager as unknown as {
      syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
    };

    try {
      // Resolves without throwing, but the restored generation stays dirty.
      await fields.syncPublishedIndexInBackground({ reason: "search" });
      expect(maintenance.sync).toHaveBeenCalledTimes(1);
      expect(manager.status().lastSyncError).toContain("keyword-only fallback");

      // The unresolved dirty outcome must cool down exactly like a hard failure.
      await fields.syncPublishedIndexInBackground({ reason: "search" });
      expect(maintenance.sync).toHaveBeenCalledTimes(1);
    } finally {
      getSpy.mockRestore();
      await manager.close?.();
    }
  });

  it("publishes new memory content through a search-triggered maintenance generation", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    await fs.writeFile(
      path.join(fixture.paths.memory, "search-triggered.md"),
      "quokka marsupial facts",
    );
    Reflect.set(manager, "dirty", true);

    try {
      await manager.search("zebra", { maxResults: 5, minScore: 0 });
      await vi.waitFor(
        () => {
          const syncs = Reflect.get(manager, "activeBackgroundSearchSyncs") as Set<Promise<void>>;
          expect(syncs.size).toBe(0);
        },
        { timeout: 10_000 },
      );
      expect(manager.status().dirty).toBe(false);
      const results = await manager.search("quokka", { maxResults: 5, minScore: 0 });
      expect(results.some((entry) => entry.path.includes("search-triggered.md"))).toBe(true);
    } finally {
      await manager.close?.();
    }
  });

  it("stops later searches from relaunching maintenance while a failed attempt cools down", async () => {
    const manager = await getPersistentManager(
      createCfg({ provider: "none", minScore: 0, onSearch: true, hybrid: { enabled: true } }),
    );
    await manager.sync({ reason: "test" });
    let attempts = 0;
    const maintenance = {
      sync: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("revision conflict");
        }
      }),
      status: vi.fn(() => ({ dirty: false })),
      close: vi.fn(async () => {}),
    };
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockResolvedValue(maintenance as never);
    Reflect.set(manager, "dirty", true);
    const drainBackgroundSyncs = async () =>
      await vi.waitFor(
        () => {
          const syncs = Reflect.get(manager, "activeBackgroundSearchSyncs") as Set<Promise<void>>;
          expect(syncs.size).toBe(0);
        },
        { timeout: 10_000 },
      );

    try {
      await manager.search("zebra", { maxResults: 5, minScore: 0 });
      await drainBackgroundSyncs();
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(manager.status().lastSyncError).toContain("revision conflict");
      expect(manager.status().dirty).toBe(true);

      // The next search observes the dirty flag but must not relaunch maintenance.
      await manager.search("zebra", { maxResults: 5, minScore: 0 });
      await drainBackgroundSyncs();
      expect(getSpy).toHaveBeenCalledTimes(1);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
        await manager.search("zebra", { maxResults: 5, minScore: 0 });
        await drainBackgroundSyncs();
        expect(getSpy).toHaveBeenCalledTimes(2);
        expect(manager.status().dirty).toBe(false);
        expect(manager.status().lastSyncError).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    } finally {
      getSpy.mockRestore();
      await manager.close?.();
    }
  });
});
