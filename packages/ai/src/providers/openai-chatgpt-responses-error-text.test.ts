import { describe, expect, it } from "vitest";
import { readChatGptResponsesErrorTextLimitedForTest } from "./openai-chatgpt-responses.js";

function makeStubReader(
  behavior: "throw" | "eof",
  cancelTracker: { called: boolean },
): ReadableStreamDefaultReader<Uint8Array> {
  const readImpl =
    behavior === "throw"
      ? () => Promise.reject(new Error("stream broke"))
      : async () =>
          ({ value: undefined, done: true }) as ReadableStreamDefaultReadResult<Uint8Array>;

  return {
    read: readImpl,
    cancel: async () => {
      cancelTracker.called = true;
    },
    releaseLock: () => {},
    closed: Promise.resolve(
      undefined as unknown as ReadableStreamDefaultReader<Uint8Array>["closed"],
    ),
  };
}

describe("readChatGptResponsesErrorTextLimited", () => {
  it("cancels the reader even when reader.read() throws", async () => {
    const cancelTracker = { called: false };
    const throwingReader = makeStubReader("throw", cancelTracker);

    const response = new Response(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      { status: 500 },
    );
    response.body!.getReader = () => throwingReader;

    let thrown: Error | null = null;
    try {
      await readChatGptResponsesErrorTextLimitedForTest(response);
    } catch (err) {
      thrown = err as Error;
    }

    expect(cancelTracker.called).toBe(true);
    expect(thrown?.message).toBe("stream broke");
  });

  it("cancels the reader on EOF without error", async () => {
    const cancelTracker = { called: false };
    const eofReader = makeStubReader("eof", cancelTracker);

    const response = new Response(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      { status: 500 },
    );
    response.body!.getReader = () => eofReader;

    const result = await readChatGptResponsesErrorTextLimitedForTest(response);

    expect(cancelTracker.called).toBe(true);
    expect(result).toBe("");
  });
});
