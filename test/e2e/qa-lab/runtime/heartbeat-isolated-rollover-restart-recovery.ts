// QA Lab producer proves persisted deferred-rollover state survives a restart
// (#131770): phase 1 commits the deferral through the real rollover path,
// materializes the displaced transcript, and exits (simulated gateway stop
// before the admission released); phase 2 runs in a fresh process and the
// first real wake reclaims the persisted deferred generation from the row.
// Run without arguments to orchestrate both phases in fresh child processes:
//   node --import ./scripts/tsx.mjs test/e2e/qa-lab/runtime/heartbeat-isolated-rollover-restart-recovery.ts
// Or run the two processes manually (simulating a restart):
//   node --import ./scripts/tsx.mjs test/e2e/qa-lab/runtime/heartbeat-isolated-rollover-restart-recovery.ts phase1 <stateDir>
//   node --import ./scripts/tsx.mjs test/e2e/qa-lab/runtime/heartbeat-isolated-rollover-restart-recovery.ts phase2 <stateDir>
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const phase = process.argv[2];
const stateDir = process.argv[3];

if (phase === undefined && stateDir === undefined) {
  // Orchestration mode: run both phases in fresh child processes so each
  // phase still dies with its own admission and process state, exactly like
  // the manual two-process invocation above.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-hb-restart-"));
  const scriptPath = fileURLToPath(import.meta.url);
  const tsxLoader = path.resolve(path.dirname(scriptPath), "../../../..", "scripts/tsx.mjs");
  const runPhase = (name: "phase1" | "phase2"): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, scriptPath, name, dir], {
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${name} exited with code ${String(code)}`));
        }
      });
    });
  await runPhase("phase1");
  await runPhase("phase2");
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exit(0);
}

if ((phase !== "phase1" && phase !== "phase2") || !stateDir) {
  throw new Error("usage: <script> [phase1|phase2 <stateDir>]");
}
process.env.OPENCLAW_STATE_DIR = stateDir;
const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
const storePath = path.join(sessionsDir, "sessions.json");
await fs.mkdir(sessionsDir, { recursive: true });

const cfg = {
  agents: {
    list: [{ id: "main", default: true }],
    defaults: {
      workspace: path.join(stateDir, "workspace"),
      heartbeat: { every: "300s", target: "last", isolatedSession: true },
    },
  },
  session: { store: storePath },
  channels: {},
};

const { replaceSessionEntry, listSessionEntriesCore } =
  await import("../../../../src/config/sessions/session-accessor.js");
const { runHeartbeatOnce } = await import("../../../../src/infra/heartbeat-runner.js");

const isolatedKey = "agent:main:main:heartbeat";
const readRow = () =>
  listSessionEntriesCore({ storePath }).find(({ sessionKey }) => sessionKey === isolatedKey)?.entry;

if (phase === "phase1") {
  const now = Date.now();
  await replaceSessionEntry(
    { storePath, sessionKey: "agent:main:main" },
    {
      sessionId: "base-1",
      updatedAt: now - 120_000,
      systemSent: true,
    },
  );
  await replaceSessionEntry(
    { storePath, sessionKey: isolatedKey },
    {
      sessionId: "previous-wake",
      updatedAt: now - 60_000,
      systemSent: true,
      heartbeatIsolatedBaseSessionKey: "agent:main:main",
    },
  );

  const { beginSessionWorkAdmission } =
    await import("../../../../src/sessions/session-lifecycle-admission.js");
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [isolatedKey],
    assertAllowed: () => {},
  });

  // Real manual wake: its rollover defers the previous wake's generation.
  void runHeartbeatOnce({
    cfg,
    intent: "manual",
    source: "manual",
    deps: { getQueueSize: () => 0 },
  }).then(
    () => {},
    () => {},
  );
  let deferred = false;
  for (let i = 0; i < 200 && !deferred; i += 1) {
    await sleep(50);
    deferred = (readRow()?.pendingTranscriptArchiveSessionIds ?? []).includes("previous-wake");
  }
  if (!deferred) {
    throw new Error("deferral did not commit in phase 1");
  }

  await fs.writeFile(
    path.join(sessionsDir, "previous-wake.jsonl"),
    `{"type":"message","sessionKey":"${isolatedKey}"}\n`,
  );
  console.log(
    "phase1: deferred row:",
    JSON.stringify({
      sessionId: readRow()?.sessionId,
      pending: readRow()?.pendingTranscriptArchiveSessionIds,
    }),
  );
  console.log("phase1: sessions dir:", (await fs.readdir(sessionsDir)).join(", "));
  console.log("phase1: exiting with the deferred state persisted (simulated gateway stop)");
  // The lease and the in-flight wake die with the process: exactly the
  // "gateway stopped before the admission released" scenario.
  void lease;
  await sleep(250);
  process.exit(0);
}

// phase2: fresh process (simulated restart).
const before = readRow();
console.log(
  "phase2: row on restart:",
  JSON.stringify({
    sessionId: before?.sessionId,
    pending: before?.pendingTranscriptArchiveSessionIds,
  }),
);
console.log("phase2: sessions dir on restart:", (await fs.readdir(sessionsDir)).join(", "));
if (!(before?.pendingTranscriptArchiveSessionIds ?? []).includes("previous-wake")) {
  throw new Error("deferred state did not survive the restart");
}

// The first wake after restart reclaims the persisted deferred generation.
void runHeartbeatOnce({
  cfg,
  intent: "manual",
  source: "manual",
  deps: { getQueueSize: () => 0 },
}).then(
  () => {},
  () => {},
);
let capturedArchive = "";
for (let i = 0; i < 1200; i += 1) {
  const files = await fs.readdir(sessionsDir);
  capturedArchive =
    files.find((name) => name.startsWith("previous-wake.jsonl.")) ?? capturedArchive;
  if (capturedArchive && !files.includes("previous-wake.jsonl")) {
    break;
  }
  await sleep(100);
}
const row = readRow();
console.log(
  "phase2: row after wake:",
  JSON.stringify({
    sessionId: row?.sessionId,
    pending: row?.pendingTranscriptArchiveSessionIds ?? null,
  }),
);
console.log("phase2: sessions dir:", (await fs.readdir(sessionsDir)).join(", "));
if (!capturedArchive) {
  throw new Error("restart did not reclaim the deferred transcript");
}
console.log(
  `phase2 PROVEN: persisted deferred transcript reclaimed after restart as ${capturedArchive}`,
);
await sleep(250);
process.exit(0);
