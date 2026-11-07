import { expect, it } from "vitest";
import { COMPACTION_SUMMARY_FAILURE_PREFIX } from "../agent-compaction-constants.js";
import { describeFailoverError, resolveFailoverReasonFromError } from "../failover-error.js";
import {
  classifyCompactionReason,
  isBenignCompactionSkipResult,
  isBenignCompactionSkipReason,
  resolveCompactionFailure,
} from "./compact-reasons.js";

const providerError = Object.assign(new Error("provider rejected the request"), {
  status: 429,
  code: "rate_limit_exceeded",
});
const safeguardCancellation = { reason: "Summarization could not finish.", error: providerError };

it("recovers provider classification through the generic wrapper", () => {
  const failure = resolveCompactionFailure({
    error: new Error("Error: Compaction cancelled"),
    safeguardCancellation,
  });
  expect(failure.reason).toBe(safeguardCancellation.reason);
  expect(describeFailoverError(failure.error)).toMatchObject({
    reason: "rate_limit",
    status: 429,
    code: "rate_limit_exceeded",
  });
});

it("does not classify an intentional decline from keywords in its display reason", () => {
  const reason = "Quality audit rejected a summary about a request timeout.";
  const failure = resolveCompactionFailure({
    error: new Error("Compaction cancelled"),
    safeguardCancellation: { reason },
  });
  expect(failure.reason).toContain("Quality audit rejected");
  expect(resolveFailoverReasonFromError(failure.error)).toBeNull();
});

it.each(["AbortError", "caller abort"])("preserves %s despite stale cancellation", (kind) => {
  const error = new Error("Compaction cancelled");
  if (kind === "AbortError") {
    error.name = kind;
  }
  const abortSignal = kind === "caller abort" ? AbortSignal.abort(error) : undefined;
  const failure = resolveCompactionFailure({ error, safeguardCancellation, abortSignal });
  expect(failure).toEqual({ reason: error.message, error });
  expect(failure.error).toBe(error);
  if (abortSignal) {
    expect(resolveFailoverReasonFromError(failure.error)).toBeNull();
  }
});

it.each([
  ['Authentication failed for "anthropic". Credentials may have expired.', "auth_failed"],
  ["Provider API error (429): too many requests", "provider_error_4xx"],
  ["OpenAI API error (500): upstream failed", "provider_error_5xx"],
])("classifies compaction failure %s", (reason, expected) => {
  expect(classifyCompactionReason(reason)).toBe(expected);
});

// The safeguard wraps every non-refusal summarizer failure in one envelope whose prefix contains
// "guard", so the wrapped provider/auth/timeout text must classify like the unwrapped text does.
it.each([
  ["Provider API error (429): too many requests", "provider_error_4xx"],
  ["OpenAI API error (500): upstream failed", "provider_error_5xx"],
  ['Authentication failed for "anthropic". Credentials may have expired.', "auth_failed"],
  ["request timed out after 30000ms", "timeout"],
])("classifies safeguard-wrapped compaction failure %s", (inner, expected) => {
  expect(classifyCompactionReason(`${COMPACTION_SUMMARY_FAILURE_PREFIX}: ${inner}`)).toBe(expected);
});

it.each([
  // A genuine quality-guard verdict keeps its class inside and outside the envelope.
  [`${COMPACTION_SUMMARY_FAILURE_PREFIX}: quality guard rejected the summary`, "guard_blocked"],
  ["Compaction safeguard: quality guard rejected the summary", "guard_blocked"],
  // An inner reason the classifier cannot name keeps today's envelope classification.
  [COMPACTION_SUMMARY_FAILURE_PREFIX, "guard_blocked"],
  [`${COMPACTION_SUMMARY_FAILURE_PREFIX}: model exploded`, "guard_blocked"],
])("keeps guard classification for %s", (reason, expected) => {
  expect(classifyCompactionReason(reason)).toBe(expected);
});

it("requires an explicit successful-result opt-in for empty transcripts", () => {
  const reason = "no real conversation messages";
  expect(isBenignCompactionSkipReason(reason)).toBe(false);
  expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(true);
  expect(isBenignCompactionSkipResult({ ok: false, compacted: false, reason })).toBe(false);
  expect(isBenignCompactionSkipResult({ ok: true, compacted: true, reason })).toBe(false);
});

it.each([undefined, "No API provider registered for api: ollama"])(
  "does not hide the failure reason %s",
  (reason) => {
    expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(false);
  },
);
