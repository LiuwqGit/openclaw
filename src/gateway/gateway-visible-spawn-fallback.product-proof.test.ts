// Real-Gateway product proof for #148886 / #148954: a visible `sessions_spawn`
// child whose configured primary is rate limited must complete through the
// configured fallback ladder instead of failing with `outcome=error`, and a
// child whose primary is inherited from `agents.defaults.model` must keep the
// subagent ladder rather than the global one.
//
// The Gateway server, session creation, embedded agent runner, model fallback
// orchestration, and provider HTTP transport all run for real here; only the
// upstream model provider is a scripted loopback HTTP server.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const PRIMARY_REF = "mock-openai/qa-primary";
const FALLBACK_REF = "mock-backup/qa-fallback";
const SUBAGENT_BACKUP_REF = "mock-backup/qa-subagent-backup";
const PROMPT_SPAWN = "Visible child fallback QA check: spawn one visible worker now.";
const WORKER_MARKER = "QA-VISIBLE-CHILD-FALLBACK-WORKER";
const CHILD_MARKER = "QA-VISIBLE-CHILD-FALLBACK-OK";
const PARENT_DONE = "QA-VISIBLE-CHILD-FALLBACK-PARENT-DONE";
const RATE_LIMIT_BODY = JSON.stringify({
  error: {
    message: "Rate limit exceeded for qa-primary",
    type: "rate_limit_exceeded",
    param: null,
    code: "rate_limit_exceeded",
  },
});

type ProviderRequest = {
  model: string;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
  [key: string]: unknown;
};
type ToolReceipt = {
  status: string;
  runId: string;
  childSessionKey?: string;
};
type RequestEvidence = {
  model: string;
  kind: "title" | "parent" | "child";
  served: "text" | "tool_call" | "rate_limit_429";
};

function toolOutput(body: ProviderRequest, callId: string): ToolReceipt | undefined {
  const output = body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === callId,
  )?.output;
  return output === undefined ? undefined : (JSON.parse(output) as ToolReceipt);
}

