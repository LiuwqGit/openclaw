import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { attachManagedOutgoingMediaToMessage } from "../../gateway/managed-image-attachments.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  hasAssistantDisplayMediaContent,
} from "../../gateway/server-methods/chat-assistant-content.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import { logCronDeliveryWarn } from "./delivery-dispatch-policy.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import { resolvedDeliveryTargetsExternalChannel } from "./delivery-target.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean; deliveryError?: string };

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  text?: string,
  /**
   * The finalized payload set for this completion. Descendant finalization can
   * replace the interim media-bearing payloads with a text-only final reply
   * (dispatch swaps its local set before committing); the durable transcript
   * must mirror that finalized set — never the superseded `params` set.
   */
  deliveryPayloads: DispatchCronDeliveryParams["deliveryPayloads"] = params.deliveryPayloads,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
  }
  if (!params.sourceSessionGeneration) {
    return { ok: false, reason: "current cron delivery is missing its source session generation" };
  }
  const completionText =
    resolveDirectCronTranscriptMirrorText(
      projectOutboundPayloadPlanForMirror(
        createOutboundPayloadPlan(buildDirectCronTranscriptMirrorPayloads(deliveryPayloads)),
      ),
    ) ?? normalizeOptionalString(text);
  if (!completionText) {
    return { ok: false, reason: "current cron completion has no durable transcript projection" };
  }
  // Mirror the Control UI finalization path: media-bearing delivery payloads keep
  // their structured content in the durable transcript instead of collapsing to text.
  const storePath = resolveSessionStorePathCore(params.cfgWithAgentDefaults.session?.store, {
    agentId: params.agentId,
  });
  const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
    sessionKey: sourceSessionKey,
    agentId: params.agentId,
    payloads: deliveryPayloads,
    managedMediaLocalRoots: appendLocalMediaParentRoots(
      getAgentScopedMediaLocalRoots(params.cfgWithAgentDefaults, params.agentId),
      [storePath],
    ),
    includeSensitiveMedia: false,
    onManagedMediaPrepareError: (message) => {
      void logCronDeliveryWarn(
        `[cron:${params.job.id}] current-session completion media embedding skipped: ${message}`,
      );
    },
  });
  const persistedContent = hasAssistantDisplayMediaContent(assistantContent)
    ? assistantContent
    : undefined;
  const runId = createCronExecutionId(params.job.id, params.runStartedAt);
  const committed = await commitBackgroundResultToSession({
    agentId: params.agentId,
    sessionKey: sourceSessionKey,
    expectedGeneration: params.sourceSessionGeneration,
    text: completionText,
    ...(persistedContent ? { content: persistedContent } : {}),
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.job.id, runId },
    config: params.cfgWithAgentDefaults,
    signal: params.abortSignal,
  });
  if (!committed.ok) {
    return committed;
  }
  if (persistedContent?.length && committed.messageId) {
    attachManagedOutgoingMediaToMessage({
      messageId: committed.messageId,
      blocks: persistedContent,
    });
  }
  if (params.sourceDeliveryOutcome.satisfiesSourceDelivery) {
    return { ok: true, requiresExternalDelivery: false };
  }
  if (params.resolvedDelivery.ok) {
    return { ok: true, requiresExternalDelivery: true };
  }
  // The completion is durably committed to the target conversation. When the
  // failed resolution names an external channel route, that route still owed a
  // send — report it as a delivery failure without failing the committed turn.
  // With no external route (internal webchat/Control UI conversations, or a
  // gateway with no channels configured), the commit IS the delivery.
  if (resolvedDeliveryTargetsExternalChannel(params.resolvedDelivery)) {
    return {
      ok: true,
      requiresExternalDelivery: false,
      deliveryError: params.resolvedDelivery.error.message,
    };
  }
  return { ok: true, requiresExternalDelivery: false };
}
