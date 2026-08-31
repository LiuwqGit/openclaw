import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { loadLegacyCronRepairState, repairLegacyCronStoreWithoutPrompt } from "./legacy-repair.js";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it.each<{
  name: string;
  agents: NonNullable<OpenClawConfig["agents"]>;
  agentId?: string;
  expectedOwner: { kind: "runtime-default" | "explicit"; agentId: string };
}>([
  {
    name: "sole configured agent",
    agents: { entries: { ops: {} } },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "configured system agent under explicit ownership",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "explicit job owner before the configured system agent",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    agentId: "main",
    expectedOwner: { kind: "explicit", agentId: "main" },
  },
])(
  "projects the $name without changing the stored owner",
  async ({ agents, agentId, expectedOwner }) => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-owner-projection-"));
    const storePath = path.join(tempRoot, "cron", "jobs.json");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "dynamic-default",
          agentId,
          name: "Dynamic default",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run" },
          state: {},
        },
      ],
    });

    const cfg = {
      cron: { store: storePath },
      agents,
    } as OpenClawConfig;
    const state = await loadLegacyCronRepairState({ cfg, storePath, readOnly: true });

    expect(state?.rawJobs[0]?.agentId).toBe(agentId);
    expect(state?.projectedOwnersByJobId.get("dynamic-default")).toEqual(expectedOwner);
  },
);

it("repairs recoverable quarantined rows without legacy files on the startup path (#133347)", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-quarantine-recovery-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  await saveCronStore(storePath, { version: 1, jobs: [] });
  saveCronQuarantinedJobs({
    storePath,
    nowMs: Date.parse("2026-08-30T18:50:02.000Z"),
    entries: [
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: {
          id: "variant-cron",
          name: "Variant cron",
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          schedule: { kind: "Cron", expr: "0 9 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
        state: { nextRunAtMs: 123 },
        updatedAtMs: 456,
      },
      {
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: {
          id: "genuinely-bad",
          name: "Genuinely bad",
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          schedule: { kind: "daily", at: "09:00" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      },
    ],
  });
  const cfg = { cron: { store: storePath } } as OpenClawConfig;

  const result = await repairLegacyCronStoreWithoutPrompt({ cfg });

  expect(result.changes.join("\n")).toContain("Recovered 1 quarantined automation");
  const persisted = (await loadCronStore(storePath)).jobs as unknown as Array<
    Record<string, unknown>
  >;
  expect(persisted.map((job) => job.id)).toEqual(["variant-cron"]);
  const recovered = persisted[0];
  if (!recovered) {
    throw new Error("expected recovered cron job variant-cron");
  }
  expect((recovered.schedule as Record<string, unknown>).kind).toBe("cron");
  expect(recovered.enabled).toBe(true);
  expect(recovered.state).toMatchObject({ nextRunAtMs: 123 });
  const quarantine = loadCronQuarantinedJobs(storePath);
  expect(quarantine.map((entry) => (entry.job as { id?: string } | undefined)?.id)).toEqual([
    "genuinely-bad",
  ]);

  // A second repair run is a no-op: the recovered job is active and the
  // remaining quarantine row is genuinely malformed.
  const second = await repairLegacyCronStoreWithoutPrompt({ cfg });
  expect(second.changes).toEqual([]);
  expect(
    ((await loadCronStore(storePath)).jobs as unknown as Array<Record<string, unknown>>).map(
      (job) => job.id,
    ),
  ).toEqual(["variant-cron"]);
});