function writeToolCall(
  response: ServerResponse,
  name: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startProofProvider() {
  const requests: RequestEvidence[] = [];
  const errors: unknown[] = [];
  let spawn: ToolReceipt | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: ["qa-primary", "qa-fallback", "qa-subagent-backup"].map((id) => ({
              id,
              object: "model",
            })),
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
      const developerText = JSON.stringify(
        body.input.filter((item) => item.role === "developer" || item.role === "system"),
      );
      // Only the child's own run carries the worker marker in a user message; the
      // parent's follow-up request carries it inside the recorded tool-call args.
      const userText = JSON.stringify(body.input.filter((item) => item.role === "user"));
      const kind = developerText.includes("Generate a concise session title")
        ? "title"
        : userText.includes(WORKER_MARKER)
          ? "child"
          : "parent";
      const sequence = requests.length + 1;
      const reply = (text: string) => {
        requests.push({ model: body.model, kind, served: "text" });
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_qa_${sequence}`,
          responseId: `resp_qa_${sequence}`,
        });
      };
      if (kind === "title") {
        reply("Visible child fallback proof");
      } else if (kind === "child") {
        if (body.model === "qa-primary") {
          // The reported production symptom: the configured primary is rate limited.
          requests.push({ model: body.model, kind, served: "rate_limit_429" });
          response.writeHead(429, { "content-type": "application/json" });
          response.end(RATE_LIMIT_BODY);
          return;
        }
        reply(CHILD_MARKER);
      } else {
        spawn = toolOutput(body, "call_qa_spawn") ?? spawn;
        if (spawn) {
          reply(PARENT_DONE);
        } else {
          requests.push({ model: body.model, kind, served: "tool_call" });
          writeToolCall(response, "sessions_spawn", "call_qa_spawn", {
            task: `Visible child fallback worker ${WORKER_MARKER}. Return exactly ${CHILD_MARKER}.`,
            label: "qa-visible-child-fallback",
            visible: true,
            mode: "run",
            // Deliberately no `model`: the child must inherit the configured
            // selection and keep its fallback ladder.
            expectsCompletionMessage: false,
          });
        }
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    get spawn() {
      return spawn;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function proofModel(id: string) {
  return {
    id,
    name: id,
    api: "openai-responses" as const,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function proofProviderConfig(baseUrl: string, models: ReturnType<typeof proofModel>[]) {
  return {
    baseUrl: `${baseUrl}/v1`,
    apiKey: "test",
    api: "openai-responses" as const,
    request: { allowPrivateNetwork: true },
    models,
  };
}

const RUN_PARAMS = { transport: "sse" as const, openaiWsWarmup: false };

type ProofScenario = {
  name: string;
  buildConfig: (params: { workspaceDir: string; baseUrl: string; token: string }) => OpenClawConfig;
  expectedFallbackModel: string;
  forbiddenFallbackModel?: string;
  expectOriginMetadata: boolean;
};

const agentLadderScenario: ProofScenario = {
  name: "agent-ladder",
  // Issue shape: `agents.entries.<agent>.model = { primary, fallbacks }` and no
  // `subagents.model` anywhere; the child inherits the agent primary.
  buildConfig: ({ workspaceDir, baseUrl, token }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        subagents: { allowAgents: ["*"], maxConcurrent: 2 },
        models: {
          [PRIMARY_REF]: { params: RUN_PARAMS },
          [FALLBACK_REF]: { params: RUN_PARAMS },
          [SUBAGENT_BACKUP_REF]: { params: RUN_PARAMS },
        },
      },
      entries: {
        main: { model: { primary: PRIMARY_REF, fallbacks: [FALLBACK_REF] } },
      },
    },
    models: {
      mode: "replace",
      providers: {
        "mock-openai": proofProviderConfig(baseUrl, [proofModel("qa-primary")]),
        "mock-backup": proofProviderConfig(baseUrl, [
          proofModel("qa-fallback"),
          proofModel("qa-subagent-backup"),
        ]),
      },
    },
    tools: { profile: "coding" },
    gateway: { auth: { mode: "token", token } },
    hooks: { enabled: false },
  }),
  expectedFallbackModel: "qa-fallback",
  expectOriginMetadata: true,
};

const inheritedPrimaryScenario: ProofScenario = {
  name: "inherited-primary-subagent-ladder",
  // P1 review shape: the primary is inherited from `agents.defaults.model` while
  // `agents.defaults.subagents.model` declares its own ladder, so the stored
  // child entry carries no origin metadata and reads back as no override.
  buildConfig: ({ workspaceDir, baseUrl, token }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        model: { primary: PRIMARY_REF, fallbacks: [FALLBACK_REF] },
        subagents: {
          allowAgents: ["*"],
          maxConcurrent: 2,
          model: { fallbacks: [SUBAGENT_BACKUP_REF] },
        },
        models: {
          [PRIMARY_REF]: { params: RUN_PARAMS },
          [FALLBACK_REF]: { params: RUN_PARAMS },
          [SUBAGENT_BACKUP_REF]: { params: RUN_PARAMS },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        "mock-openai": proofProviderConfig(baseUrl, [proofModel("qa-primary")]),
        "mock-backup": proofProviderConfig(baseUrl, [
          proofModel("qa-fallback"),
          proofModel("qa-subagent-backup"),
        ]),
      },
    },
    tools: { profile: "coding" },
    gateway: { auth: { mode: "token", token } },
    hooks: { enabled: false },
  }),
  expectedFallbackModel: "qa-subagent-backup",
  forbiddenFallbackModel: "qa-fallback",
  expectOriginMetadata: false,
};

describe("visible sessions_spawn child model fallback (product proof)", () => {
  afterAll(() => {
    resetGatewayTestState();
  });

  async function runVisibleChildFallbackProof(scenario: ProofScenario): Promise<void> {
    resetGatewayTestState();
    const home = await setupGatewayTempHome({ prefix: "openclaw-visible-spawn-fallback-" });
    const provider = await startProofProvider();
    const token = randomUUID();
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    const cfg = scenario.buildConfig({
      workspaceDir: home.workspaceDir,
      baseUrl: provider.baseUrl,
      token,
    });
    const port = await getGatewayE2ePortBlock();
    const gateway = await startGatewayWithClient({
      cfg,
      port,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      configPath: await createGatewayConfigPath(home.tempHome),
      token,
      clientDisplayName: `visible-spawn-fallback-${scenario.name}`,
    });
    await gateway.server.startupSettled;
    try {
      const parentKey = `agent:main:proof-${randomUUID()}`;
      const accepted = await gateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey: parentKey,
          message: PROMPT_SPAWN,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
      );
      expect(accepted.status, JSON.stringify(provider.requests)).toBe("started");
      const parentTerminal = await gateway.client.request<{ status: string }>(
        "agent.wait",
        { runId: accepted.runId, timeoutMs: 240_000 },
        { timeoutMs: 245_000 },
      );
      if (parentTerminal.status !== "ok") {
        console.log(
          JSON.stringify(
            { debugParentTerminal: parentTerminal, debugRequests: provider.requests },
            null,
            2,
          ),
        );
      }
      expect(parentTerminal.status).toBe("ok");

      // State-based wait: the spawned child's own run must settle before its
      // stored entry, history, and provider trace are read.
      const listSessions = async () =>
        (await gateway.client.request("sessions.list", {
          agentId: "main",
          limit: 100,
        })) as SessionsListResult;
      const deadline = Date.now() + 240_000;
      let child: SessionsListResult["sessions"][number] | undefined;
      for (;;) {
        const { sessions } = await listSessions();
        child = sessions.find((entry) => entry.parentSessionKey === parentKey);
        if (child && child.hasActiveRun === false) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `visible child run did not settle: ${JSON.stringify({
              childKey: child?.key,
              hasActiveRun: child?.hasActiveRun,
              requests: provider.requests,
            })}`,
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
      }
      const childKey = child?.key ?? "";
      expect(childKey).toMatch(/^agent:main:dashboard:[A-Za-z0-9-]+$/);

      const history = await gateway.client.request<{
        messages: Array<{ role?: string; content?: unknown }>;
      }>("chat.history", { sessionKey: childKey, limit: 100 });
      const childText = (history.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .flatMap((part) =>
                    part &&
                    typeof part === "object" &&
                    typeof (part as { text?: unknown }).text === "string"
                      ? [(part as { text: string }).text]
                      : [],
                  )
                  .join("\n")
              : "",
        )
        .join("\n");
      const entry = loadSessionEntryReadOnly({ sessionKey: childKey, agentId: "main" });
      const evidence = {
        scenario: scenario.name,
        providerRequests: provider.requests,
        spawn: provider.spawn,
        childRow: {
          key: child?.key,
          spawnedBy: child?.spawnedBy,
          parentSessionKey: child?.parentSessionKey,
          model: child?.model,
          modelProvider: child?.modelProvider,
          modelOverrideSource: child?.modelOverrideSource,
          hasActiveRun: child?.hasActiveRun,
        },
        childEntry: {
          providerOverride: entry?.providerOverride ?? null,
          modelOverride: entry?.modelOverride ?? null,
          modelOverrideSource: entry?.modelOverrideSource ?? null,
          modelOverrideFallbackOriginProvider: entry?.modelOverrideFallbackOriginProvider ?? null,
          modelOverrideFallbackOriginModel: entry?.modelOverrideFallbackOriginModel ?? null,
        },
        childReply: childText,
      };
      console.log(JSON.stringify({ phase: "visible-spawn-child-fallback", evidence }, null, 2));

      expect(provider.errors, JSON.stringify(evidence)).toEqual([]);
      // The child stores the config-resolved model as an automatic selection,
      // never as a user pin (the reported defect stored `modelOverrideSource: "user"`).
      expect(evidence.childEntry.modelOverrideSource, JSON.stringify(evidence)).toBe("auto");
      if (scenario.expectOriginMetadata) {
        expect(
          evidence.childEntry.modelOverrideFallbackOriginProvider,
          JSON.stringify(evidence),
        ).toBe("mock-openai");
        expect(evidence.childEntry.modelOverrideFallbackOriginModel, JSON.stringify(evidence)).toBe(
          "qa-primary",
        );
      }
      // The child hit the rate-limited primary and completed through its ladder.
      expect(
        provider.requests.some(
          (request) => request.kind === "child" && request.served === "rate_limit_429",
        ),
        JSON.stringify(evidence),
      ).toBe(true);
      expect(
        provider.requests.some(
          (request) => request.kind === "child" && request.model === scenario.expectedFallbackModel,
        ),
        JSON.stringify(evidence),
      ).toBe(true);
      if (scenario.forbiddenFallbackModel) {
        expect(
          provider.requests.some(
            (request) =>
              request.kind === "child" && request.model === scenario.forbiddenFallbackModel,
          ),
          JSON.stringify(evidence),
        ).toBe(false);
      }
      expect(childText, JSON.stringify(evidence)).toContain(CHILD_MARKER);
    } finally {
      try {
        await disconnectGatewayClient(gateway.client);
      } finally {
        await gateway.server.close({ reason: "visible spawn fallback proof complete" });
      }
      await provider.stop();
      await removeGatewayTempHome(home.tempHome);
      home.envSnapshot.restore();
      resetGatewayTestState();
    }
  }

  it("completes a visible child through the configured fallback when the primary is rate limited", async () => {
    await runVisibleChildFallbackProof(agentLadderScenario);
  }, 600_000);

  it("keeps an inherited-primary visible child on the subagent fallback ladder", async () => {
    await runVisibleChildFallbackProof(inheritedPrimaryScenario);
  }, 600_000);
});
