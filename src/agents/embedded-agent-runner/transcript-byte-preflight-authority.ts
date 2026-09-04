import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { isRuntimeCompactionDelegate } from "../../context-engine/compaction-watchdog.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveHostByteAuthority } from "../harness/registry.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";

export type HostByteAuthority = NonNullable<ReturnType<typeof resolveHostByteAuthority>>;
// Exact runtime-context objects are the shared one-shot keys across lazy chunks.
const hostByteClaims = resolveGlobalSingleton<
  WeakMap<ContextEngineRuntimeContext, HostByteAuthority>
>(Symbol.for("openclaw.hostTranscriptBytePreflightClaims"), () => new WeakMap());

function setClaim(key: ContextEngineRuntimeContext, authority: HostByteAuthority): () => void {
  hostByteClaims.set(key, authority);
  return () => hostByteClaims.delete(key);
}

function consumeClaim(params: {
  key: ContextEngineRuntimeContext | undefined;
  expectedTarget: Partial<SessionTranscriptRuntimeTarget> | undefined;
  target: SessionTranscriptRuntimeTarget;
  owner: string | undefined;
  preflight: CompactEmbeddedAgentSessionRuntimeParams;
}): HostByteAuthority | undefined {
  const authority = params.key ? hostByteClaims.get(params.key) : undefined;
  if (!params.key || !authority) {
    return undefined;
  }
  hostByteClaims.delete(params.key);
  const activeAuthority = resolveHostByteAuthority(authority.harness.id, authority.harness);
  const expected = params.expectedTarget;
  return params.owner === authority.harness.id &&
    params.preflight.preflightRequired === true &&
    params.preflight.preflightCompactionTrigger === "transcript_bytes" &&
    params.preflight.trigger === "budget" &&
    expected?.agentId === params.target.agentId &&
    expected.sessionId === params.target.sessionId &&
    expected.sessionKey === params.target.sessionKey &&
    expected.storePath === params.target.storePath &&
    activeAuthority?.nativeCompaction === authority.nativeCompaction
    ? authority
    : undefined;
}

export function setHostByteClaim(
  runtimeContext: ContextEngineRuntimeContext | undefined,
  authority: HostByteAuthority | undefined,
  compact: ContextEngine["compact"],
): (() => void) | undefined {
  if (!runtimeContext || !authority || !isRuntimeCompactionDelegate(compact)) {
    return undefined;
  }
  return setClaim(runtimeContext, authority);
}

export function consumeHostByteClaim(
  params: CompactEmbeddedAgentSessionRuntimeParams,
  sessionTarget: SessionTranscriptRuntimeTarget,
  lockedHarnessRuntime: string | undefined,
): HostByteAuthority | undefined {
  const runtimeContext = params.contextEngineRuntimeContext;
  return consumeClaim({
    key: runtimeContext,
    expectedTarget: runtimeContext?.sessionTarget,
    target: sessionTarget,
    owner: lockedHarnessRuntime ?? params.agentHarnessId,
    preflight: params,
  });
}
