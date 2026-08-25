// Real-behavior proof for #128755 (no internal mocking): a real Gateway
// `sessions.usage` request dispatched against an isolated on-disk session store
// and real transcript files. A subagent (`opus`) transcript reuses the parent
// session id; the durable named row owned by `main` must still be attributed to
// `main`. The logged request/response is the inspectable after-fix RPC trace.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { testState, writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

const PROOF_SESSION_ID = "tg-dm-owner-proof";
const PROOF_STORE_KEY = "agent:main:telegram:dm";

test("sessions.usage attributes a durable named row to its owner over real state (#128755)", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "usage-owner-attribution-remote-proof");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await createSessionStoreDir();
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "opus" }] };

    const mainStorePath = storeTemplate.replace("{agentId}", "main");
    const opusStorePath = storeTemplate.replace("{agentId}", "opus");
    await Promise.all([
      fs.mkdir(path.dirname(mainStorePath), { recursive: true }),
      fs.mkdir(path.dirname(opusStorePath), { recursive: true }),
    ]);

    // main owns the durable named row.
    await writeSessionStore({
      agentId: "main",
      storePath: mainStorePath,
      entries: {
        [PROOF_STORE_KEY]: sessionStoreEntry(PROOF_SESSION_ID, {
          label: "Telegram DM",
          updatedAt: 1_500,
        }),
      },
    });
    // main's own transcript for the owned session.
    await seedLinearSessionTranscript({
      agentId: "main",
      contents: ["owner turn"],
      sessionId: PROOF_SESSION_ID,
      sessionKey: PROOF_STORE_KEY,
      storePath: mainStorePath,
    });
    // opus subagent reuses the parent sessionId (discovery-only; no store row),
    // simulating the #128755 reproduction.
    await seedLinearSessionTranscript({
      agentId: "opus",
      contents: ["subagent turn"],
      sessionId: PROOF_SESSION_ID,
      sessionKey: `agent:opus:${PROOF_SESSION_ID}`,
      storePath: opusStorePath,
    });

    const requestParams = {
      agentScope: "all",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      limit: 50,
    };
    const result = await directSessionReq<{
      sessions: Array<{ key: string; agentId: string; sessionId: string }>;
    }>("sessions.usage", requestParams);

    // Redacted after-fix Gateway RPC trace (request + returned owner rows only).
    const trace = {
      method: "sessions.usage",
      request: requestParams,
      response: {
        ok: result.ok,
        sessions: (result.payload?.sessions ?? []).map((session) => ({
          key: session.key,
          agentId: session.agentId,
          sessionId: session.sessionId,
        })),
      },
    };
    console.log(`[#128755 remote-proof] ${JSON.stringify(trace)}`);

    expect(result.ok).toBe(true);
    const sessions = result.payload?.sessions ?? [];
    const owned = sessions.filter((session) => session.sessionId === PROOF_SESSION_ID);
    // The reused subagent transcript must not duplicate or shadow the owner row.
    expect(owned).toHaveLength(1);
    expect(owned[0]?.key).toBe(PROOF_STORE_KEY);
    // Owner attribution is correct: main, not the reused opus subagent.
    expect(owned[0]?.agentId).toBe("main");
    expect(owned.some((session) => session.agentId === "opus")).toBe(false);
  });
});
