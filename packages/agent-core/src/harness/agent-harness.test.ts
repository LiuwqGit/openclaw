import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamFn,
} from "../llm.js";
import type { AgentCoreRuntimeDeps } from "../runtime-deps.js";
import type { AgentTool } from "../types.js";
import { CoreAgentHarness } from "./agent-harness.js";
import { NodeExecutionEnv } from "./env/nodejs.js";
import { InMemorySessionStorage } from "./session/memory-storage.js";
import { Session } from "./session/session.js";

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

function createRuntime(onContext: (context: Context) => void): AgentCoreRuntimeDeps {
  const streamSimple: StreamFn = (_model, context) => {
    onContext(context);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistantMessage });
    return stream;
  };
  return {
    streamSimple,
    completeSimple: async () => assistantMessage,
  };
}

function createHarness(
  tools: AgentTool[],
  onContext: (context: Context) => void,
): CoreAgentHarness {
  return new CoreAgentHarness({
    env: new NodeExecutionEnv({ cwd: "/" }),
    session: new Session(new InMemorySessionStorage()),
    model,
    tools,
    runtime: createRuntime(onContext),
  });
}

describe("CoreAgentHarness tool snapshots", () => {
  it("skips unreadable tools and snapshots schemas before turn context exposure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const healthySchema = Type.Object({ query: Type.String() });
    const healthy = createTool("healthy_lookup", healthySchema);
    const unreadable = createTool("bad_lookup");
    Object.defineProperty(unreadable, "name", {
      get() {
        throw new Error("revoked name");
      },
    });
    let seenTools: AgentTool[] | undefined;

    const harness = createHarness([unreadable, healthy], (context) => {
      seenTools = context.tools as AgentTool[] | undefined;
    });
    (healthySchema.properties.query as Record<string, unknown>).type = "number";

    await harness.prompt("hello");

    expect(seenTools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(seenTools?.[0]?.parameters).toMatchObject({
      properties: { query: { type: "string" } },
    });
    expect(Object.getOwnPropertyDescriptor(seenTools?.[0]?.parameters, "~kind")).toMatchObject({
      enumerable: false,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid harness tool "tool[0]": revoked name'),
    );
  });

  it("quarantines setTools entries with unreadable parameter schemas", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const replacement = createTool("replacement_lookup");
    let seenTools: AgentTool[] | undefined;
    const harness = createHarness([createTool("initial_lookup")], (context) => {
      seenTools = context.tools as AgentTool[] | undefined;
    });

    await harness.setTools([badTool, replacement], ["replacement_lookup"]);
    await harness.prompt("hello");

    expect(seenTools?.map((tool) => tool.name)).toEqual(["replacement_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid harness tool "bad_lookup": revoked parameters'),
    );
  });

  it("keeps tools with empty descriptions", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = createTool("empty_description");
    tool.description = "";
    let seenTools: AgentTool[] | undefined;
    const harness = createHarness([tool], (context) => {
      seenTools = context.tools as AgentTool[] | undefined;
    });

    await harness.prompt("hello");

    expect(seenTools?.map((entry) => [entry.name, entry.description])).toEqual([
      ["empty_description", ""],
    ]);
  });
});
