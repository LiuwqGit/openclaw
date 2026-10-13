import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  AgentDatabaseStartupSupersededError,
  withAgentDatabaseStartupAdmission,
} from "./agent-database-startup.js";
import { AGENT_DATABASE_STARTUP_SUPERSEDED_ATTEMPTS } from "./openclaw-agent-db-contract.js";

const admissionState = vi.hoisted(() => ({
  failed: [] as unknown[],
  prepared: 0,
}));

// mock-isolation: admission bookkeeping is observed without the real refusal store.
vi.mock("./agent-database-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-database-admission.js")>();
  return {
    ...actual,
    preparePendingAgentDatabase: vi.fn(async (_refusal, _options, run) => {
      await run();
      admissionState.prepared += 1;
    }),
    failPendingAgentDatabase: vi.fn((_refusal, cause) => {
      admissionState.failed.push(cause);
    }),
    readAgentDatabaseAdmissionRefusal: vi.fn(() => undefined),
  };
});

// mock-isolation: Journal transport is independent of the superseded-retry contract.
vi.mock("./agent-deletion-journal.read.js", () => ({
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => "absent"),
}));

// mock-isolation: Exercise the retry contract without native worker processes.
vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>();
  return {
    ...actual,
    withSqliteReadOnlyWorkerScope: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  admissionState.failed = [];
  admissionState.prepared = 0;
});

function runDeferredPreparation(publishAgent: () => Promise<void>): Promise<void> {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("superseded-retry-") };
  const sharedPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.writeFileSync(sharedPath, "synthetic file identity; native admission is mocked");
  const inspections = [
    {
      target: { agentId: "large", path: sharedPath },
      result: Promise.resolve({ incompatible: [], indeterminate: [] }),
    },
  ] as never[];
  return withAgentDatabaseStartupAdmission(async (admission) => {
    admission.adopt();
    admission.defer({
      env,
      inspections,
      reason: "superseded retry regression",
    });
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent,
    });
    await admission.pendingPreparation;
  });
}

it("retries a superseded deferred publication against the current runtime before admitting", async () => {
  let attempts = 0;
  await runDeferredPreparation(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new AgentDatabaseStartupSupersededError("large", "startup");
    }
  });
  expect(attempts).toBe(2);
  expect(admissionState.prepared).toBe(1);
  expect(admissionState.failed).toEqual([]);
});

it("keeps a permanently superseded publication terminal after the bounded attempts", async () => {
  let attempts = 0;
  await runDeferredPreparation(async () => {
    attempts += 1;
    throw new AgentDatabaseStartupSupersededError("large", "startup");
  });
  expect(attempts).toBe(AGENT_DATABASE_STARTUP_SUPERSEDED_ATTEMPTS);
  expect(admissionState.prepared).toBe(0);
  expect(admissionState.failed).toEqual([expect.any(AgentDatabaseStartupSupersededError)]);
});
