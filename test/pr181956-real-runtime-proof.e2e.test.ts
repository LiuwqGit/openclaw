// The shipped gateway must not advertise chat commands the deployment disabled (#181956).
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const TOKEN = "pr181956-proof-token";
const TURN_MARKER = "PR181956_ACK";

function anthropicTextTurn(): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_pr181956",
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TURN_MARKER } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

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
    apiKey: "sk-ant-api03-pr181956-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

type CapturedRequest = { method: string; url: string; systemText: string };

function extractSystemText(body: string): string {
  const parsed = JSON.parse(body) as { system?: unknown };
  const system = parsed.system;
  if (typeof system === "string") {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function probeCommandGuidance(prompt: string) {
  return {
    updateChatGuidance: prompt.includes("owner can send `/update`"),
    restartInChatClause: prompt.includes("`/restart` in chat"),
    reasoningToggleHint: prompt.includes("Toggle /reasoning; /status shows when enabled."),
    gatewayUpdateGuidance: prompt.includes("Update OpenClaw: `gateway` action update.run"),
    controlUiUpdateFallback: prompt.includes(
      "Control UI or ask the operator to run `openclaw update`",
    ),
    directUserToUpdate: prompt.includes("direct the user to `/update`"),
  };
}

async function runGatewayChatTurn(
  extraConfig: Record<string, unknown>,
  sessionKey: string,
  idempotencyKey: string,
): Promise<{ request: CapturedRequest; prompt: string }> {
  const fixture = await createFixture("openclaw-pr181956-proof-", TOKEN);
  const { configPath } = fixture;
  let providerServer: ReturnType<typeof createServer> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  const captured: CapturedRequest[] = [];
  try {
    providerServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        captured.push({
          method: request.method ?? "",
          url: request.url ?? "",
          systemText: extractSystemText(body),
        });
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        response.end(anthropicTextTurn());
      });
    });
    const providerUrl = await listenProofProvider(providerServer);
    const cfg = fixture.config(buildMockAnthropicProvider(providerUrl), {}, extraConfig);
    gateway = await startGatewayWithClient({
      cfg,
      configPath,
      token: TOKEN,
      clientDisplayName: "pr181956-proof",
    });
    const started = await gateway.client.request<{ runId?: string; status?: string }>("chat.send", {
      sessionKey,
      message: "say ack",
      deliver: false,
      idempotencyKey,
    });
    expect(started.status).toBe("started");
    const waited = await gateway.client.request<{ status?: string }>(
      "agent.wait",
      { runId: started.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(waited).toMatchObject({ status: "ok" });
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const request = captured[0] as CapturedRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/messages");
    expect(request.systemText.length).toBeGreaterThan(0);
    return { request, prompt: request.systemText };
  } finally {
    await fixture.close(gateway, providerServer);
  }
}

it(
  "keeps default command guidance in the provider-bound system prompt through the real gateway",
  { timeout: 120_000 },
  async () => {
    const { prompt } = await runGatewayChatTurn(
      {},
      "agent:main:pr181956-default-proof",
      "pr181956-default-proof-turn",
    );
    const guidance = probeCommandGuidance(prompt);
    console.log(
      JSON.stringify(
        {
          case: "default config (commands.restart defaults to true)",
          capture: { transport: "POST /v1/messages", api: "anthropic-messages", model: MODEL_ID },
          guidance,
        },
        null,
        2,
      ),
    );
    expect(guidance).toEqual({
      updateChatGuidance: true,
      restartInChatClause: false,
      reasoningToggleHint: true,
      gatewayUpdateGuidance: true,
      controlUiUpdateFallback: false,
      directUserToUpdate: false,
    });
  },
);

it(
  "drops disabled chat command guidance in the provider-bound system prompt through the real gateway",
  { timeout: 120_000 },
  async () => {
    const { prompt } = await runGatewayChatTurn(
      { commands: { restart: false } },
      "agent:main:pr181956-disabled-proof",
      "pr181956-disabled-proof-turn",
    );
    const guidance = probeCommandGuidance(prompt);
    console.log(
      JSON.stringify(
        {
          case: "commands.restart=false",
          capture: { transport: "POST /v1/messages", api: "anthropic-messages", model: MODEL_ID },
          guidance,
        },
        null,
        2,
      ),
    );
    expect(guidance).toEqual({
      updateChatGuidance: false,
      restartInChatClause: false,
      reasoningToggleHint: true,
      gatewayUpdateGuidance: true,
      controlUiUpdateFallback: false,
      directUserToUpdate: false,
    });
  },
);
