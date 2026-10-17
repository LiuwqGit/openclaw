import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpBackgroundRun, AcpPendingPrompt } from "./translator.prompt-state.js";

// Prompt-less background runs are bounded so a long-lived bridge cannot
// accumulate streaming state for runs that never reach a terminal state.
const MAX_BACKGROUND_RUNS = 64;
// Settled prompt runs stay excluded from background delivery so late gateway
// events for them cannot be re-delivered through a fresh background context.
const MAX_PROMPT_RUN_IDS = 256;

/**
 * Attaches prompt-less gateway runs (e.g. a sub-agent completion waking the
 * requester session after its turn ended) to the open ACP session sharing
 * their session key, so their assistant text and tool events reach the client
 * as session/update notifications without settling any session/prompt response.
 */
export class AcpBackgroundRunRegistry {
  private readonly runs = new Map<string, AcpBackgroundRun>();
  private readonly promptRunIds = new Set<string>();

  constructor(
    private readonly sessionStore: AcpSessionStore,
    private readonly pendingPrompts: Map<string, AcpPendingPrompt>,
    private readonly log: (msg: string) => void,
  ) {}

  /** Records a run this bridge started as a prompt; its post-settlement events stay excluded. */
  rememberPromptRun(runId: string): void {
    this.promptRunIds.add(runId);
    if (this.promptRunIds.size > MAX_PROMPT_RUN_IDS) {
      const oldest = this.promptRunIds.values().next().value;
      if (oldest !== undefined) {
        this.promptRunIds.delete(oldest);
      }
    }
  }

  /** Returns the retained streaming context for a prompt-less run, attaching one when eligible. */
  resolve(sessionKey: string, runId?: string): AcpBackgroundRun | undefined {
    if (!runId) {
      return undefined;
    }
    const existing = this.runs.get(runId);
    if (existing) {
      // Session closure revokes delivery even for an already attached run.
      if (!this.sessionStore.hasSession(existing.sessionId)) {
        this.runs.delete(runId);
        return undefined;
      }
      if (existing.sessionKey !== sessionKey) {
        this.log(`background run session key reconciled: ${existing.sessionKey} -> ${sessionKey}`);
        existing.sessionKey = sessionKey;
      }
      return existing;
    }
    // Late events from a run this bridge started as a prompt must not be
    // re-delivered through a fresh background context after settlement.
    if (this.promptRunIds.has(runId)) {
      return undefined;
    }
    // Bind to an open session without a pending prompt: interleaving a
    // foreign run into an active prompt stream would break run scoping.
    const candidates = this.sessionStore.findSessionsByKey?.(sessionKey) ?? [];
    const session = candidates.find((candidate) => !this.pendingPrompts.has(candidate.sessionId));
    if (!session) {
      return undefined;
    }
    const run: AcpBackgroundRun = {
      sessionId: session.sessionId,
      sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      idempotencyKey: runId,
    };
    this.runs.set(runId, run);
    if (this.runs.size > MAX_BACKGROUND_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) {
        this.runs.delete(oldest);
      }
    }
    this.log(`background run attached: ${sessionKey} (${runId}) -> ${session.sessionId}`);
    return run;
  }

  owns(run: AcpBackgroundRun): boolean {
    return this.runs.get(run.idempotencyKey) === run;
  }
}
