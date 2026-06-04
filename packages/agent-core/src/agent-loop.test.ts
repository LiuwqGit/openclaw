import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

function createTool(name: string, parameters = Type.Object({ query: Type.String() })): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters,
    execute: async () => ({
      content: [{ type: "text", text: "done" }],
      details: {},
    }),
  };
}

function createStreamFn(contexts: Context[]): StreamFn {
  return (_model, context) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistantMessage });
    return stream;
  };
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });
});

describe("agentLoop tool snapshots", () => {
  it("sanitizes prompt-run context tools before provider exposure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const healthySchema = Type.Object({ query: Type.String() });
    const healthy = createTool("healthy_lookup", healthySchema);
    const unreadable = createTool("bad_lookup");
    Object.defineProperty(unreadable, "name", {
      get() {
        throw new Error("revoked name");
      },
    });
    const contexts: Context[] = [];

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [unreadable, healthy] },
      config,
      undefined,
      createStreamFn(contexts),
    );
    (healthySchema.properties.query as Record<string, unknown>).type = "number";
    await collectEvents(stream);

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(contexts[0]?.tools?.[0]?.parameters).toMatchObject({
      properties: { query: { type: "string" } },
    });
    expect(
      Object.getOwnPropertyDescriptor(contexts[0]?.tools?.[0]?.parameters, "~kind"),
    ).toMatchObject({ enumerable: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "tool[0]": revoked name'),
    );
  });

  it("sanitizes continue-run context tools before provider exposure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const contexts: Context[] = [];

    const stream = agentLoopContinue(
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [badTool, createTool("healthy_lookup")],
      },
      config,
      undefined,
      createStreamFn(contexts),
    );
    await collectEvents(stream);

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "bad_lookup": revoked parameters'),
    );
  });

  it("sanitizes prepareNextTurn replacement context tools", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const contexts: Context[] = [];
    let followUpPending = true;
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        getFollowUpMessages: async () => {
          if (!followUpPending) {
            return [];
          }
          followUpPending = false;
          return [{ role: "user", content: "again", timestamp: 2 }];
        },
        prepareNextTurn: () => ({
          context: {
            systemPrompt: "",
            messages: [],
            tools: [badTool, createTool("next_lookup")],
          },
        }),
      },
      undefined,
      createStreamFn(contexts),
    );
    await collectEvents(stream);

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["next_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "bad_lookup": revoked parameters'),
    );
  });
});
