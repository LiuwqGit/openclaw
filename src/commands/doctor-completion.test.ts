import { describe, expect, it, vi } from "vitest";
import {
  runShellCompletionHealth,
  shellCompletionStatusToHealthFindings,
  type ShellCompletionStatus,
} from "./doctor-completion.js";

function status(overrides: Partial<ShellCompletionStatus>): ShellCompletionStatus {
  return {
    shell: "zsh",
    profileInstalled: true,
    cacheExists: true,
    cachePath: "/tmp/openclaw.zsh",
    usesSlowPattern: false,
    ...overrides,
  };
}

describe("shell completion health", () => {
  it("detects slow dynamic completion profiles", () => {
    expect(shellCompletionStatusToHealthFindings(status({ usesSlowPattern: true }))).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: expect.stringContaining("slow dynamic completion"),
      }),
    );
  });

  it("detects missing completion cache for installed profiles", () => {
    expect(shellCompletionStatusToHealthFindings(status({ cacheExists: false }))).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/shell-completion",
        severity: "warning",
        message: expect.stringContaining("cache is missing"),
      }),
    );
  });

  it("keeps missing optional completion quiet by default", () => {
    expect(shellCompletionStatusToHealthFindings(status({ profileInstalled: false }))).toEqual([]);
  });

  it("treats healthy completion as a quiet no-op", async () => {
    await expect(
      runShellCompletionHealth({
        repair: true,
        deps: {
          status: status({}),
        },
      }),
    ).resolves.toEqual({
      findings: [],
      changes: [],
      warnings: [],
    });
  });

  it("keeps optional completion read-only outside repair mode", async () => {
    const confirm = vi.fn(async () => true);
    const generateCompletionCache = vi.fn(async () => true);
    const installCompletion = vi.fn(async () => undefined);

    await expect(
      runShellCompletionHealth({
        repair: false,
        deps: {
          status: status({ profileInstalled: false, cacheExists: false }),
          confirm,
          generateCompletionCache,
          installCompletion,
        },
      }),
    ).resolves.toEqual({
      findings: [],
      changes: [],
      warnings: [],
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(generateCompletionCache).not.toHaveBeenCalled();
    expect(installCompletion).not.toHaveBeenCalled();
  });

  it("repairs missing completion cache without prompting", async () => {
    const generateCompletionCache = vi.fn(async () => true);

    await expect(
      runShellCompletionHealth({
        repair: true,
        deps: {
          status: status({ cacheExists: false }),
          generateCompletionCache,
        },
      }),
    ).resolves.toMatchObject({
      status: "repaired",
      changes: ["Completion cache regenerated at /tmp/openclaw.zsh"],
      warnings: [],
    });
    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
  });

  it("repairs slow dynamic completion profiles", async () => {
    const generateCompletionCache = vi.fn(async () => true);
    const installCompletion = vi.fn(async () => undefined);

    const result = await runShellCompletionHealth({
      repair: true,
      deps: {
        status: status({ cacheExists: false, usesSlowPattern: true }),
        generateCompletionCache,
        installCompletion,
      },
    });

    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
    expect(installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(result).toMatchObject({
      status: "repaired",
      changes: [expect.stringContaining("Shell completion upgraded")],
      warnings: [],
    });
  });

  it("prompts before installing optional completion", async () => {
    const confirm = vi.fn(async () => true);
    const generateCompletionCache = vi.fn(async () => true);
    const installCompletion = vi.fn(async () => undefined);

    const result = await runShellCompletionHealth({
      repair: true,
      deps: {
        status: status({ profileInstalled: false, cacheExists: false }),
        confirm,
        generateCompletionCache,
        installCompletion,
      },
    });

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable zsh shell completion for openclaw?",
      initialValue: true,
    });
    expect(generateCompletionCache).toHaveBeenCalledTimes(1);
    expect(installCompletion).toHaveBeenCalledWith("zsh", true, "openclaw");
    expect(result.changes).toContainEqual(expect.stringContaining("Shell completion installed"));
  });

  it("treats declined optional completion install as a quiet no-op", async () => {
    const result = await runShellCompletionHealth({
      repair: true,
      deps: {
        status: status({ profileInstalled: false, cacheExists: false }),
        confirm: vi.fn(async () => false),
        generateCompletionCache: vi.fn(async () => true),
        installCompletion: vi.fn(async () => undefined),
      },
    });

    expect(result).toMatchObject({
      status: "repaired",
      changes: [],
      warnings: [],
    });
  });
});
