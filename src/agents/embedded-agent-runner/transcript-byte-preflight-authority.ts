import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveCodexAgentHarnessNativeCompaction } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";

export type TranscriptBytePreflightAuthority = AgentHarness;

type TranscriptBytePreflightClaim = {
  authority: TranscriptBytePreflightAuthority;
  sessionTarget: Partial<SessionTranscriptRuntimeTarget>;
};

const claims = resolveGlobalSingleton<
  WeakMap<ContextEngineRuntimeContext, TranscriptBytePreflightClaim>
>(Symbol.for("openclaw.transcriptBytePreflightClaims"), () => new WeakMap());

export function resolveTranscriptBytePreflightAuthority(
  harness: AgentHarness,
): TranscriptBytePreflightAuthority | undefined {
  try {
    return resolveCodexAgentHarnessNativeCompaction(harness) ? harness : undefined;
  } catch {
    return undefined;
  }
}

export function setTranscriptBytePreflightClaim(
  runtimeContext: ContextEngineRuntimeContext | undefined,
  authority: TranscriptBytePreflightAuthority | undefined,
): () => void {
  if (!runtimeContext || !authority) {
    return () => {};
  }
  const target = runtimeContext.sessionTarget;
  const claim = {
    authority,
    sessionTarget: {
      agentId: target?.agentId,
      sessionId: target?.sessionId,
      sessionKey: target?.sessionKey,
      storePath: target?.storePath,
    },
  };
  claims.set(runtimeContext, claim);
  return () => {
    if (claims.get(runtimeContext) === claim) {
      claims.delete(runtimeContext);
    }
  };
}

export function consumeTranscriptBytePreflightClaim(
  params: CompactEmbeddedAgentSessionRuntimeParams,
  sessionTarget: SessionTranscriptRuntimeTarget,
  lockedHarnessRuntime: string | undefined,
): TranscriptBytePreflightAuthority | undefined {
  const runtimeContext = params.contextEngineRuntimeContext;
  const claim = runtimeContext ? claims.get(runtimeContext) : undefined;
  if (!runtimeContext || !claim) {
    return undefined;
  }
  claims.delete(runtimeContext);
  const { authority, sessionTarget: expected } = claim;
  const active = resolveTranscriptBytePreflightAuthority(authority);
  return (lockedHarnessRuntime ?? params.agentHarnessId) === authority.id &&
    params.preflightRequired === true &&
    params.preflightCompactionTrigger === "transcript_bytes" &&
    params.trigger === "budget" &&
    expected?.agentId === sessionTarget.agentId &&
    expected.sessionId === sessionTarget.sessionId &&
    expected.sessionKey === sessionTarget.sessionKey &&
    expected.storePath === sessionTarget.storePath &&
    active === authority
    ? authority
    : undefined;
}
