import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { probeSqliteDatabaseHeaders } from "./sqlite-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("SQLite header probes", () => {
  it.each(["spawn failure", "malformed output"])(
    "refuses %s without retaining a negative answer",
    (failure) => {
      const directory = tempDirs.make("sqlite-header-failure-");
      const plainPath = path.join(directory, "ordinary.db");
      fs.writeFileSync(plainPath, "ordinary bytes");
      const spawn = vi.spyOn(childProcess, "spawnSync");
      if (failure === "spawn failure") {
        spawn.mockImplementationOnce(() => {
          throw new Error("synthetic process failure");
        });
      } else {
        spawn.mockReturnValueOnce({
          pid: 0,
          output: [],
          stdout: "preload noise",
          stderr: "",
          status: 0,
          signal: null,
        });
      }
      expect(() => probeSqliteDatabaseHeaders([plainPath])).toThrow(
        "Could not determine whether backup files are SQLite databases",
      );
      expect(probeSqliteDatabaseHeaders([plainPath])).toEqual(new Map([[plainPath, false]]));
    },
  );
});
