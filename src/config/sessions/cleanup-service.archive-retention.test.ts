import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
} from "./session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const RETENTION_MS = 60_000;

// Short archive retention with every other maintenance cutoff disabled: the
// regression must exercise archive expiry alone, not entry or disk-budget work.
const retentionMaintenanceConfig: ResolvedSessionMaintenanceConfig = {
  mode: "enforce",
  pruneAfterMs: Number.MAX_SAFE_INTEGER,
  archiveDashboardAfterMs: null,
  maxEntries: 5000,
  modelRunPruneAfterMs: Number.MAX_SAFE_INTEGER,
  preserveRecentMs: null,
  resetArchiveRetentionMs: RETENTION_MS,
  maxDiskBytes: null,
  highWaterBytes: null,
};

let maintenanceConfigOverride: ResolvedSessionMaintenanceConfig | undefined;

vi.mock("./store-maintenance-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store-maintenance-runtime.js")>();
  return {
    ...actual,
    resolveMaintenanceConfig: () => maintenanceConfigOverride ?? retentionMaintenanceConfig,
  };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cleanup-archive-retention-");

let storePath: string;

const databasePath = () =>
  resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
const archiveDirectory = () =>
  resolveSqliteTranscriptArchiveDirectory({ agentId: "main", path: databasePath() });
const rows = <T>(query: Compilable<T>) => executeSqliteQuerySync(openDatabase().db, query).rows;
const openDatabase = () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath() });
  ensureSessionTranscriptArchiveSchema(database.db);
  return database;
};
const archiveRows = () =>
  rows(getSessionKysely(openDatabase().db).selectFrom("session_transcript_archives").selectAll());

function seedArchivedTranscript(params: {
  sessionId: string;
  reason: "deleted" | "reset";
  ageMs: number;
}): string {
  const createdAt = Date.now() - params.ageMs;
  const archiveName = `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(createdAt)}`;
  fs.mkdirSync(archiveDirectory(), { recursive: true });
  fs.writeFileSync(path.join(archiveDirectory(), archiveName), "synthetic history");
  rows(
    getSessionKysely(openDatabase().db)
      .insertInto("session_transcript_archives")
      .values({
        session_id: params.sessionId,
        session_key: `agent:main:${params.sessionId}`,
        generation: "retained-generation",
        archive_name: archiveName,
        archive_sha256: createHash("sha256").update("synthetic history").digest("hex"),
        encoding: "identity",
        reason: params.reason,
        created_at: createdAt,
        published_at: createdAt,
        archive_blob: Buffer.from("synthetic history"),
      }),
  );
  return archiveName;
}

const archiveFileExists = (archiveName: string) =>
  fs.existsSync(path.join(archiveDirectory(), archiveName));

beforeEach(() => {
  maintenanceConfigOverride = undefined;
  const tempDir = sessionDirs.make();
  storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const liveKey = "agent:main:dashboard:live";
  replaceSessionEntrySync(
    { sessionKey: liveKey, storePath },
    { sessionId: "live", updatedAt: Date.now() },
  );
});

afterEach(() => {
  maintenanceConfigOverride = undefined;
  vi.restoreAllMocks();
});

it("applies resetArchiveRetention through sessions cleanup without cron or new deletions", async () => {
  const expiredDeleted = seedArchivedTranscript({
    sessionId: "expired-deleted",
    reason: "deleted",
    ageMs: RETENTION_MS * 2,
  });
  const expiredReset = seedArchivedTranscript({
    sessionId: "expired-reset",
    reason: "reset",
    ageMs: RETENTION_MS * 2,
  });
  const retained = seedArchivedTranscript({
    sessionId: "retained-archive",
    reason: "deleted",
    ageMs: 0,
  });

  const result = await runSessionsCleanup({
    cfg: {},
    opts: { enforce: true },
    targets: [{ agentId: "main", storePath }],
  });

  expect(result.appliedSummaries[0]?.mode).toBe("enforce");
  // The expired archive file and canonical row are both gone, without any new
  // session deletion driving the sweep.
  expect(archiveFileExists(expiredDeleted)).toBe(false);
  expect(archiveFileExists(expiredReset)).toBe(false);
  expect(archiveRows().map((row) => row.session_id)).toEqual(["retained-archive"]);
  expect(archiveFileExists(retained)).toBe(true);
  expect(loadSessionEntry({ sessionKey: "agent:main:dashboard:live", storePath })).toMatchObject({
    sessionId: "live",
  });
});

it("keeps archives when resetArchiveRetention is not configured", async () => {
  // Mirror the retention config with the cutoff disabled (the documented default).
  maintenanceConfigOverride = { ...retentionMaintenanceConfig, resetArchiveRetentionMs: null };
  const expired = seedArchivedTranscript({
    sessionId: "kept-without-retention",
    reason: "deleted",
    ageMs: RETENTION_MS * 4,
  });

  await runSessionsCleanup({
    cfg: {},
    opts: { enforce: true },
    targets: [{ agentId: "main", storePath }],
  });

  // null retention keeps archived transcripts: the disk budget, not a timer, evicts them.
  expect(archiveFileExists(expired)).toBe(true);
  expect(archiveRows().map((row) => row.session_id)).toEqual(["kept-without-retention"]);
});
