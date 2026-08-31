// QA Lab producer proves isolated-heartbeat deferred rollover reclamation
// (#131770): a real manual wake rolls the stable isolated row while a real
// session-work admission (the same production primitive a reply turn holds)
// owns the lane; the replaced generation is deferred onto the committed row,
// its file-backed transcript materializes, and the archive rename happens when
// the admission releases — with no further heartbeat wake.
// Run: node --import ./scripts/tsx.mjs test/e2e/qa-lab/runtime/heartbeat-isolated-rollover-deferred-archive.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-hb-deferred-"));
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
const { beginSessionWorkAdmission } =
  await import("../../../../src/sessions/session-lifecycle-admission.js");
const { runHeartbeatOnce } = await import("../../../../src/infra/heartbeat-runner.js");

const isolatedKey = "agent:main:main:heartbeat";
const readRow = () =>
  listSessionEntriesCore({ storePath }).find(({ sessionKey }) => sessionKey === isolatedKey)?.entry;

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
await fs.writeFile(
  path.join(sessionsDir, "previous-wake.jsonl"),
  `{"type":"message","sessionKey":"${isolatedKey}"}\n`,
);

console.log("=== before: isolated row points at the previous wake ===");
console.log("row:", JSON.stringify({ sessionId: readRow()?.sessionId, pending: null }));

// A real admitted turn on the isolated lane (production admission primitive).
const lease = await beginSessionWorkAdmission({
  scope: storePath,
  identities: [isolatedKey],
  assertAllowed: () => {},
});
console.log("=== admitted turn held on the isolated lane (real admission lease) ===");

// Real manual wake: its rollover must DEFER the previous wake's generation.
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
console.log("=== after the real rollover: reclamation deferred onto the committed row ===");
console.log(
  "row:",
  JSON.stringify({
    sessionId: readRow()?.sessionId,
    pending: readRow()?.pendingTranscriptArchiveSessionIds,
  }),
);
if (!deferred) {
  throw new Error("deferral did not commit");
}

// The displaced wake's transcript materializes while its run is still admitted.
await fs.writeFile(
  path.join(sessionsDir, "previous-wake.jsonl"),
  `{"type":"message","sessionKey":"${isolatedKey}","message":{"role":"user","content":"wake prompt"}}\n`,
);
console.log("=== displaced transcript materialized while the lane is admitted ===");
console.log("sessions dir:", (await fs.readdir(sessionsDir)).join(", "));

// Release the admission: the terminal reclamation must archive the deferred
// transcript at release time, with no further heartbeat wake.
console.log("=== releasing the admission ===");
lease.release();
let archived = "";
for (let i = 0; i < 100 && !archived; i += 1) {
  await sleep(50);
  archived =
    (await fs.readdir(sessionsDir)).find((name) => name.startsWith("previous-wake.jsonl.")) ?? "";
}
console.log("=== after the admission released (no further wake) ===");
console.log("sessions dir:", (await fs.readdir(sessionsDir)).join(", "));
if (!archived) {
  throw new Error("deferred transcript was not archived at admission release");
}
console.log(`=== PROVEN: deferred transcript archived at release: ${archived} ===`);
await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.exit(0);
