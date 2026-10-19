// Sessions model alias display tests cover configured-alias resolution for rows
// without a persisted runtime model (issue #177311).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { sessionsCommand } from "./sessions.js";

const ALIAS = "opus";
const ALIAS_TARGET_PROVIDER = "anthropic";
const ALIAS_TARGET_MODEL = "claude-opus-5-5";

type SessionRow = {
  key: string;
  agentId: string;
  model: string;
  modelProvider: string;
};

let stateDir: string;
let cfg: OpenClawConfig;

function setConfig(config: OpenClawConfig): void {
  cfg = config;
  setRuntimeConfigSnapshot(cfg);
}

function writeSession(agentId: string, sessionKey: string): void {
  const storePath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  replaceSessionEntrySync(
    { agentId, sessionKey, storePath },
    {
      sessionId: `${agentId}-session`,
      lifecycleRevision: `${agentId}-session-revision`,
      updatedAt: Date.now() - 4 * 60_000,
    },
  );
}

async function readSessions(): Promise<SessionRow[]> {
  const logs: string[] = [];
  await sessionsCommand(
    { json: true, allAgents: true },
    {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      exit: (code) => {
        throw new Error(`Unexpected exit ${code}`);
      },
    },
  );
  return (JSON.parse(logs.join("\n")) as { sessions: SessionRow[] }).sessions;
}

describe("sessionsCommand configured-alias model display", () => {
  beforeEach(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-alias-sessions-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    try {
      await closeOpenClawAgentDatabasesAsync(stateDir);
      await closeOpenClawStateDatabaseAsync();
    } finally {
      closeOpenClawAgentDatabases(stateDir);
      closeOpenClawStateDatabase();
      clearRuntimeConfigSnapshot();
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("resolves the agent entry alias primary for sessions without a persisted model", async () => {
    setConfig({
      agents: {
        ownership: "explicit",
        entries: {
          arthur: { model: { primary: ALIAS } },
        },
        defaults: {
          models: {
            [`${ALIAS_TARGET_PROVIDER}/${ALIAS_TARGET_MODEL}`]: { alias: ALIAS },
          },
        },
      },
    });
    writeSession("arthur", "agent:arthur:backlog:tsk-20261019-091558");
    const rows = await readSessions();
    expect(rows.find((row) => row.agentId === "arthur")).toMatchObject({
      model: ALIAS_TARGET_MODEL,
      modelProvider: ALIAS_TARGET_PROVIDER,
    });
  });

  it("resolves the defaults-level alias primary when no agent entry model is set", async () => {
    setConfig({
      agents: {
        ownership: "explicit",
        entries: {
          arthur: {},
        },
        defaults: {
          model: { primary: ALIAS },
          models: {
            [`${ALIAS_TARGET_PROVIDER}/${ALIAS_TARGET_MODEL}`]: { alias: ALIAS },
          },
        },
      },
    });
    writeSession("arthur", "agent:arthur:tasks:standup");
    const rows = await readSessions();
    expect(rows.find((row) => row.agentId === "arthur")).toMatchObject({
      model: ALIAS_TARGET_MODEL,
      modelProvider: ALIAS_TARGET_PROVIDER,
    });
  });

  it("keeps the literal provider-qualified primary when no alias matches", async () => {
    setConfig({
      agents: {
        ownership: "explicit",
        entries: {
          arthur: { model: { primary: `${ALIAS_TARGET_PROVIDER}/${ALIAS_TARGET_MODEL}` } },
        },
        defaults: {
          models: {
            [`${ALIAS_TARGET_PROVIDER}/${ALIAS_TARGET_MODEL}`]: { alias: ALIAS },
          },
        },
      },
    });
    writeSession("arthur", "agent:arthur:review:queue");
    const rows = await readSessions();
    expect(rows.find((row) => row.agentId === "arthur")).toMatchObject({
      model: ALIAS_TARGET_MODEL,
      modelProvider: ALIAS_TARGET_PROVIDER,
    });
  });
});
