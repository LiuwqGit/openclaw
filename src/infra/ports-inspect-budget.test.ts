import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import { inspectPortUsage } from "./ports-inspect.js";

const runCommand = vi.hoisted(() =>
  vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
);
const probePortUsage = vi.hoisted(() => vi.fn<typeof import("./ports-probe.js").probePortUsage>());
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommand }));
vi.mock("./ports-lsof.js", () => ({ resolveLsofCommand: async () => "lsof" }));
vi.mock("./windows-install-roots.js", () => ({
  getWindowsSystem32ExePath: (name: string) => name,
  getWindowsPowerShellExePath: () => "powershell.exe",
  getWindowsWmicExePath: () => "wmic.exe",
}));
vi.mock("./ports-probe.js", () => ({ probePortUsage }));

const originalPlatform = process.platform;
afterEach(() => {
  vi.restoreAllMocks();
  runCommand.mockReset();
  probePortUsage.mockReset();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

function commandResult(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}

describe("port inspection probe budget", () => {
  it("forwards the confirm probe budget to active port probes", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    runCommand.mockResolvedValue(commandResult(""));
    probePortUsage.mockResolvedValue("free");

    const usage = await inspectPortUsage(18789, {
      probeHosts: ["127.0.0.1"],
      probeBudgetMs: 4_750,
    });

    expect(usage.status).toBe("free");
    expect(probePortUsage).toHaveBeenCalledWith(18789, ["127.0.0.1"], undefined, 4_750);
  });
});
