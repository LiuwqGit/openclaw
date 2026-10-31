import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tempRootModule from "../../infra/tmp-openclaw-dir.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";

describe("prepareClaudeCliSkillsPlugin", () => {
  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-claude-skills-test-" });
  let base: string;
  let pluginTempRoot: string;
  let skillsSnapshot: SkillSnapshot;

  beforeEach(async () => {
    base = await tempRoot.setup();
    pluginTempRoot = path.join(base, "tmp");
    const skillDir = path.join(base, "source", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(pluginTempRoot, { recursive: true });
    await fs.writeFile(skillFile, "# Demo\n", "utf8");
    skillsSnapshot = {
      prompt: "demo",
      skills: [{ name: "demo" }],
      resolvedSkills: [
        {
          name: "demo",
          description: "Demo skill",
          filePath: skillFile,
          baseDir: skillDir,
          source: "openclaw-workspace",
          sourceInfo: {
            path: skillFile,
            source: "openclaw-workspace",
            scope: "project",
            origin: "top-level",
            baseDir: skillDir,
          },
          disableModelInvocation: false,
        },
      ],
    };
    vi.spyOn(tempRootModule, "resolvePreferredOpenClawTmpDir").mockReturnValue(pluginTempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it("removes the temporary plugin tree when directory creation fails", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("removes the temporary plugin tree when the manifest write fails", async () => {
    const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("materializes node-hosted skills from their advertised instructions", async () => {
    const nodeLocator = "node://node-a/skills/remote-demo/SKILL.md";
    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [
          ...(skillsSnapshot.resolvedSkills ?? []),
          {
            name: "remote-demo",
            description: "Node-hosted skill",
            locationNote:
              "Node-hosted on A (node-a). Run referenced files and bins with exec host=node node=node-a.",
            readContent: "# Remote Demo\n\nRun scripts/run.sh from this skill directory.\n",
            filePath: nodeLocator,
            baseDir: "node://node-a/skills/remote-demo",
            source: "openclaw-node",
            sourceInfo: {
              path: nodeLocator,
              source: "openclaw-node",
              scope: "temporary",
              origin: "top-level",
              baseDir: "node://node-a/skills/remote-demo",
            },
            disableModelInvocation: false,
          },
        ],
      },
    });
    try {
      expect(prepared.pluginDir).toBeDefined();
      const materialized = path.join(prepared.pluginDir!, "skills", "remote-demo", "SKILL.md");
      const content = await fs.readFile(materialized, "utf8");
      expect(content).toContain("# Remote Demo");
      expect(content).toContain("exec host=node node=node-a");
      expect([...(prepared.skillCommands?.keys() ?? [])].toSorted()).toEqual([
        "openclaw-skills:demo",
        "openclaw-skills:remote-demo",
      ]);
      expect((await fs.stat(path.join(prepared.pluginDir!, "skills", "demo"))).isDirectory()).toBe(
        true,
      );
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("skips node-hosted skills that advertise no instructions", async () => {
    const nodeLocator = "node://node-a/skills/remote-demo/SKILL.md";
    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [
          {
            name: "remote-demo",
            description: "Node-hosted skill",
            filePath: nodeLocator,
            baseDir: "node://node-a/skills/remote-demo",
            source: "openclaw-node",
            sourceInfo: {
              path: nodeLocator,
              source: "openclaw-node",
              scope: "temporary",
              origin: "top-level",
              baseDir: "node://node-a/skills/remote-demo",
            },
            disableModelInvocation: false,
          },
        ],
      },
    });
    try {
      expect(prepared.args).toEqual([]);
      expect(prepared.pluginDir).toBeUndefined();
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("delivers and cleans up copied skills when symlinks are unavailable", async () => {
    vi.spyOn(fs, "symlink").mockRejectedValueOnce(new Error("unavailable"));
    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot,
    });
    try {
      expect(prepared.pluginDir).toBeDefined();
      const copied = path.join(prepared.pluginDir!, "skills", "demo");
      expect((await fs.lstat(copied)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(copied, "SKILL.md"), "utf8")).toBe("# Demo\n");
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });
});
