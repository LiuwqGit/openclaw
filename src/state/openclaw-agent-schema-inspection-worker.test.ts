import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import { resolveLifecycleCoordinatorPath } from "../infra/state-database-coordinator-paths.js";
import { resolveStateLifecycleRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { inspectAgentDatabaseSchemaInWorker } from "./openclaw-agent-schema-inspection-worker.js";

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
    const inspection = inspectAgentDatabaseSchemaInWorker({ pathname, supportedVersion: 21 });
    await expect(inspection).rejects.toMatchObject({
      name: "Error",
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
      message:
        "failed while acquiring its state-handles coordinator: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)",
    });
    expect(fs.readFileSync(pathname)).toEqual(before);
    fs.rmdirSync(coordinator);
    await expect(
      inspectAgentDatabaseSchemaInWorker({ pathname, supportedVersion: 21 }),
    ).resolves.toMatchObject({ version: 0 });
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
    const inspection = await inspectAgentDatabaseSchemaInWorker({
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
  const operation = inspectAgentDatabaseSchemaInWorker(
    { pathname, supportedVersion: 1 },
    controller.signal,
  );
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
