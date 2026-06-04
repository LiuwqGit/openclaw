import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "./llm.js";
import type { AgentMessage, AgentTool, StreamFn } from "./types.js";

const model = {
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

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

describe("Agent tool snapshots", () => {
  it("skips unreadable initial tools and snapshots schemas before turn context exposure", async () => {
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
    const agent = new Agent({
      initialState: { model, tools: [unreadable, healthy] },
      streamFn: createStreamFn(contexts),
    });
    (healthySchema.properties.query as Record<string, unknown>).type = "number";

    await agent.prompt("hello");

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(contexts[0]?.tools?.[0]?.parameters).toMatchObject({
      properties: { query: { type: "string" } },
    });
    expect(
      Object.getOwnPropertyDescriptor(contexts[0]?.tools?.[0]?.parameters, "~kind"),
    ).toMatchObject({ enumerable: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent state tool "tool[0]": revoked name'),
    );
  });

  it("quarantines state tool assignments with unreadable parameter schemas", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const contexts: Context[] = [];
    const agent = new Agent({
      initialState: { model, tools: [createTool("initial_lookup")] },
      streamFn: createStreamFn(contexts),
    });

    agent.state.tools = [badTool, createTool("replacement_lookup")];
    await agent.prompt("hello");

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["replacement_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent state tool "bad_lookup": revoked parameters'),
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
    const agent = new Agent({
      initialState: { model },
      streamFn: createStreamFn(contexts),
      prepareNextTurn: () => ({
        context: {
          systemPrompt: "",
          messages: [],
          tools: [badTool, createTool("next_lookup")],
        },
      }),
    });
    agent.followUp(userMessage("again"));

    await agent.prompt("hello");

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["next_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent state tool "bad_lookup": revoked parameters'),
    );
  });
});
