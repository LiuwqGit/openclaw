// Covers copied state roots whose persisted install records point at the source tree.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  runOpenClawStateWriteTransaction,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-record-reader.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  clearLoadInstalledPluginIndexInstallRecordsCache();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function expectInstallPath(records: Record<string, unknown>, pluginId: string, expected: string) {
  const record = records[pluginId] as { installPath?: string } | undefined;
  if (!record) {
    throw new Error(`Missing install record ${pluginId}`);
  }
  expect(record.installPath, pluginId).toBe(expected);
}

function insertPersistedIndexRow(stateDir: string, installRecordsJson: string): void {
  const valueJson =
    '{"revision":123,"index":{"version":1,' +
    '"hostContractVersion":"2026.4.25","compatRegistryVersion":"compat-v1",' +
    '"migrationVersion":1,"policyHash":"policy-hash",' +
    `"generatedAtMs":123,"installRecords":${installRecordsJson},` +
    '"plugins":[],"diagnostics":[]}}';
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `
          INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('plugins.installedIndex', ?, 123)
        `,
      ).run(valueJson);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("copied state plugin install records", () => {
  it("rebases copied managed install records onto the current state root", async () => {
    requireNodeSqlite();
    const sourceStateDir = tempDirs.make("openclaw-plugin-index-source-");
    const stateDir = tempDirs.make("openclaw-plugin-index-copied-");
    const packageName = "@openclaw/copied";
    const sourceInstallPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied",
      version: "1.0.0",
    });
    const localInstallPath = writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "copied",
      version: "1.0.0",
    });
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        copied: {
          source: "npm",
          spec: "@openclaw/copied@1.0.0",
          installPath: sourceInstallPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectInstallPath(loaded, "copied", localInstallPath);
    expect((loaded.copied as { resolvedName?: string }).resolvedName).toBe(packageName);
  });

  it("drops copied managed install records when the local state root has no install", async () => {
    requireNodeSqlite();
    const sourceStateDir = tempDirs.make("openclaw-plugin-index-source-");
    const stateDir = tempDirs.make("openclaw-plugin-index-copied-");
    const packageName = "@openclaw/copied-missing";
    const sourceInstallPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied-missing",
      version: "1.0.0",
    });
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "copied-missing": {
          source: "npm",
          spec: "@openclaw/copied-missing@1.0.0",
          installPath: sourceInstallPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(loaded["copied-missing"]).toBeUndefined();
  });

  it("rebases copied legacy flat managed records onto the current state root", async () => {
    requireNodeSqlite();
    const sourceStateDir = tempDirs.make("openclaw-plugin-index-source-");
    const stateDir = tempDirs.make("openclaw-plugin-index-copied-");
    const packageName = "@openclaw/copied-legacy";
    const sourceInstallPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied-legacy",
      version: "1.0.0",
      layout: "legacy",
    });
    const localInstallPath = writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "copied-legacy",
      version: "1.0.0",
      layout: "legacy",
    });
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "copied-legacy": {
          source: "npm",
          spec: "@openclaw/copied-legacy@1.0.0",
          installPath: sourceInstallPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectInstallPath(loaded, "copied-legacy", localInstallPath);
  });

  it("rebases copied managed install records during registry refresh", async () => {
    requireNodeSqlite();
    const sourceStateDir = tempDirs.make("openclaw-plugin-index-source-");
    const stateDir = tempDirs.make("openclaw-plugin-index-copied-");
    const packageName = "@openclaw/copied";
    const sourceInstallPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied",
      version: "1.0.0",
    });
    const localInstallPath = writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "copied",
      version: "1.0.0",
    });
    insertPersistedIndexRow(
      stateDir,
      JSON.stringify({
        copied: {
          source: "npm",
          spec: "@openclaw/copied@1.0.0",
          installPath: sourceInstallPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
      }),
    );

    const refreshed = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [],
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    expectInstallPath(refreshed.installRecords, "copied", localInstallPath);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted installed plugin index");
    }
    expectInstallPath(persisted.installRecords, "copied", localInstallPath);
  });

  it("keeps path plugin records pointing outside the current state root", async () => {
    requireNodeSqlite();
    const sourceStateDir = tempDirs.make("openclaw-plugin-index-source-");
    const stateDir = tempDirs.make("openclaw-plugin-index-copied-");
    const externalPath = path.join(sourceStateDir, "extensions", "external-demo");
    fs.mkdirSync(externalPath, { recursive: true });
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "external-demo": {
          source: "path",
          sourcePath: externalPath,
          installPath: externalPath,
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectInstallPath(loaded, "external-demo", externalPath);
  });
});
