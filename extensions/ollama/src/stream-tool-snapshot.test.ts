import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { createOllamaStreamFn } from "./stream.js";

type GuardedFetchCall = {
  init?: RequestInit;
};

function getGuardedFetchCall(): GuardedFetchCall {
  return (fetchWithSsrFGuardMock.mock.calls.at(0)?.[0] as GuardedFetchCall | undefined) ?? {};
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function mockNdjsonFetch(): void {
  fetchWithSsrFGuardMock.mockImplementation(async () => ({
    response: new Response(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ].join("\n") + "\n",
      {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      },
    ),
    release: vi.fn(async () => undefined),
  }));
}

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

describe("Ollama stream tool snapshots", () => {
  it("skips unreadable native Ollama tools before sending the chat request", async () => {
    mockNdjsonFetch();
    const streamFn = createOllamaStreamFn("http://ollama-host:11434");
    const unreadableTool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    } = {
      name: "revoked_name",
      description: "bad",
      parameters: { type: "object", properties: {} },
    };
    Object.defineProperty(unreadableTool, "name", {
      enumerable: true,
      get() {
        throw new Error("tool revoked");
      },
    });
    const schemaWithRevokedProperty = {
      type: "object",
      properties: {},
    };
    Object.defineProperty(schemaWithRevokedProperty, "properties", {
      enumerable: true,
      get() {
        throw new Error("schema revoked");
      },
    });
    const sharedStringSchema = { type: "string" };

    const stream = await Promise.resolve(
      streamFn(
        {
          api: "ollama",
          provider: "ollama",
          id: "qwen3:32b",
          contextWindow: 131072,
        } as never,
        {
          messages: [{ role: "user", content: "hello" }],
          tools: [
            unreadableTool,
            {
              name: "revoked_schema",
              description: "bad schema",
              parameters: schemaWithRevokedProperty,
            },
            {
              name: "healthy",
              description: "healthy tool",
              parameters: {
                type: "object",
                properties: {
                  query: sharedStringSchema,
                  alias: sharedStringSchema,
                  action: { enum: [{ op: "move" }] },
                },
              },
            },
          ],
        } as never,
        {} as never,
      ),
    );

    await collectStreamEvents(stream);

    const requestInit = getGuardedFetchCall().init ?? {};
    if (typeof requestInit.body !== "string") {
      throw new Error("Expected string request body");
    }
    const requestBody = JSON.parse(requestInit.body) as {
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: {
            properties?: Record<string, { enum?: Array<Record<string, unknown>>; type?: string }>;
          };
        };
      }>;
    };
    expect(requestBody.tools?.map((tool) => tool.function?.name)).toEqual(["healthy"]);
    expect(requestBody.tools?.[0]?.function?.parameters?.properties?.query).toEqual({
      type: "string",
    });
    expect(requestBody.tools?.[0]?.function?.parameters?.properties?.alias).toEqual({
      type: "string",
    });
    expect(requestBody.tools?.[0]?.function?.parameters?.properties?.action?.enum?.[0]).toEqual({
      op: "move",
    });
  });
});
