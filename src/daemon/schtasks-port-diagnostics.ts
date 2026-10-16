import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import type { PortUsage } from "../infra/ports-types.js";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { sleep } from "../utils.js";

const GATEWAY_PORT_RELEASE_TIMEOUT_MS = 5_000;

/**
 * Waits for the Gateway port to settle after a stop, returning the last
 * observation so callers can distinguish an observed busy listener from an
 * inconclusive probe.
 */
export async function waitForGatewayPortRelease(
  port: number,
  probeHosts: readonly string[],
): Promise<PortUsage | null> {
  const deadline = Date.now() + GATEWAY_PORT_RELEASE_TIMEOUT_MS;
  let last: PortUsage | null = null;
  while (Date.now() < deadline) {
    const diagnostics = await inspectPortUsage(port, {
      probeHosts,
      // A closed Windows LAN host can refuse slowly (measured ~2s); one confirm
      // probe may span the remaining budget instead of the 250ms per-probe cutoff.
      probeBudgetMs: deadline - Date.now(),
    }).catch(() => null);
    if (diagnostics?.status === "free") {
      return diagnostics;
    }
    if (diagnostics) {
      last = diagnostics;
    }
    await sleep(Math.min(250, Math.max(deadline - Date.now(), 0)));
  }
  return last;
}

export async function describeUnverifiedPortListeners(
  port: number,
  probeHosts?: readonly string[],
): Promise<string> {
  const diagnostics = await inspectPortUsage(port, probeHosts ? { probeHosts } : undefined).catch(
    () => null,
  );
  const listeners = diagnostics?.status === "busy" ? diagnostics.listeners : [];
  if (!listeners || listeners.length === 0) {
    return "";
  }
  const described = listeners.map((listener) => {
    const pid = typeof listener.pid === "number" ? listener.pid : null;
    const argv = listener.commandLine ? parseWindowsNativeCommandLine(listener.commandLine) : null;
    const identity = argv
      ? classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw"
        ? "openclaw gateway"
        : "not an openclaw gateway"
      : "argv unavailable";
    const name = listener.command ?? "unknown";
    return pid ? `pid ${pid} (${name}, ${identity})` : `${name} (${identity})`;
  });
  const hint = listeners.some((listener) => typeof listener.pid === "number")
    ? ` If one of these is this gateway, stop it with "Stop-Process -Id <pid> -Force" and retry.`
    : "";
  return ` Remaining listener(s): ${described.join(", ")}. If gateway.cmd redirects output, quote the entire redirection target, including environment variables.${hint}`;
}
