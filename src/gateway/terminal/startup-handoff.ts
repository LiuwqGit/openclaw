// Shell-readiness handoff for agent terminal initial commands.
//
// `TerminalSessionManager.open()` returns success once the PTY backend is
// spawned and registered, but a login shell may still be sourcing its profile
// and cannot reliably accept input. Writing a long initial command in that
// window can truncate or mangle it while `open` still reports success, and
// residual text can spill into a later interactive prompt.
//
// This module establishes an explicit, exactly-once startup contract. A
// per-open secret is injected into the child environment under a private,
// non-`OPENCLAW_*` name, and a sentinel command prints a framed marker — a
// fixed prefix immediately followed by the secret — for the resolved shell
// family. Only after that framed marker appears in the output does the caller
// deliver the initial command; a login profile that dumps its environment
// emits `NAME=secret`, which never contains the prefix, so it cannot trip a
// false-ready before the shell reaches its read loop. The PTY's input echo of
// the sentinel line carries only the variable name and the literal prefix,
// never the secret value, so detecting the framed marker proves the shell read
// and executed a line. A shell whose family is not recognized returns no
// sentinel, letting the caller preserve the prior immediate-write path rather
// than close a terminal on a probe it cannot acknowledge. A fixed delay would
// only move the race; this probe adapts to each shell's actual startup time.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";

/**
 * Private per-open child-environment marker that carries the readiness secret.
 *
 * Deliberately not an `OPENCLAW_*` name: this is an ephemeral per-session
 * transport token injected only into the spawned shell, not a documented public
 * setting operators or config consumers should read. The leading underscore and
 * non-`OPENCLAW` prefix keep it out of the repository environment-variable
 * budget and out of the public namespace.
 */
export const TERMINAL_SHELL_READY_ENV = "_OC_SHELL_READY_TOKEN";

/**
 * Framing prefix the sentinel prints immediately before the secret. Matching
 * `frame + secret` (instead of the bare secret) proves the sentinel executed:
 * a login profile that dumps its environment emits `NAME=secret`, which never
 * contains this prefix followed by the secret, so it cannot trip a false-ready
 * before the shell reaches its read loop.
 */
const TERMINAL_SHELL_READY_FRAME = "OCREADY:";

/** Hard ceiling for the readiness handoff; a healthy shell reports far sooner. */
const TERMINAL_SHELL_READY_TIMEOUT_MS = 10_000;

/** Re-send the sentinel if the shell has not echoed it within this window. */
const TERMINAL_SHELL_READY_RETRY_INTERVAL_MS = 3_000;

/** Output poll cadence; bounded by the readiness window, not the marker scan. */
const TERMINAL_SHELL_READY_POLL_INTERVAL_MS = 20;

/** Minimal PTY surface the readiness probe needs from a live session. */
export type TerminalShellReadyProbe = {
  /** Returns false when the write fails (the session is then torn down). */
  write(data: string): boolean;
  /** Cumulative buffered output; scanned for the readiness marker. */
  snapshot(): string;
  /** True once the PTY has exited or been torn down. */
  isClosed(): boolean;
};

export type TerminalShellReadyOutcome =
  | { ok: true }
  | { ok: false; code: "timeout" | "closed" | "aborted" };

/** 32 hex chars: no shell metacharacters or escapes, so echo/printf cannot mangle it. */
export function generateShellReadyToken(): string {
  return randomBytes(16).toString("hex");
}

/** True for the Windows default command shell, which expands `%NAME%`, not `$NAME`. */
function isWindowsCommandShell(shell: string): boolean {
  // Use the win32 basename parser so a full `C:\Windows\System32\cmd.exe`
  // path is split correctly on any host platform.
  return win32.basename(shell).toLowerCase() === "cmd.exe";
}

/** True for a configured PowerShell shell, which expands `$env:NAME`, not `$NAME`. */
function isPowerShellShell(shell: string): boolean {
  const name = win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return name === "powershell" || name === "pwsh";
}

