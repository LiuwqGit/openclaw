import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.mock("./node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: vi.fn(actual.openNodeSqliteDatabase),
    requireNodeSqlite: vi.fn(actual.requireNodeSqlite),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function inspectFailure(
  operation:
    | "coordinator"
    | "source"
    | "backup-source"
    | "snapshot-open"
    | "snapshot-copy"
    | "snapshot-backup",
  failure: Error,
) {
  const root = tempDirs.make("sqlite-inspection-operation-");
  const sourcePath = path.join(root, "source.sqlite");
  const stagingRoot = path.join(root, "staging");
  fs.mkdirSync(stagingRoot);
  const actual = await vi.importActual<typeof import("./node-sqlite.js")>("./node-sqlite.js");
  const source = actual.openNodeSqliteDatabase(sourcePath);
  source.exec("CREATE TABLE present (id INTEGER PRIMARY KEY); INSERT INTO present VALUES (7);");
  source.close();
  const before = fs.readFileSync(sourcePath);
  const sqlite = await import("./node-sqlite.js");
  const { withStateDatabaseCoordinatorRuntimeDirectory } =
    await import("./state-database-coordinator.js");
  const { resolveLifecycleCoordinatorPath } = await import("./state-database-coordinator-paths.js");
  const coordinatorPath = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath: sourcePath,
    runtimeDirectory: root,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  const opened: DatabaseSync[] = [];
  vi.mocked(sqlite.openNodeSqliteDatabase).mockImplementation((location, options) => {
    if (
      (operation === "coordinator" && location === coordinatorPath) ||
      ((operation === "source" || operation === "backup-source") && location === sourcePath) ||
      (operation === "snapshot-open" && path.dirname(location).startsWith(stagingRoot))
    ) {
      throw failure;
    }
    const database = actual.openNodeSqliteDatabase(location, options);
    opened.push(database);
    return database;
  });
  vi.mocked(sqlite.requireNodeSqlite).mockReturnValue({
    ...actual.requireNodeSqlite(),
    backup:
      operation === "snapshot-backup"
        ? vi.fn().mockRejectedValue(failure)
        : actual.requireNodeSqlite().backup,
  });
  if (operation === "snapshot-copy") {
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[1] === "wx") {
        throw failure;
      }
      return open(...args);
    });
  }
  const diagnostics = await import("./sqlite-error-diagnostics.js");
  const format = vi.spyOn(diagnostics, "formatSqliteReadOnlyInspectionFailure");
  const completed = Promise.withResolvers<void>();
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    completed.resolve();
    return true;
  });
  process.argv = [
    process.execPath,
    "sqlite-readonly-location.worker.ts",
    "--openclaw-sqlite-readonly-child",
    operation === "snapshot-copy" ? "sync" : operation === "source" ? "schema-header" : "async",
    sourcePath,
    stagingRoot,
  ];
  await withStateDatabaseCoordinatorRuntimeDirectory(root, async () => {
    await import("./sqlite-readonly-location.worker.js");
    await completed.promise;
  });
  expect(process.exitCode).toBe(1);
  expect(format).toHaveBeenCalledOnce();
  const [[observedFailure]] = format.mock.calls;
  expect(opened.every((database) => !database.isOpen)).toBe(true);
  expect(fs.readdirSync(stagingRoot)).toEqual([]);
  expect(fs.readFileSync(sourcePath)).toEqual(before);
  const read = actual.openNodeSqliteDatabase(sourcePath, { readOnly: true });
  try {
    expect(read.prepare("SELECT id FROM present").get()).toEqual({ id: 7 });
    expect(read.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    read.close();
  }
  return { write, observedFailure };
}

