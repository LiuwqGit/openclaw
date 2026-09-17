import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { resolveLifecycleCoordinatorPath } from "../infra/state-database-coordinator-paths.js";
import {
  acquireStateDatabaseHandleExclusion,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("agentSchemaInspection child names coordinator refusal and recovers without changing source data", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-coordinator-"), "source.sqlite");
  const database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('unchanged');");
  database.close();
  const before = fs.readFileSync(pathname);
  const coordinator = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath: pathname,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: process.getuid?.(),
  });
  expect(fs.existsSync(coordinator)).toBe(false);
  fs.mkdirSync(coordinator, { recursive: true });
  try {
    await using reader = createAgentSchemaInspectionWorker();
    const inspection = reader.inspect({ pathname, supportedVersion: 21 });
    const refusedChild = vi.mocked(fork).mock.results.at(-1)?.value;
    let refusedChildClosed = false;
    refusedChild.once("close", () => {
      refusedChildClosed = true;
    });
    await expect(inspection).rejects.toMatchObject({
      name: "Error",
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
      message:
        "failed while acquiring its state-handles coordinator: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)",
    });
    expect(refusedChildClosed).toBe(true);
    expect(fs.readFileSync(pathname)).toEqual(before);
    fs.rmdirSync(coordinator);
    for (let request = 0; request < 2; request += 1) {
      await expect(reader.inspect({ pathname, supportedVersion: 21 })).resolves.toMatchObject({
        version: 0,
        failure: undefined,
      });
      acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }).release();
    }
    expect(reader.processCount).toBe(2);
    expect(reader.inspectionCount).toBe(2);
    expect(reader.snapshotCount).toBe(0);
    const source = sqlite.openNodeSqliteDatabase(pathname, { readOnly: true });
    try {
      expect(source.prepare("SELECT value FROM probe").get()).toEqual({ value: "unchanged" });
      expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      source.close();
    }
    expect(fs.readFileSync(pathname)).toEqual(before);
  } finally {
    if (fs.existsSync(coordinator) && fs.statSync(coordinator).isDirectory()) {
      fs.rmdirSync(coordinator);
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(coordinator + suffix, { force: true });
    }
  }
});

it("agentSchemaInspection child retains returned migration failures and their hydrated class", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-migration-"), "source.sqlite");
  const database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE probe(value TEXT); PRAGMA user_version = 1;");
  database.close();
  const before = fs.readFileSync(pathname);
  const coordinator = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath: pathname,
    runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
    uid: process.getuid?.(),
  });
  expect(fs.existsSync(coordinator)).toBe(false);
  try {
    await using reader = createAgentSchemaInspectionWorker();
    const inspection = await reader.inspect({
      pathname,
      supportedVersion: 21,
      requireStartupMigrationReadiness: true,
    });
    expect(inspection?.version).toBe(1);
    expect(inspection?.failure).toBeInstanceOf(OpenClawAgentDatabaseMediaMigrationRequiredError);
    expect(inspection?.failure).toMatchObject({
      kind: "agent-media",
      pathname,
      schemaVersion: 1,
      message: new OpenClawAgentDatabaseMediaMigrationRequiredError(pathname, 1).message,
    });
    expect(fs.readFileSync(pathname)).toEqual(before);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(coordinator + suffix, { force: true });
    }
  }
});

it("joins the schema reader before returning canceled ownership", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-cancellation-"), "source.sqlite");
  fs.writeFileSync(pathname, "");
  const controller = new AbortController();
  const reason = new Error("preflight ownership stopped");
  await using reader = createAgentSchemaInspectionWorker();
  const operation = reader.inspect({ pathname, supportedVersion: 1 }, controller.signal);
  const child = vi.mocked(fork).mock.results.at(-1)?.value;
  expect(child?.pid).toBeGreaterThan(0);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  const rejected = expect(operation).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  expect(closed).toBe(true);
});

it("reuses a process while rereading changed data and releasing each source lease", async () => {
  const pathname = path.join(tempDirs.make("agent-schema-reuse-"), "source.sqlite");
  vi.mocked(fork).mockClear();
  await using reader = createAgentSchemaInspectionWorker();
  for (const version of [1, 2]) {
    const writer = sqlite.openNodeSqliteDatabase(pathname);
    writer.exec(`PRAGMA user_version=${version};`);
    writer.close();
    await expect(reader.inspect({ pathname, supportedVersion: 2 })).resolves.toMatchObject({
      version,
    });
    acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }).release();
  }
  expect(fork).toHaveBeenCalledOnce();
});

it("preserves a busy source failure without requesting another snapshot attempt", () => {
  const pathname = path.join(tempDirs.make("agent-schema-busy-"), "source.sqlite");
  const database = sqlite.openNodeSqliteDatabase(pathname);
  database.exec("CREATE TABLE probe(value TEXT);");
  database.close();
  const open = sqlite.openNodeSqliteDatabase;
  const busy = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const stub = vi
    .spyOn(sqlite, "openNodeSqliteDatabase")
    .mockImplementation((location, options) => {
      if (location === fs.realpathSync(pathname)) {
        throw busy;
      }
      return open(location, options);
    });
  try {
    expect(() => tryInspectSqliteReadOnlyInProcess(pathname, () => null)).toThrow(busy);
  } finally {
    stub.mockRestore();
  }
});
