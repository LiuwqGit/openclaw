// Isolated heartbeat rollover transcript reclamation (#131770).
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { formatErrorMessage } from "./errors.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../gateway/session-archive.runtime.js"),
);

/**
 * Resolves transcript reclamation for one isolated heartbeat rollover
 * (#131770). Every wake rolls a fresh session ID under a stable store key, and
 * the rollover upsert replaces the row in place, so lifecycle artifact cleanup
 * never sees the previous session as removed.
 *
 * Reclamation is generation-fenced against live runs: an overlapping wake whose
 * reply turn is still admitted can materialize its transcript after this
 * rollover committed, so a one-shot archive at that point would miss the file
 * and leave it orphaned. While the session lane is admitted, the replaced
 * generation — plus anything it deferred — is carried on the committed row as
 * `pendingTranscriptArchiveSessionIds` and reclaimed once the lane's
 * admissions release (see {@link reclaimIsolatedRolloverTranscripts}).
 */
export function resolveIsolatedRolloverTranscriptReclamation(params: {
  currentEntry?: SessionEntry;
  sessionLaneActive: boolean;
}): {
  archiveSessionIds: string[];
  deferredSessionIds: string[];
} {
  const deferredFromReplaced = (
    params.currentEntry?.pendingTranscriptArchiveSessionIds ?? []
  ).filter((sessionId) => Boolean(sessionId?.trim()));
  const replacedSessionId = params.currentEntry?.sessionId?.trim();
  if (params.sessionLaneActive) {
    return {
      archiveSessionIds: [],
      deferredSessionIds: [
        ...deferredFromReplaced,
        ...(replacedSessionId ? [replacedSessionId] : []),
      ],
    };
  }
  return {
    archiveSessionIds: [...deferredFromReplaced, ...(replacedSessionId ? [replacedSessionId] : [])],
    deferredSessionIds: [],
  };
}

/**
 * Archives the file-backed transcripts of the terminal generations selected by
 * {@link resolveIsolatedRolloverTranscriptReclamation} once the rollover
 * committed (#131770). Individual rename failures are surfaced through the
 * heartbeat log so they are never silently dropped from observability.
 */
async function archiveIsolatedRolloverTranscripts(params: {
  agentId: string;
  cfg: OpenClawConfig;
  sessionIds: readonly string[];
  sessionKey: string;
}): Promise<void> {
  if (params.sessionIds.length === 0) {
    return;
  }
  try {
    const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    for (const sessionId of params.sessionIds) {
      archiveSessionTranscripts({
        sessionId,
        storePath,
        agentId: params.agentId,
        reason: "deleted",
        onArchiveError: (error, sourcePath) => {
          heartbeatLog.warn(
            `heartbeat: failed to archive previous isolated session transcript ${sourcePath} for session ${sessionId}`,
            { error: String(error), sessionKey: params.sessionKey },
          );
        },
      });
    }
  } catch (err) {
    heartbeatLog.warn("heartbeat: failed to archive previous isolated session transcript", {
      err: formatErrorMessage(err),
      sessionKey: params.sessionKey,
    });
  }
}

/**
 * Reclaims both halves of one rollover's reclamation decision (#131770): the
 * already-terminal generations are archived immediately, and generations whose
 * run is still admitted are archived as soon as every admission on the
 * isolated session lane releases — so a transcript that materializes after the
 * competing rollover is reclaimed even when no further heartbeat wake runs.
 * The deferred ids also stay on the committed row, so a process restart before
 * the release still reclaims them on the next rollover.
 */
export async function reclaimIsolatedRolloverTranscripts(params: {
  agentId: string;
  archiveSessionIds: readonly string[];
  cfg: OpenClawConfig;
  deferredSessionIds: readonly string[];
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await archiveIsolatedRolloverTranscripts({
    agentId: params.agentId,
    cfg: params.cfg,
    sessionIds: params.archiveSessionIds,
    sessionKey: params.sessionKey,
  });
  if (params.deferredSessionIds.length === 0) {
    return;
  }
  const admissionRelease =
    getSessionWorkAdmissionRelease({
      scope: params.storePath,
      identities: [params.sessionKey],
    }) ?? Promise.resolve();
  void admissionRelease.then(() =>
    archiveIsolatedRolloverTranscripts({
      agentId: params.agentId,
      cfg: params.cfg,
      sessionIds: params.deferredSessionIds,
      sessionKey: params.sessionKey,
    }),
  );
}
