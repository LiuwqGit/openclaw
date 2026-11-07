// Reserve summary/housekeeping headroom without letting it dominate small model windows.
const MAX_COMPACTION_RESERVE_RATIO = 0.25;

/** Caps compaction headroom so prompts retain at least three quarters of the model window. */
export function resolveEffectiveCompactionReserveTokens(params: {
  contextTokenBudget: number;
  reserveTokens: number;
}): number {
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  return Math.min(
    Math.max(0, Math.floor(params.reserveTokens)),
    Math.floor(contextTokenBudget * MAX_COMPACTION_RESERVE_RATIO),
  );
}

export const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;

/**
 * Envelope the compaction safeguard wraps around every non-refusal summarizer failure. The
 * provider/auth/timeout detail lives after this prefix, and the prefix itself contains "guard",
 * so consumers must unwrap before classifying the cause.
 */
export const COMPACTION_SUMMARY_FAILURE_PREFIX =
  "Compaction safeguard could not summarize the session";