/**
 * Basenames of POSIX-compatible interactive shells that expand `"$NAME"` in
 * double quotes. `gateway.terminal.shell` accepts an arbitrary executable, so
 * an unrecognized configured shell is left to the caller's unsupported-shell
 * path rather than forced through a POSIX probe it cannot acknowledge.
 */
const POSIX_SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);

/** True for a POSIX-compatible shell family that expands `"$NAME"`. */
function isPosixShellFamily(shell: string): boolean {
  const name = win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return POSIX_SHELL_BASENAMES.has(name);
}

/**
 * Sentinel command that prints the framed readiness secret for a recognized
 * shell family, or `undefined` when the configured shell is not a recognized
 * family. Returning `undefined` lets the caller preserve the prior
 * immediate-write path for an arbitrary configured executable instead of
 * closing its terminal on a probe it cannot acknowledge.
 *
 * The sentinel references the environment variable rather than the secret
 * value, so the PTY's input echo carries only the variable name and cannot
 * trip a false-ready: only a shell that read and executed the line emits the
 * framed `frame + secret` marker.
 */
export function shellReadySentinel(shell: string): string | undefined {
  if (isWindowsCommandShell(shell)) {
    // cmd.exe expands `%NAME%`.
    return `echo ${TERMINAL_SHELL_READY_FRAME}%${TERMINAL_SHELL_READY_ENV}%\r`;
  }
  if (isPowerShellShell(shell)) {
    // PowerShell expands `$env:NAME`, not `$NAME`.
    return `echo "${TERMINAL_SHELL_READY_FRAME}$env:${TERMINAL_SHELL_READY_ENV}"\r`;
  }
  if (isPosixShellFamily(shell)) {
    // POSIX-compatible shells (sh/bash/zsh/fish/…) expand `"$NAME"`.
    return `echo "${TERMINAL_SHELL_READY_FRAME}$${TERMINAL_SHELL_READY_ENV}"\r`;
  }
  return undefined;
}

/**
 * The readiness marker to scan for in the buffered output: the framing prefix
 * followed by the per-open secret. Only an executed sentinel emits this exact
 * sequence, so matching it proves the shell reached its interactive read loop.
 */
export function shellReadyMarker(token: string): string {
  return `${TERMINAL_SHELL_READY_FRAME}${token}`;
}

export type AwaitShellReadyOptions = {
  signal?: AbortSignal;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  retryIntervalMs?: number;
};

/**
 * Writes the sentinel and waits for the secret marker to appear in the
 * buffered output, re-sending the sentinel on a slow or stdin-reading startup
 * profile. Resolves once the shell has proven it can accept input, or rejects
 * by outcome when the session closes, the call is aborted, or the deadline
 * passes — a readiness failure must never deliver the initial command.
 */
export async function awaitShellReady(
  probe: TerminalShellReadyProbe,
  sentinel: string,
  marker: string,
  options: AwaitShellReadyOptions = {},
): Promise<TerminalShellReadyOutcome> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TERMINAL_SHELL_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_SHELL_READY_POLL_INTERVAL_MS;
  const retryIntervalMs = options.retryIntervalMs ?? TERMINAL_SHELL_READY_RETRY_INTERVAL_MS;
  const signal = options.signal;

  const startedAt = now();
  let lastSentinelAt = startedAt;
  if (!probe.write(sentinel)) {
    return { ok: false, code: "closed" };
  }
  for (;;) {
    if (signal?.aborted) {
      return { ok: false, code: "aborted" };
    }
    if (probe.isClosed()) {
      return { ok: false, code: "closed" };
    }
    if (probe.snapshot().includes(marker)) {
      return { ok: true };
    }
    if (now() - startedAt >= timeoutMs) {
      return { ok: false, code: "timeout" };
    }
    if (now() - lastSentinelAt >= retryIntervalMs) {
      // A startup profile that reads stdin (rare) can swallow the first
      // sentinel; re-send so the line reaches the interactive read loop.
      if (!probe.write(sentinel)) {
        return { ok: false, code: "closed" };
      }
      lastSentinelAt = now();
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
