/**
 * Tests Windows plugin command resolution for home-relative executable paths.
 */
import { spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import { closePluginTestAdmissions, createExecution } from "./execute-plugin.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closePluginTestAdmissions();
});

describe("plugin-owned Windows home-relative command resolution", () => {
  it("launches a home-relative plugin command on Windows from the effective home", async () => {
    const root = tempDirs.make("openclaw-plugin-home-relative-");
    const home = path.join(root, "home");
    const bin = path.join(home, "bin");
    const workspace = path.join(root, "workspace");
    await mkdir(bin, { recursive: true });
    await mkdir(workspace);
    const entry = path.join(bin, "tool.js");
    await writeFile(entry, "process.stdout.write(process.argv[2]);\n", "utf8");
    // The Windows resolver probes PATH with PATHEXT extensions, so the child
    // node program must be discoverable as node.exe like on a real Windows host.
    const winBin = path.join(root, "winbin");
    await mkdir(winBin);
    const nodeExe = path.join(winBin, "node.exe");
    await symlink(process.execPath, nodeExe);

    const { context } = await createExecution();
    context.workspaceDir = workspace;
    let observedCommand: string | undefined;
    let observedArgs: readonly string[] | undefined;
    let childStdout = "";
    const execute: CliBackendExecute = async function* (child) {
      observedCommand = child.command;
      observedArgs = child.args;
      const proc = spawn(child.command, child.args, {
        cwd: child.cwd,
        env: child.env,
        signal: child.abortSignal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<number | null>((resolve) => {
        proc.once("close", (code) => resolve(code));
      });
      childStdout = await text(proc.stdout);
      const code = await closed;
      if (code !== 0) {
        throw new Error(`home-relative fixture exited with code ${code}`);
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: childStdout,
        session_id: "sdk-session",
      };
    };

    await expect(
      withMockedWindowsPlatform(() =>
        executePluginOwnedProcess({
          context,
          execute,
          executionCommand: path.join("~", "bin", "tool.js"),
          executionArgs: ["home-relative-ok"],
          env: {
            HOME: home,
            PATH: winBin,
            PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS",
          },
          prompt: "hello",
          useResume: false,
          sessionId: "sdk-session",
          noOutputTimeoutMs: 10_000,
          consumeStdout: () => {},
        }),
      ),
    ).resolves.toMatchObject({ reason: "exit", exitCode: 0, timedOut: false });

    expect(path.basename(observedCommand ?? "").toLowerCase()).toBe("node.exe");
    expect(path.normalize(observedArgs?.[0] ?? "")).toBe(path.normalize(entry));
    expect(observedArgs?.[1]).toBe("home-relative-ok");
    expect(childStdout).toBe("home-relative-ok");
  });
});
