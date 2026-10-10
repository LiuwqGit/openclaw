import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

// Count how many times jiti's expensive esmResolve is invoked for a shared
// "./x.js" -> "x.ts" lookup. Resolving such a specifier is the dominant capture
// cost (jiti 2.7.0 throws an unbounded-stack error per failed candidate). The
// artifact memoizes resolution within one capture, so two sibling files importing
// the same module from the same directory must probe it once, not once per import
// site.
const sharedProbes = vi.hoisted(() => ({ count: 0 }));
vi.mock("./jiti-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jiti-factory.js")>();
  return {
    ...actual,
    createJiti: (
      id: Parameters<typeof actual.createJiti>[0],
      options?: Parameters<typeof actual.createJiti>[1],
    ) => {
      const resolver = actual.createJiti(id, options);
      const esmResolve = resolver.esmResolve.bind(resolver);
      resolver.esmResolve = ((spec: string, opts?: unknown) => {
        const target = typeof spec === "string" ? spec : String(spec);
        if (target.includes("shared.js")) {
          sharedProbes.count += 1;
        }
        return esmResolve(spec, opts as Parameters<typeof esmResolve>[1]);
      }) as typeof resolver.esmResolve;
      return resolver;
    },
  };
});

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it("resolves a shared sibling module once across files in one capture", () => {
  const source = temp.make("plugin-resolver-memo-");
  fs.writeFileSync(path.join(source, "shared.ts"), "export const shared = 1;");
  fs.writeFileSync(path.join(source, "other.ts"), 'export { shared } from "./shared.js";');
  fs.writeFileSync(
    path.join(source, "index.ts"),
    'export * from "./other.js";\nexport * from "./shared.js";',
  );
  sharedProbes.count = 0;
  const artifact = capturePluginGenerationArtifact(source, path.join(source, "index.ts"));
  cleanups.push(artifact.dispose);
  expect(artifact.assertSourceCurrent).not.toThrow();
  // index.ts and other.ts import "./shared.js" from the same directory; only
  // shared.ts exists. Without memoization this ".js" -> ".ts" lookup is probed
  // twice; with it the second lookup is served from the capture-wide memo.
  expect(sharedProbes.count).toBe(1);
});
