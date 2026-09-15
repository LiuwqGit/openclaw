import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { formatSqliteReadOnlyInspectionFailure } from "./sqlite-error-diagnostics.js";
import { prepareSqliteReadOnlyLocationInProcess } from "./sqlite-readonly-location.js";
import { resolveLifecycleCoordinatorPath } from "./state-database-coordinator-paths.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-inspection-operation-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop() as string, { force: true, recursive: true });
  }
});

/** A readable source whose state-handles coordinator cannot be opened natively. */
async function captureCoordinatorAcquisitionFailure(): Promise<Error> {
  const runtimeDirectory = createTempRoot();
  const stateDirectory = createTempRoot();
  const databasePath = path.join(stateDirectory, "source.sqlite");
  const source = openNodeSqliteDatabase(databasePath);
  source.exec("CREATE TABLE present (id INTEGER PRIMARY KEY);");
  source.close();
  const coordinatorPath = resolveLifecycleCoordinatorPath("state-handles", {
    databasePath,
    runtimeDirectory,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  });
  fs.mkdirSync(path.dirname(coordinatorPath), { mode: 0o700, recursive: true });
  // A directory where SQLite must open its coordinator file: native open fails.
  fs.mkdirSync(coordinatorPath, { recursive: true });
  try {
    await withStateDatabaseCoordinatorRuntimeDirectory(runtimeDirectory, () =>
      prepareSqliteReadOnlyLocationInProcess(databasePath),
    );
  } catch (error) {
    return error as Error;
  }
  throw new Error("Fixture expected its coordinator acquisition to fail");
}

describe("SQLite read-only inspection operation context", () => {
  it("names the coordinator when its acquisition fails on a readable source", async () => {
    const error = await captureCoordinatorAcquisitionFailure();
    // The reported gap: the native failure alone does not identify the operation.
    expect(error.message).not.toContain("coordinator");
    expect(formatSqliteReadOnlyInspectionFailure(error)).toContain(
      "failed while acquiring its state-handles coordinator",
    );
  });

  it("retains the native message and bounded codes beside the operation context", async () => {
    const error = await captureCoordinatorAcquisitionFailure();
    const formatted = formatSqliteReadOnlyInspectionFailure(error);
    expect(formatted).toContain(error.message);
    expect(formatted).toMatch(/code=[A-Z0-9_]{1,64}/u);
  });

  it("leaves failures without an owning operation unchanged", () => {
    const error = Object.assign(new Error("disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 778,
    });
    expect(formatSqliteReadOnlyInspectionFailure(error)).toBe(
      "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)",
    );
  });

  it("keeps the innermost operation when a wrapper rethrows the failure", async () => {
    const error = await captureCoordinatorAcquisitionFailure();
    const wrapped = new Error("SQLite read-only snapshot staging failed", { cause: error });
    expect(formatSqliteReadOnlyInspectionFailure(wrapped)).toContain(
      "failed while acquiring its state-handles coordinator",
    );
  });
});
