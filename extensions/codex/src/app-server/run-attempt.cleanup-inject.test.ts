// Codex tests cover run-attempt cleanup behavior in the post-turn-accept window.
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex app-server cleanup window", () => {
  it("runs full cleanup when a synchronous throw occurs during attachBackend in the uncovered window", async () => {
    // Verifies that the expanded try boundary (moved from just before
    // `await completion` to right after turn acceptance) allows the single
    // cleanup finally to fire for every resource — not just the shared-client
    // lease — when a synchronous throw lands in the post-turn-accept setup.
    const params = createParams(tempDir + "/session.json", tempDir + "/workspace");
    const detachBackend = vi.fn();
    params.replyOperation = {
      attachBackend: vi.fn().mockImplementation(() => {
        throw new Error("inject: post-turn-accept setup failure");
      }),
      detachBackend,
    } as unknown as NonNullable<typeof params.replyOperation>;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "inject: post-turn-accept setup failure",
    );

    // The expanded try boundary means the cleanup finally runs and calls
    // detachBackend even though attachBackend threw — because `handle` was
    // already assigned before the throw.
    expect(detachBackend).toHaveBeenCalledTimes(1);
  });
});
