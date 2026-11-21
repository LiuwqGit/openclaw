import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { sqliteMaintenanceFixture } from "./sqlite-maintenance-fixture.test-support.js";
import {
  reconcileRestoredSqliteJournalMode,
  resolveRestoredSqliteJournalPolicy,
} from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();
const tempDirs = { make: resources.dir };

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1,
    ffree: 0,
  };
}

it("resolves a restore's target journal policy and refuses SSHFS volumes", () => {
  const tempDir = tempDirs.make("openclaw-sqlite-restore-sshfs-");
  vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
  vi.spyOn(fs, "readFileSync").mockReturnValue(
    `42 12 0:41 / ${tempDir} rw,relatime - fuse.sshfs user@host:/share rw\n`,
  );

  expect(() =>
    resolveRestoredSqliteJournalPolicy({
      databasePath: path.join(tempDir, "openclaw.sqlite"),
      databaseLabel: "restored-db",
    }),
  ).toThrow(/restored-db .*is on SSHFS/);
});

it("resolves a restore's target journal policy from the live filesystem", () => {
  const tempDir = tempDirs.make("openclaw-sqlite-restore-wal-");
  vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x58465342));

  expect(
    resolveRestoredSqliteJournalPolicy({ databasePath: path.join(tempDir, "openclaw.sqlite") }),
  ).toBe("wal");
});

it("reconciles a published DELETE snapshot back into WAL for wal-policy volumes", () => {
  const databasePath = resources.file();
  const snapshot = resources.open(databasePath);
  snapshot.exec("CREATE TABLE restore_witness(value TEXT)");
  // Snapshot pragmas model a captured backup: a standalone DELETE file.
  snapshot.exec("PRAGMA journal_mode = DELETE");
  expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });

  reconcileRestoredSqliteJournalMode(snapshot, "wal", {
    databasePath,
    databaseLabel: "restored-db",
    busyTimeoutMs: 5_000,
  });

  expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
});

it("keeps a published restore in rollback journaling for rollback-policy volumes", () => {
  const databasePath = resources.file();
  const snapshot = resources.open(databasePath);
  snapshot.exec("CREATE TABLE restore_witness(value TEXT)");

  reconcileRestoredSqliteJournalMode(snapshot, "rollback", { databasePath });

  expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
});

it("reports a WAL reconciliation SQLite declines after restore", () => {
  const db = {
    close: vi.fn(),
    exec: vi.fn(),
    isOpen: true,
    location: () => "untracked.sqlite",
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => ({
        journal_mode: sql === "PRAGMA journal_mode = WAL;" ? "delete" : "wal",
      })),
    })),
  } as unknown as DatabaseSync;

  expect(() =>
    reconcileRestoredSqliteJournalMode(db, "wal", {
      databaseLabel: "restored-db",
      busyTimeoutMs: 50,
    }),
  ).toThrow("restored-db could not enable WAL; SQLite kept journal_mode=delete");
});
