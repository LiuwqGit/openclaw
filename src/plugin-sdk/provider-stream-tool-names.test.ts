import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createPlainTextToolCallCompatWrapper } from "./provider-stream-shared.js";

function createEventStream(events: unknown[]): ReturnType<StreamFn> {
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };
  queueMicrotask(() => {
    for (const event of events) {
      stream.push(event);
    }
    stream.end();
  });
  return output as ReturnType<StreamFn>;
}

describe("createPlainTextToolCallCompatWrapper tool names", () => {
  it("ignores unreadable context tool names while preserving healthy tool repair", async () => {
    const unreadableTool = { name: "revoked", description: "", parameters: {} };
    Object.defineProperty(unreadableTool, "name", {
      enumerable: true,
      get() {
        throw new Error("tool revoked");
      },
    });
    const baseStreamFn: StreamFn = () =>
      createEventStream([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: '[tool:read] {"path":"/tmp/file.txt"}',
          },
        },
      ]);
    const wrapped = createPlainTextToolCallCompatWrapper(baseStreamFn);
    const events: unknown[] = [];

    for await (const event of wrapped(
      {} as never,
      { tools: [unreadableTool, { name: "read" }] } as never,
      {},
    ) as AsyncIterable<unknown>) {
      events.push(event);
    }

    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "done",
    ]);
  });
});
