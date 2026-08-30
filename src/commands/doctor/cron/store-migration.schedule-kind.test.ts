// Regression tests for legacy schedule-kind canonicalization during doctor
// migration (#133347): rows whose schedule kind is a recognized case/whitespace
// variant are normalizable by the public input path and must not be quarantined
// as invalid-schedule when the legacy JSON inventory migrates into SQLite.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "../../../cron/persisted-shape.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    name: "Legacy job",
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    state: {},
    ...overrides,
  };
}

describe("normalizeStoredCronJobs schedule kind canonicalization", () => {
  it("canonicalizes recognized legacy schedule kinds instead of quarantining them (#133347)", () => {
    const jobs = [
      makeLegacyJob({
        id: "legacy-cron-kind",
        enabled: true,
        schedule: { kind: "Cron", expr: "0 9 * * *", tz: "UTC" },
      }),
      makeLegacyJob({
        id: "legacy-every-kind",
        enabled: false,
        schedule: { kind: " every ", everyMs: 60_000 },
      }),
      makeLegacyJob({
        id: "legacy-stream-kind",
        enabled: true,
        schedule: { kind: "Stream", command: ["watch-source"], mode: "Line" },
      }),
      makeLegacyJob({
        id: "legacy-at-kind",
        enabled: true,
        schedule: { kind: "At", at: "2026-04-01T10:00:00.000Z" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect(result.issues.legacyScheduleKind).toBe(4);
    expect(result.removedJobs).toEqual([]);
    expect(jobs.map((job) => job.id)).toEqual([
      "legacy-cron-kind",
      "legacy-every-kind",
      "legacy-stream-kind",
      "legacy-at-kind",
    ]);
    const scheduleOf = (index: number) => jobs[index]?.schedule as Record<string, unknown>;
    expect(scheduleOf(0)?.kind).toBe("cron");
    expect(jobs[0]?.enabled).toBe(true);
    expect(scheduleOf(1)?.kind).toBe("every");
    expect(jobs[1]?.enabled).toBe(false);
    expect(scheduleOf(3)?.kind).toBe("at");
    expect(scheduleOf(2)?.kind).toBe("stream");
    expect(scheduleOf(2)?.mode).toBe("line");
    // Canonicalized rows must survive the strict persisted-shape validation
    // that gates runtime scheduling, not just the migration pass.
    for (const job of jobs) {
      expect(getInvalidPersistedCronJobReason(job)).toBeNull();
    }
  });

  it("still quarantines unrecognized legacy schedule kinds (#133347)", () => {
    const jobs = [
      makeLegacyJob({
        id: "legacy-unknown-kind",
        schedule: { kind: "daily", at: "09:00" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.issues.invalidSchedule).toBe(1);
    expect(result.removedJobs[0]?.reason).toBe("invalid-schedule");
    expect(jobs).toEqual([]);
  });

  it("keeps already-canonical schedule kinds untouched without reporting an issue", () => {
    const jobs = [
      makeLegacyJob({
        id: "canonical-cron",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.issues.legacyScheduleKind).toBeUndefined();
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect(result.removedJobs).toEqual([]);
    const [job] = jobs;
    expect(
      (expectDefined(job, "job test invariant").schedule as Record<string, unknown>).kind,
    ).toBe("cron");
  });
});
