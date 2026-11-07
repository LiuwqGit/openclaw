import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSummaryProviderError } from "../../../packages/agent-core/src/harness/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { extractErrorHttpStatus } from "../../shared/assistant-error-format.js";
import { COMPACTION_SUMMARY_FAILURE_PREFIX } from "../agent-compaction-constants.js";
import type { CompactionSafeguardCancellation } from "../agent-hooks/compaction-safeguard-runtime.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { extractFailoverHttpStatus } from "../failover/retry-evidence.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const COMPACTION_PROVIDER_4XX = new Set([400, 401, 403, 429]);
const COMPACTION_PROVIDER_5XX = new Set([500, 502, 503, 504]);
const COMPACTION_TEXT_REASONS: ReadonlyArray<
  readonly [reason: string, fragments: readonly string[], match?: "all"]
> = [
  ["unshrinkable_request", ["estimated foreground request budget still exceeds"]],
  ["no_compactable_entries", ["nothing to compact", "no real conversation messages"]],
  // Both backends' phrases mean the transcript is already small enough.
  ["below_threshold", ["below threshold", "already under target"]],
  ["already_compacted", ["already compacted", "already_compacted"]],
  ["deferred_background", ["deferred to background"]],
  ["live_context_still_exceeds_target", ["still exceeds target"]],
  ["transcript_persistence_failed", ["session transcript", "not persisted"], "all"],
  ["guard_blocked", ["guard"]],
  ["summary_failed", ["summary"]],
  ["timeout", ["timed out", "timeout"]],
];

const COMPACTION_SUMMARY_FAILURE_PREFIX_LOWERCASE = COMPACTION_SUMMARY_FAILURE_PREFIX.toLowerCase();

export const DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON =
  "deferred to background context-engine maintenance";

export function buildCompactionFailureResult(
  reason: string,
  failure?: EmbeddedAgentCompactResult["failure"],
): EmbeddedAgentCompactResult {
  return { ok: false, compacted: false, reason, ...(failure ? { failure } : {}) };
}

function isGenericCompactionCancelledReason(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}

/** Preserve terminal failures; otherwise project display text and failure provenance together. */
export function resolveCompactionFailure(params: {
  error: unknown;
  safeguardCancellation?: CompactionSafeguardCancellation | null;
  abortSignal?: AbortSignal;
}): { reason: string; error: unknown } {
  if (hasModelFallbackStop(params.error)) {
    throw params.error;
  }
  const reason = formatErrorMessage(params.error);
  // AgentSessionCompaction wraps hook cancellation in a plain Error("Compaction cancelled").
  // Only that wrapper yields to safeguard provenance; genuine errors and caller aborts win.
  const cancellation =
    !params.abortSignal?.aborted &&
    params.error instanceof Error &&
    params.error.name === "Error" &&
    isGenericCompactionCancelledReason(reason)
      ? params.safeguardCancellation
      : undefined;
  return { reason: cancellation?.reason ?? reason, error: cancellation?.error ?? params.error };
}

/**
 * Only an actual summary timeout qualifies: the summary watchdog fired (the caller is still
 * live, so its composed signal aborted on the deadline), or the provider answered 408/504.
 * Failover's broader "timeout" class also covers fast 5xx, 410, and DNS failures, which keep
 * their owners' outcomes.
 */
export function isSummaryTimeoutFailure(params: {
  error: unknown;
  summarySignal?: AbortSignal;
  safeguardCancellation?: CompactionSafeguardCancellation | null;
  abortSignal?: AbortSignal;
}): boolean {
  // Terminal failures (model-fallback stop) rethrow before any timeout verdict.
  let providerFailure = resolveCompactionFailure(params).error;
  if (params.summarySignal?.aborted) {
    return true;
  }
  while (providerFailure instanceof Error && !isSummaryProviderError(providerFailure)) {
    providerFailure = providerFailure.cause;
  }
  const status = isSummaryProviderError(providerFailure)
    ? extractErrorHttpStatus(providerFailure.response.errorMessage?.trim() ?? "")?.code
    : undefined;
  return status === 408 || status === 504;
}

/**
 * The safeguard cancellation envelope hides the summarizer's own error behind a prefix that
 * contains "guard", and the anchored provider-status patterns never match mid-string. Return the
 * wrapped detail so it classifies exactly like the unwrapped error does.
 */
function unwrapCompactionSummaryFailure(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith(
      COMPACTION_SUMMARY_FAILURE_PREFIX_LOWERCASE,
    )
  ) {
    return undefined;
  }
  const detail = trimmed.slice(COMPACTION_SUMMARY_FAILURE_PREFIX_LOWERCASE.length).trim();
  return detail.replace(/^[:\s-]+/, "").trim() || undefined;
}

export function classifyCompactionReason(reason?: string): string {
  if (!reason) {
    return "unknown";
  }
  const wrapped = unwrapCompactionSummaryFailure(reason);
  if (wrapped) {
    const wrappedClassification = classifyCompactionReasonText(wrapped);
    if (wrappedClassification !== "unknown") {
      return wrappedClassification;
    }
  }
  return classifyCompactionReasonText(reason);
}

function classifyCompactionReasonText(reason: string): string {
  const text = normalizeLowercaseStringOrEmpty(reason);
  if (!text) {
    return "unknown";
  }
  if (
    text.startsWith("no api key found") ||
    (text.startsWith("authentication failed for ") && text.includes("credentials may have expired"))
  ) {
    return "auth_failed";
  }
  for (const [classification, fragments, match] of COMPACTION_TEXT_REASONS) {
    const includes = (fragment: string) => text.includes(fragment);
    if (match === "all" ? fragments.every(includes) : fragments.some(includes)) {
      return classification;
    }
  }
  const status = extractFailoverHttpStatus(reason, { includeLabeledStatus: true });
  if (status !== undefined && COMPACTION_PROVIDER_4XX.has(status)) {
    return "provider_error_4xx";
  }
  if (status !== undefined && COMPACTION_PROVIDER_5XX.has(status)) {
    return "provider_error_5xx";
  }
  return "unknown";
}

export function isBenignCompactionSkipReason(reason?: string): boolean {
  const classification = classifyCompactionReason(reason);
  return classification === "below_threshold" || classification === "already_compacted";
}

export function isBenignCompactionSkipResult(result: {
  ok: boolean;
  compacted: boolean;
  reason?: string;
}): boolean {
  if (result.compacted) {
    return false;
  }
  return (
    isBenignCompactionSkipReason(result.reason) ||
    (result.ok && classifyCompactionReason(result.reason) === "no_compactable_entries")
  );
}
