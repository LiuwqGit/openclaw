// Real-behavior proof for #128755 over an authenticated Gateway WebSocket
// session (no internal mocking): a real `sessions.usage` RPC dispatched through
// a loopback token-authenticated Gateway server against an isolated on-disk
// session store and real transcript files. `main` owns the durable named row;
// an `opus` subagent transcript reuses the same sessionId. The returned owner
// row is captured for the redacted after-fix RPC trace.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  startServer,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import {
  seedLinearSessionTranscript,
  sessionStoreEntry,
} from "../test/server-sessions.test-helpers.js";

installGatewayTestHooks();

const WS_PROOF_SESSION_ID = "tg-dm-ws-owner-proof";
const WS_PROOF_STORE_KEY = "agent:main:telegram:dm";
const WS_PROOF_TOKEN = "usage-owner-ws-proof-token";

it("attributes a durable named row to its owner over authenticated WebSocket RPC (#128755)", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-owner-ws-proof-"));
  const prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
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

    // main owns the durable named row and its transcript.
    await writeSessionStore({
      agentId: "main",
      storePath: mainStorePath,
      entries: {
        [WS_PROOF_STORE_KEY]: sessionStoreEntry(WS_PROOF_SESSION_ID, {
          label: "Telegram DM",
        }),
      },
    });
    await seedLinearSessionTranscript({
      agentId: "main",
      contents: ["owner turn"],
      sessionId: WS_PROOF_SESSION_ID,
      sessionKey: WS_PROOF_STORE_KEY,
      storePath: mainStorePath,
    });
    // opus subagent reuses the parent sessionId (discovery-only, no store row).
    await seedLinearSessionTranscript({
      agentId: "opus",
      contents: ["subagent turn"],
      sessionId: WS_PROOF_SESSION_ID,
      sessionKey: `agent:opus:${WS_PROOF_SESSION_ID}`,
      storePath: opusStorePath,
    });

    const { server, port } = await startServer(WS_PROOF_TOKEN);
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: WS_PROOF_TOKEN,
      role: "operator",
      clientDisplayName: "usage-owner-ws-proof",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    });
    try {
      const requestParams = {
        agentScope: "all",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        limit: 50,
      };
      const result = await client.request<{
        sessions: Array<{ key: string; agentId: string; sessionId: string }>;
      }>("sessions.usage", requestParams, { timeoutMs: 15_000 });

      const sessions = result?.sessions ?? [];
      const trace = {
        method: "sessions.usage",
        transport: "authenticated WebSocket (token)",
        request: requestParams,
        response: {
          ok: true,
          sessions: sessions.map((session) => ({
            key: session.key,
            agentId: session.agentId,
            sessionId: session.sessionId,
          })),
        },
      };
      console.log(`[#128755 ws-proof] ${JSON.stringify(trace)}`);

      const owned = sessions.filter((session) => session.sessionId === WS_PROOF_SESSION_ID);
      // The reused subagent transcript must not duplicate or shadow the owner row.
      expect(owned).toHaveLength(1);
      expect(owned[0]?.key).toBe(WS_PROOF_STORE_KEY);
      // Owner attribution is correct: main, not the reused opus subagent.
      expect(owned[0]?.agentId).toBe("main");
      expect(owned.some((session) => session.agentId === "opus")).toBe(false);
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
