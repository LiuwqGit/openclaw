import fs from "node:fs/promises";
import path from "node:path";
import { validateToolArguments } from "@openclaw/llm-core/validation";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createReadToolDefinition } from "./read.js";
import { readToolInputSchema } from "./tool-schemas.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const readTool = {
  name: "read",
  description: "Read text/image file",
  parameters: readToolInputSchema,
};

type ReadTool = ReturnType<typeof createReadToolDefinition>;

/** Run model-authored arguments through the same validation the agent loop applies. */
function validateReadArguments(args: Record<string, unknown>): Record<string, unknown> {
  return validateToolArguments(readTool, {
    type: "toolCall",
    id: "read-call",
    name: "read",
    arguments: args,
  }) as Record<string, unknown>;
}

function executeRead(tool: ReadTool, args: Parameters<ReadTool["execute"]>[1]) {
  return tool.execute("read", args, undefined, undefined, {} as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("read tool optional flag", () => {
  it("accepts explicit optional: false and reads the existing file", async () => {
    const dir = tempDirs.make("read-optional-false-");
    await fs.writeFile(path.join(dir, "notes.txt"), "required file body\n");

    const args = validateReadArguments({
      path: "notes.txt",
      offset: 1,
      limit: 400,
      optional: false,
    });
    expect(args.optional).toBe(false);

    const result = await executeRead(createReadToolDefinition(dir), args as never);
    expect(textOf(result)).toContain("required file body");
    expect(result.details).toMatchObject({ kind: "text" });
  });

  it("keeps a missing file an error when optional is false", async () => {
    const dir = tempDirs.make("read-optional-false-missing-");
    const args = validateReadArguments({ path: "absent.txt", optional: false });

    await expect(executeRead(createReadToolDefinition(dir), args as never)).rejects.toThrow(
      /absent\.txt/,
    );
  });

  it("still returns structured not_found when optional is true", async () => {
    const dir = tempDirs.make("read-optional-true-missing-");
    const args = validateReadArguments({ path: "absent.txt", optional: true });

    const result = await executeRead(createReadToolDefinition(dir), args as never);
    expect(result.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "absent.txt",
      optional: true,
    });
  });
});
