import {
  AgentHarnessPreflightError,
  formatErrorMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
export class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(`thread/start: ${formatErrorMessage(cause)}`, { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

export class CodexThreadClientReplacementError extends AgentHarnessPreflightError {
  constructor() {
    super(
      "Codex did not confirm unloading its previous configuration after a settled failure; a fresh client is required.",
    );
    this.name = "CodexThreadClientReplacementError";
  }
}

const CODEX_THREAD_CLAIMED_MARKER = "is claimed by active work; stop it first.";

/** A single physical thread admits one turn at a time; live protection counts as work. */
export const codexThreadClaimedMessage = (threadId: string) =>
  `Codex thread ${threadId} ${CODEX_THREAD_CLAIMED_MARKER}`;

/**
 * A claim refusal reaches a completion owner only as text, because the announce crosses the
 * host boundary. Matching the marker lets a caller tell this refusal apart from a delivery
 * failure it should retry or retire on.
 */
export function isCodexThreadClaimRefusal(message: string): boolean {
  return message.includes(CODEX_THREAD_CLAIMED_MARKER);
}

export class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

export class CodexAdoptedThreadActiveError extends AgentHarnessPreflightError {
  constructor(
    message = "Codex session became active in another runner; wait for it to finish before continuing",
  ) {
    super(message);
    this.name = "CodexAdoptedThreadActiveError";
  }
}
