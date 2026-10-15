/**
 * Real runtime proof for PR #173432: a session saved with toolOverrides.webSearch=false
 * through the session API keeps the override persisted, and `tools.effective` — called
 * before any inference — omits the core `web_search` tool while a session without the
 * override keeps it. Changing the saved override while the base preview cache is fresh
 * never serves the other state's cached inventory, and none of these preview reads
 * trigger a model request.
 */
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const TOKEN = "pr173432-proof-token";

type ToolsEffectivePayload = {
  groups?: Array<{ tools?: Array<{ id?: string }> }>;
};

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-pr173432-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

async function collectToolIds(
  request: (method: string, params: unknown) => Promise<ToolsEffectivePayload>,
  sessionKey: string,
): Promise<string[]> {
  const inventory = await request("tools.effective", { sessionKey });
  return (inventory.groups ?? []).flatMap((group) => (group.tools ?? []).map((tool) => tool.id!));
}

describe("PR #173432 real runtime proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "omits core web_search from tools.effective for a saved webSearch=false override, without inference",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: Array<{ method: string; url: string }> = [];

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr173432-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: TOKEN,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        // Loopback model endpoint: it must stay untouched — the preview path may
        // never trigger a model run.
        providerServer = createServer((request, response) => {
          providerRequests.push({ method: request.method ?? "", url: request.url ?? "" });
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "no inference expected" }));
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockAnthropicProvider(`http://127.0.0.1:${providerAddress.port}`);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
            },
            entries: { main: {} },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          tools: { web: { search: { enabled: true, provider: "brave" } } },
          // The Brave provider ships as an official plugin; declaring it here keeps
          // the uninstalled optional provider a startup warning instead of an error
          // while `tools.web.search.provider` keeps the managed tool configured.
          plugins: { allow: ["brave"] },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "pr173432-proof",
        });
        const request = gateway.client.request.bind(gateway.client);

        // 1. Save webSearch=false through the session API, before any inference.
        const restrictedKey = "agent:main:pr173432-restricted";
        const created = await request<{ ok?: boolean; runStarted?: boolean; sessionId?: string }>(
          "sessions.create",
          { agentId: "main", key: restrictedKey, toolOverrides: { webSearch: false } },
        );
        expect(created.ok).toBe(true);
        expect(created.runStarted).toBe(false);

        // 2. Confirm the override remains saved.
        const history = await request<{ toolOverrides?: { webSearch?: boolean } }>("chat.history", {
          sessionKey: restrictedKey,
          limit: 10,
        });
        expect(history.toolOverrides).toEqual({ webSearch: false });

        // 3. tools.effective before inference omits core web_search.
        const restrictedTools = await collectToolIds(request, restrictedKey);
        expect(restrictedTools).not.toContain("web_search");

        // 4. A session without the saved override keeps globally permitted web_search.
        const unsetKey = "agent:main:pr173432-unset";
        await request("sessions.create", { agentId: "main", key: unsetKey });
        const unsetTools = await collectToolIds(request, unsetKey);
        expect(unsetTools).toContain("web_search");

        // 5. Changing the saved override while the base preview cache is fresh never
        //    serves the unrestricted state's cached inventory.
        const flipKey = "agent:main:pr173432-flip";
        await request("sessions.create", { agentId: "main", key: flipKey });
        const flipToolsBefore = await collectToolIds(request, flipKey);
        expect(flipToolsBefore).toContain("web_search");
        await request("sessions.patch", { key: flipKey, toolOverrides: { webSearch: false } });
        const flipToolsAfter = await collectToolIds(request, flipKey);
        expect(flipToolsAfter).not.toContain("web_search");

        // The preview path never reached the model provider.
        expect(providerRequests).toEqual([]);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
