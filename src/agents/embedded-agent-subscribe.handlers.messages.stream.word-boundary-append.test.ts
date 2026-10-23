import { expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";

// Deterministic work check (#181507): count every character handed to
// parseReplyDirectives while a word-boundary streamed reply flows through the
// shipped subscription entry point. The fast paths must keep that count linear
// in the reply length instead of reparsing the whole answer per delta.
const { parsedCharacterCount, addParsedCharacters, resetParsedCharacterCount } = vi.hoisted(() => {
  let total = 0;
  return {
    parsedCharacterCount: () => total,
    addParsedCharacters: (characters: number) => {
      total += characters;
    },
    resetParsedCharacterCount: () => {
      total = 0;
    },
  };
});

vi.mock("../auto-reply/reply/reply-directives.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/reply-directives.js")>();
  return {
    ...actual,
    parseReplyDirectives: (
      raw: string,
      options?: Parameters<typeof actual.parseReplyDirectives>[1],
    ) => {
      addParsedCharacters(raw.length);
      return actual.parseReplyDirectives(raw, options);
    },
  };
});

type AssistantStreamMessage = {
  role: "assistant";
  phase: "final_answer";
  content: Array<{ type: "text"; text: string }>;
};

function streamWordBoundaryReply(params: {
  runId: string;
  text: string;
  chunkSize?: number;
  onPartialReply: (text: string) => void;
}) {
  const chunk = params.chunkSize ?? 4;
  const { emit } = createSubscribedSessionHarness({
    runId: params.runId,
    enforceFinalTag: false,
    onPartialReply: (payload) => params.onPartialReply(payload.text ?? ""),
    blockReplyBreak: "message_end",
    onBlockReply: () => {},
    blockReplyChunking: { minChars: 200, maxChars: 1000, breakPreference: "paragraph" },
  });
  const message: AssistantStreamMessage = {
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "text", text: "" }],
  };
  emit({ type: "message_start", message });
  for (let at = 0; at < params.text.length; at += chunk) {
    message.content = [{ type: "text", text: params.text.slice(0, at + chunk) }];
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: params.text.slice(at, at + chunk),
      },
    });
  }
  message.content = [{ type: "text", text: params.text }];
  emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: params.text },
  });
  emit({ type: "message_end", message });
}

it("keeps word-boundary streamed plain replies off the full-answer reparse path", () => {
  resetParsedCharacterCount();
  const body = "abc def ghi jkl mnp qrs tuv wxy z ".repeat(1325);
  const partials: string[] = [];
  const started = performance.now();
  streamWordBoundaryReply({
    runId: "word-boundary-plain",
    text: body,
    onPartialReply: (text) => partials.push(text),
  });
  const elapsed = performance.now() - started;
  expect(body.length).toBe(45050);
  // Byte-identical delivered text: only the terminal trailing space is trimmed.
  expect(partials.at(-1)).toBe(body.trimEnd());
  // Linear budget: at most a handful of full-answer parses (issue #181507
  // recorded 88,385,792 parsed characters for a 45 KB reply on main).
  expect(parsedCharacterCount()).toBeLessThanOrEqual(body.length * 8);
  expect(elapsed).toBeLessThan(5_000);
});

it("keeps word-boundary streamed reply-tagged answers off the full-answer reparse path", () => {
  resetParsedCharacterCount();
  const body = "abc def ghi jkl mnp qrs tuv wxy z ".repeat(1325);
  // 28-char prefix keeps 4-char chunk boundaries on the body's word
  // boundaries, so trailing-whitespace deltas exercise the tagged fast path.
  const text = `[[reply_to_current]] abcd.\n\n${body}`;
  const partials: string[] = [];
  const started = performance.now();
  streamWordBoundaryReply({
    runId: "word-boundary-tagged",
    text,
    onPartialReply: (partial) => partials.push(partial),
  });
  const elapsed = performance.now() - started;
  expect(partials.at(-1)).toBe(`abcd.\n\n${body.trimEnd()}`);
  expect(parsedCharacterCount()).toBeLessThanOrEqual(text.length * 8);
  expect(elapsed).toBeLessThan(5_000);
});
