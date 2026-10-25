import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import { formatDiskSpaceBytes } from "./disk-space.js";
import { statIfExists } from "./path-existence.js";
import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";

export async function measureUpdateStateFiles(
  files: Iterable<string>,
): Promise<{ bytes: number; largest: number; families: Array<{ path: string; bytes: number }> }> {
  let bytes = 0;
  let largest = 0;
  const families: Array<{ path: string; bytes: number }> = [];
  for (const file of files) {
    let family = 0;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      family += (await statIfExists(file + suffix))?.size ?? 0;
    }
    bytes += family;
    largest = Math.max(largest, family);
    families.push({ path: file, bytes: family });
  }
  return { bytes, largest, families };
}

/** Headroom shared by every update state copy and backup space requirement. */
export const UPDATE_STATE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;

/**
 * Activation-time update database backup requirement, shared by the backup
 * owner's check and the pre-staging preflight: this volume holds snapshots,
 * same-volume rollback copies, and acquisition/publication scratch.
 */
export function requiredUpdateDatabaseBackupBytes(size: {
  bytes: number;
  largest: number;
}): number {
  return size.bytes === 0
    ? 0
    : 2 * size.bytes + 3 * size.largest + UPDATE_STATE_SPACE_RESERVE_BYTES;
}

/**
 * Rollback allowance for migrated files left in place on another volume:
 * one snapshot plus publication scratch and headroom.
 */
export function requiredUpdateDatabaseRollbackBytes(size: {
  bytes: number;
  largest: number;
}): number {
  return size.bytes + size.largest + UPDATE_STATE_SPACE_RESERVE_BYTES;
}

/** Bound private update I/O without releasing accepted work before it settles. */
export async function withUpdateCandidateIoBudget<T>(
  params: {
    directory: string;
    bytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    operation?: "snapshot" | "inspection";
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  params.signal?.throwIfAborted();
  const budget = Math.max(
    params.timeoutMs ?? 0,
    resolveSqliteInspectionBudget(
      `update state ${params.operation ?? "inspection"}`,
      params.directory,
      params.bytes,
    ).timeoutMs,
  );
  const deadlineAtMs = Date.now() + budget;
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal, ...(params.signal ? [params.signal] : [])]);
  const expire = () =>
    deadline.abort(
      new Error(
        `Update state ${params.operation ?? "inspection"} exceeded its ${budget / 1000} second allowance (${formatDiskSpaceBytes(params.bytes)} ${params.operation === "snapshot" ? "total estimated snapshot input, including SQLite and plugins" : "of SQLite state"}). Check storage performance before retrying.`,
      ),
    );
  const cancelDeadline = scheduleAbsoluteDeadline(deadlineAtMs, expire);
  try {
    // Cancellation asks the owner to stop; its admitted filesystem work still drains.
    const value = await run(signal);
    if (Date.now() >= deadlineAtMs) {
      expire();
    }
    signal.throwIfAborted();
    return value;
  } finally {
    cancelDeadline();
  }
}
