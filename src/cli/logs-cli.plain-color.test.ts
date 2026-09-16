// Logs CLI --plain color contract tests (issue #149569): diagnostics and
// notices must not carry ANSI styling when --plain is selected, even when
// terminal colors are enabled. Styling is force-enabled via a Chalk level-2
// theme mock because test runners execute with colors disabled.
import { Chalk } from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerLogsCli } from "./logs-cli.js";

const { callGatewayFromCli, buildGatewayConnectionDetails } = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  const styled = new Chalk({ level: 2 });
  const hex = (value: string) => styled.hex(value);
  const palette = await import("../../packages/terminal-core/src/palette.js");
  return {
    ...actual,
    isRich: () => true,
    theme: {
      ...actual.theme,
      accent: hex(palette.LOBSTER_PALETTE.accent),
      accentBright: hex(palette.LOBSTER_PALETTE.accentBright),
      accentDim: hex(palette.LOBSTER_PALETTE.accentDim),
      info: hex(palette.LOBSTER_PALETTE.info),
      success: hex(palette.LOBSTER_PALETTE.success),
      warn: hex(palette.LOBSTER_PALETTE.warn),
      error: hex(palette.LOBSTER_PALETTE.error),
      muted: hex(palette.LOBSTER_PALETTE.muted),
    },
  };
});

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: (...args: unknown[]) =>
    buildGatewayConnectionDetails(...(args as [])),
  isGatewayTransportError: () => false,
}));

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      exit: vi.fn((code: number) => {
        process.exit(code);
      }),
    },
  };
});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

async function runLogsCli(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli as (program: import("commander").Command) => void,
    argv,
  });
}

function captureStderrWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe("logs cli --plain color contract", () => {
  beforeEach(() => {
    buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:1",
      urlSource: "cli",
      message: "",
    });
  });

  afterEach(() => {
    callGatewayFromCli.mockReset();
    buildGatewayConnectionDetails.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "--plain", args: ["--plain"] },
    { name: "--plain --follow", args: ["--plain", "--follow"] },
  ])("emits gateway error diagnostics without ANSI styling for $name", async ({ args }) => {
    callGatewayFromCli.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    );
    const stderrWrites = captureStderrWrites();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runLogsCli(["logs", ...args, "--url", "ws://127.0.0.1:1", "--timeout", "100"]);

    const stderr = stderrWrites.join("");
    expect(stderr).toContain("ECONNREFUSED");
    expect(stderr).toContain("Hint: run");
    expect(stderr).not.toContain("\u001b[");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("keeps ANSI styling in gateway error diagnostics without --plain", async () => {
    callGatewayFromCli.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    );
    const stderrWrites = captureStderrWrites();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runLogsCli(["logs", "--url", "ws://127.0.0.1:1", "--timeout", "100"]);

    const stderr = stderrWrites.join("");
    expect(stderr).toContain("ECONNREFUSED");
    expect(stderr).toContain("\u001b[");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
