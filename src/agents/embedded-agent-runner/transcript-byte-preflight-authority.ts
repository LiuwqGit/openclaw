import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { isRuntimeCompactionDelegate } from "../../context-engine/compaction-watchdog.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveCodexAgentHarnessNativeCompaction } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";

export type TranscriptBytePreflightAuthority = AgentHarness;

const claims = resolveGlobalSingleton<
  WeakMap<ContextEngineRuntimeContext, TranscriptBytePreflightAuthority>
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
  compact: ContextEngine["compact"],
): () => void {
  if (!runtimeContext || !authority || !isRuntimeCompactionDelegate(compact)) {
    return () => {};
  }
  claims.set(runtimeContext, authority);
  return () => {
    if (claims.get(runtimeContext) === authority) {
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
  const authority = runtimeContext ? claims.get(runtimeContext) : undefined;
  if (!runtimeContext || !authority) {
    return undefined;
  }
  claims.delete(runtimeContext);
  const expected = runtimeContext.sessionTarget;
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
