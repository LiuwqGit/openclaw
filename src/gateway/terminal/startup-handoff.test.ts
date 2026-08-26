import { describe, expect, it } from "vitest";
import {
  awaitShellReady,
  generateShellReadyToken,
  shellReadyMarker,
  shellReadySentinel,
  TERMINAL_SHELL_READY_ENV,
  type TerminalShellReadyProbe,
} from "./startup-handoff.js";

function makeProbe(options: {
  output?: () => string;
  closed?: () => boolean;
  onWrite?: (data: string) => void;
}): { probe: TerminalShellReadyProbe; writes: string[] } {
  const writes: string[] = [];
  const output = options.output ?? (() => "");
  const closed = options.closed ?? (() => false);
  const probe: TerminalShellReadyProbe = {
    write: (data) => {
      writes.push(data);
      options.onWrite?.(data);
      return true;
    },
    snapshot: output,
    isClosed: closed,
  };
  return { probe, writes };
}

describe("terminal startup handoff", () => {
  it("builds a POSIX sentinel that echoes the framed per-open env secret", () => {
    const expected = `echo "${shellReadyMarker("")}$${TERMINAL_SHELL_READY_ENV}"\r`;
    expect(shellReadySentinel("/bin/zsh")).toBe(expected);
    expect(shellReadySentinel("/bin/sh")).toBe(expected);
    expect(shellReadySentinel("/usr/bin/fish")).toBe(expected);
  });

  it("builds a cmd.exe sentinel that expands %NAME%, not $NAME", () => {
    const expected = `echo ${shellReadyMarker("")}%${TERMINAL_SHELL_READY_ENV}%\r`;
    expect(shellReadySentinel("cmd.exe")).toBe(expected);
    expect(shellReadySentinel("C:\\Windows\\System32\\cmd.exe")).toBe(expected);
  });

  it("builds a PowerShell sentinel that expands $env:NAME", () => {
    const expected = `echo "${shellReadyMarker("")}$env:${TERMINAL_SHELL_READY_ENV}"\r`;
    expect(shellReadySentinel("pwsh")).toBe(expected);
    expect(shellReadySentinel("powershell")).toBe(expected);
    expect(shellReadySentinel("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(expected);
  });

  it("returns undefined for an unsupported configured shell", () => {
    // gateway.terminal.shell accepts an arbitrary executable; an unrecognized
    // shell family must not be forced through a POSIX probe it cannot
    // acknowledge (which would time out and close its terminal).
    expect(shellReadySentinel("/usr/bin/nu")).toBeUndefined();
    expect(shellReadySentinel("python3")).toBeUndefined();
    expect(shellReadySentinel("/usr/local/bin/elvish")).toBeUndefined();
    expect(shellReadySentinel("/usr/bin/dtcsh-family-binary")).toBeUndefined();
  });

  it("generates distinct hex tokens with no shell metacharacters", () => {
    const a = generateShellReadyToken();
    const b = generateShellReadyToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("resolves once the shell echoes the framed readiness marker", async () => {
    const token = generateShellReadyToken();
    const marker = shellReadyMarker(token);
    const sentinel = shellReadySentinel("/bin/sh")!;
    let buffered = "";
    const { probe, writes } = makeProbe({
      output: () => buffered,
      onWrite: (data) => {
        // A ready shell executes the sentinel and prints the framed marker.
        if (data === sentinel) {
          buffered += `${marker}\r\n`;
        }
      },
    });
    const result = await awaitShellReady(probe, sentinel, marker, {
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
    // Exactly one sentinel; the readiness probe never writes the payload.
    expect(writes).toEqual([sentinel]);
  });

  it("does not false-ready when a startup profile emits the raw token before the sentinel runs", async () => {
    const token = generateShellReadyToken();
    const marker = shellReadyMarker(token);
    // A login profile that dumps its environment prints `NAME=token`; the raw
    // token is in the buffer before the sentinel has executed. The framed
    // marker must not match this, so the handoff waits and times out instead
    // of delivering the payload into the same startup race.
    const envDump = `${TERMINAL_SHELL_READY_ENV}=${token}\r\n`;
    const { probe } = makeProbe({ output: () => envDump });
    const result = await awaitShellReady(probe, shellReadySentinel("/bin/sh")!, marker, {
      timeoutMs: 12,
      retryIntervalMs: 1000,
      pollIntervalMs: 4,
    });
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("re-sends the sentinel once when a startup profile swallowed the first", async () => {
    const token = generateShellReadyToken();
    const marker = shellReadyMarker(token);
    const sentinel = shellReadySentinel("/bin/sh")!;
    let buffered = "";
    let writes = 0;
    const probe: TerminalShellReadyProbe = {
      write: (data) => {
        writes += 1;
        // The first sentinel is consumed by profile sourcing; the second
        // reaches the interactive read loop and echoes the framed marker.
        if (data === sentinel && writes > 1) {
          buffered += `${marker}\r\n`;
        }
        return true;
      },
      snapshot: () => buffered,
      isClosed: () => false,
    };
    const result = await awaitShellReady(probe, sentinel, marker, {
      pollIntervalMs: 1,
      retryIntervalMs: 3,
    });
    expect(result).toEqual({ ok: true });
    expect(writes).toBe(2);
  });

  it("fails closed when the session exits before readiness", async () => {
    const marker = shellReadyMarker(generateShellReadyToken());
    const { probe } = makeProbe({ output: () => "", closed: () => true });
    const result = await awaitShellReady(probe, shellReadySentinel("/bin/sh")!, marker, {
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: false, code: "closed" });
  });

  it("fails aborted when the caller signal is already aborted", async () => {
    const marker = shellReadyMarker(generateShellReadyToken());
    const { probe } = makeProbe({ output: () => "" });
    const controller = new AbortController();
    controller.abort();
    const result = await awaitShellReady(probe, shellReadySentinel("/bin/sh")!, marker, {
      signal: controller.signal,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: false, code: "aborted" });
  });

  it("times out when the shell never reports readiness", async () => {
    const marker = shellReadyMarker(generateShellReadyToken());
    const { probe } = makeProbe({ output: () => "" });
    const result = await awaitShellReady(probe, shellReadySentinel("/bin/sh")!, marker, {
      timeoutMs: 12,
      retryIntervalMs: 1000,
      pollIntervalMs: 4,
    });
    expect(result).toEqual({ ok: false, code: "timeout" });
  });

  it("fails closed when the probe write fails", async () => {
    const marker = shellReadyMarker(generateShellReadyToken());
    const probe: TerminalShellReadyProbe = {
      write: () => false,
      snapshot: () => "",
      isClosed: () => false,
    };
    const result = await awaitShellReady(probe, shellReadySentinel("/bin/sh")!, marker, {
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: false, code: "closed" });
  });
});