describe("registered SQLite read-only worker operation diagnostics", () => {
  it("inspectSqliteSchemaHeader reports a native coordinator denial through its real child and parent", async () => {
    const root = tempDirs.make("sqlite-inspection-parent-");
    const sourcePath = path.join(root, "source.sqlite");
    const actual = await vi.importActual<typeof import("./node-sqlite.js")>("./node-sqlite.js");
    const sqlite = await import("./node-sqlite.js");
    vi.mocked(sqlite.openNodeSqliteDatabase).mockImplementation(actual.openNodeSqliteDatabase);
    vi.mocked(sqlite.requireNodeSqlite).mockImplementation(actual.requireNodeSqlite);
    const source = actual.openNodeSqliteDatabase(sourcePath);
    source.exec("CREATE TABLE present (id INTEGER PRIMARY KEY); INSERT INTO present VALUES (7);");
    source.close();
    const before = fs.readFileSync(sourcePath);
    const { resolveLifecycleCoordinatorPath } =
      await import("./state-database-coordinator-paths.js");
    const { resolveStateLifecycleRuntimeDirectory } =
      await import("./state-database-coordinator.js");
    const { inspectSqliteSchemaHeader } = await import("./sqlite-snapshot-source.js");
    const coordinatorPath = resolveLifecycleCoordinatorPath("state-handles", {
      databasePath: sourcePath,
      runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
      uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    });
    fs.mkdirSync(path.dirname(coordinatorPath), { mode: 0o700, recursive: true });
    fs.mkdirSync(coordinatorPath);
    try {
      await expect(inspectSqliteSchemaHeader(sourcePath)).rejects.toThrow(
        "SQLite read-only worker failed while acquiring its state-handles coordinator: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)",
      );
      expect(fs.readFileSync(sourcePath)).toEqual(before);
    } finally {
      fs.rmdirSync(coordinatorPath);
    }
    try {
      await expect(inspectSqliteSchemaHeader(sourcePath)).resolves.toEqual({ userVersion: 0 });
      expect(fs.readFileSync(sourcePath)).toEqual(before);
    } finally {
      fs.rmSync(coordinatorPath, { force: true });
    }
  });

  it.each([
    ["coordinator", "acquiring its state-handles coordinator"],
    ["source", "opening the source database"],
    ["backup-source", "opening the source database"],
    ["snapshot-open", "creating its private snapshot"],
    ["snapshot-copy", "creating its private snapshot"],
    ["snapshot-backup", "creating its private snapshot"],
  ] as const)(
    "preserves frozen %s failures, identity, native codes and cleanup",
    async (operation, context) => {
      const failure = Object.freeze(
        Object.assign(new Error("unable to open database file"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 14,
          cause: new Error("hidden cause prose"),
          sql: "hidden SQL",
          path: "hidden path",
        }),
      );
      const { write, observedFailure } = await inspectFailure(operation, failure);
      expect(observedFailure).toBe(failure);
      expect(write).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          ok: false,
          message: `failed while ${context}: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)`,
        }),
      );
    },
  );

  it("keeps a non-extensible coordinator error and its instanceof handling", async () => {
    const { SqliteCoordinatorError } = await import("./sqlite-coordinator.js");
    const { StateDatabaseCoordinatorContentionError } =
      await import("./state-database-coordinator.js");
    const failure = Object.preventExtensions(
      new StateDatabaseCoordinatorContentionError("state-handles"),
    );
    const { write, observedFailure } = await inspectFailure("coordinator", failure);
    expect(observedFailure).toBe(failure);
    expect(failure).toBeInstanceOf(SqliteCoordinatorError);
    expect(failure).toBeInstanceOf(StateDatabaseCoordinatorContentionError);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        ok: false,
        message:
          "failed while acquiring its state-handles coordinator: another OpenClaw process owns state-handles",
      }),
    );
  });

  it("keeps aggregate identity and admits only bounded cause codes through the registered worker", async () => {
    const cause = Object.assign(new Error("hidden cause prose"), { code: "EIO", errcode: 778 });
    const failure = Object.freeze(
      new AggregateError([cause, new Error("hidden cleanup")], "read failed", { cause }),
    );
    const { write, observedFailure } = await inspectFailure("source", failure);
    expect(observedFailure).toBe(failure);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        ok: false,
        message: "failed while opening the source database: read failed (code=EIO, errcode=778)",
      }),
    );
  });

  it("keeps the source operation through the snapshot owner's existing staging wrapper", async () => {
    const failure = Object.freeze(
      Object.assign(new Error("disk full"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 13,
        cause: new Error("hidden cause prose"),
      }),
    );
    const { write, observedFailure } = await inspectFailure("backup-source", failure);
    expect(observedFailure instanceof Error && observedFailure.cause).toBe(failure);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "failed while opening the source database: disk full (SQLite errcode=13)",
      ),
    );
    expect(write.mock.calls[0][0]).toContain("code=ERR_SQLITE_ERROR, errcode=13");
    expect(write.mock.calls[0][0]).not.toContain("hidden cause prose");
  });
});
