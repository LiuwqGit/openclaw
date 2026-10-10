import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt persistence suppression", () => {
  it("keeps the runtime-only marker out of the persisted transcript while the model still sees it", async () => {
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    });
    const sessionManager = guardSessionManager(SessionManager.inMemory(), {
      runId: "runtime-only-marker",
    });
    const { session } = await createTestSession({ sessionManager });
    const submit = (input: {
      runtimeOnly: boolean;
      transcriptPrompt: string;
      runtimeContextMessage?: ReturnType<typeof buildRuntimeContextCustomMessage>;
    }) =>
      submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession: session,
        appendContext: undefined,
        prependContext: undefined,
        modelPrompt: input.transcriptPrompt,
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        setNextUserMessagePersistenceSuppression:
          sessionManager.setNextUserMessagePersistenceSuppression,
        ...input,
      });

    await submit({
      runtimeOnly: true,
      transcriptPrompt: RUNTIME_EVENT_USER_PROMPT,
      runtimeContextMessage: buildRuntimeContextCustomMessage("room event payload"),
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(RUNTIME_EVENT_USER_PROMPT);
    const persistedUserTexts = () =>
      sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? [JSON.stringify(entry.message.content)]
            : [],
        );
    expect(persistedUserTexts()).toEqual([]);

    await submit({ runtimeOnly: false, transcriptPrompt: "actual user text" });
    expect(persistedUserTexts()).toEqual([
      JSON.stringify([{ type: "text", text: "actual user text" }]),
    ]);
    expect(JSON.stringify(requests.at(-1))).toContain("actual user text");
  });

  it("arms one-shot persistence suppression around runtime-only submissions and disarms on failure", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const suppressions: boolean[] = [];
    const setSuppression = vi.fn((suppress: boolean) => {
      suppressions.push(suppress);
    });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: vi.fn(async () => {
        expect(suppressions).toEqual([true]);
      }),
      runtimeOnly: true,
      setNextUserMessagePersistenceSuppression: setSuppression,
    });
    expect(suppressions).toEqual([true, false]);

    suppressions.length = 0;
    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        promptActiveSession: vi.fn(async () => {
          throw new Error("provider failed");
        }),
        runtimeOnly: true,
        setNextUserMessagePersistenceSuppression: setSuppression,
      }),
    ).rejects.toThrow("provider failed");
    expect(suppressions).toEqual([true, false]);

    const untouched = vi.fn();
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: vi.fn(async () => {}),
      setNextUserMessagePersistenceSuppression: untouched,
    });
    expect(untouched).not.toHaveBeenCalled();
  });
});
