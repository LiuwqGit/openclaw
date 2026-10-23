// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("keeps the bounded-context warning visible after the run settles", () => {
  const host = makeChatHost({
    sessionKey: "main",
    chatRunId: "run-1",
    chatStream: "Live reply",
    chatRunStartup: null,
  });
  host.compactionStatus = {
    phase: "bounded",
    runId: "run-1",
    startedAt: 100,
    completedAt: null,
  };
  const payload: ChatEventPayload = {
    runId: "run-1",
    sessionKey: "main",
    state: "final",
    stopReason: "completed",
    yielded: true,
    message: { role: "assistant", content: [{ type: "text", text: "Live reply" }] },
  };
  handleChatGatewayEvent(host, payload);

  expect(host.chatRunId).toBeNull();
  expect(host.chatStream).toBeNull();
  // Like a completed compaction, the host warning outlives the terminal event
  // so a viewer opening the conversation afterwards still sees the limitation.
  expect(host.compactionStatus).toMatchObject({ phase: "bounded", runId: "run-1" });
});
