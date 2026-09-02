// Memory Core owns detached search-time index maintenance lifecycle.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";

const RETRY_COOLDOWN_BASE_MS = 30_000;
const RETRY_COOLDOWN_MAX_MS = 15 * 60_000;

type MemorySearchMaintenanceManager = {
  sync(params: { reason: string; force: true }): Promise<void>;
  status(): { dirty?: boolean; lastSyncError?: string };
  close(): Promise<void>;
};

/**
 * Single-flight gate for detached search-triggered maintenance.
 *
 * A failed maintenance run (for example a publish revision conflict while a
 * full reindex was building) restores the dirty generation on the serving
 * manager, and the next search would otherwise immediately launch another
 * detached full rebuild that loses the same race under sustained concurrent
 * writes. The gate coalesces concurrent triggers into the in-flight attempt
 * and defers retries behind an escalating cooldown, reset only after an
 * attempt fully clears the handed-off generation. An attempt that resolves
 * but returns an incomplete reason (its manager stayed dirty and the
 * generation was restored) counts as a failure just like a thrown error.
 */
export class MemorySearchMaintenanceRetryGate {
  private inFlight: Promise<void> | null = null;
  private retryAfterMs = 0;
  private consecutiveFailures = 0;

  async run(operation: () => Promise<string | undefined>): Promise<void> {
    if (this.inFlight !== null || Date.now() < this.retryAfterMs) {
      // The in-flight attempt owns the dirty generation it took over, and a
      // recently failed attempt is cooling down. Either way the dirty state
      // stays owned by the serving manager until a later trigger retries.
      return;
    }
    const tracked = (async () => {
      try {
        const incompleteReason = await operation();
        if (incompleteReason) {
          this.recordFailure();
        } else {
          this.consecutiveFailures = 0;
        }
      } catch (err) {
        this.recordFailure();
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = tracked;
    await tracked;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    this.retryAfterMs =
      Date.now() +
      Math.min(RETRY_COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1), RETRY_COOLDOWN_MAX_MS);
  }
}

export async function runMemorySearchMaintenance<DirtyGeneration>(params: {
  reason: string;
  takeDirtyGeneration: () => DirtyGeneration;
  restoreDirtyGeneration: (generation: DirtyGeneration) => void;
  acquireManager: () => Promise<MemorySearchMaintenanceManager | null>;
}): Promise<string | undefined> {
  const dirtyGeneration = params.takeDirtyGeneration();
  let manager: MemorySearchMaintenanceManager | null;
  try {
    manager = await params.acquireManager();
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    throw toErrorObject(err, "Memory search maintenance manager acquisition failed");
  }
  if (!manager) {
    params.restoreDirtyGeneration(dirtyGeneration);
    return undefined;
  }

  let maintenanceError: Error | undefined;
  let incompleteReason: string | undefined;
  try {
    // The transient manager has no watcher state. Force every source represented
    // by the handed-off generation while the default manager serves published reads.
    await manager.sync({ reason: params.reason, force: true });
    const status = manager.status();
    if (status.dirty === true) {
      // A provider fallback may deliberately resolve in keyword-only mode while
      // retaining retry state. Return that incomplete generation to its serving owner.
      params.restoreDirtyGeneration(dirtyGeneration);
      incompleteReason = status.lastSyncError ?? "memory search maintenance remained dirty";
    }
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    maintenanceError = toErrorObject(err, "Memory search maintenance failed");
  }
  try {
    await manager.close();
  } catch (err) {
    maintenanceError ??= toErrorObject(err, "Memory search maintenance close failed");
  }
  if (maintenanceError) {
    throw maintenanceError;
  }
  return incompleteReason;
}
