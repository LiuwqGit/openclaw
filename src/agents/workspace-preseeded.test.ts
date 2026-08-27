// Split from workspace.test.ts, which sits exactly at the oxlint max-lines
// ceiling (the ratchet forbids growth). Regression coverage for
// operator-preseeded (managed/GitOps) workspaces (#91931): preseeded profile
// diffs are persisted as provenance at first seed and never complete
// onboarding by themselves.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readWorkspaceStateSnapshot } from "./workspace-state-store.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
  resolveWorkspaceBootstrapStatus,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-preseeded-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

async function makePreseededWorkspace(): Promise<string> {
  const tempDir = await makeTempWorkspace("openclaw-preseeded-");
  await writeWorkspaceFile({
    dir: tempDir,
    name: DEFAULT_IDENTITY_FILENAME,
    content: "# IDENTITY.md\n\n- **Name:** Preseeded\n",
  });
  await writeWorkspaceFile({
    dir: tempDir,
    name: DEFAULT_BOOTSTRAP_FILENAME,
    content: "# BOOTSTRAP.md\n\nFirst-run onboarding flow\n",
  });
  return tempDir;
}

async function expectBootstrapPending(tempDir: string): Promise<void> {
  await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
  await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
  await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(true);
}

describe("preseeded workspace bootstrap", () => {
  it("preserves BOOTSTRAP.md across restarts when profiles were operator-preseeded", async () => {
    const tempDir = await makePreseededWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expectBootstrapPending(tempDir);
    const setup = readWorkspaceStateSnapshot(tempDir).setup;
    expect(setup.setupCompletedAt).toBeUndefined();
    expect(setup.profilePreseeded).toBe(true);
  });

  it("does not treat preseeded workspace skills as bootstrap completion evidence", async () => {
    const tempDir = await makePreseededWorkspace();
    await fs.mkdir(path.join(tempDir, "skills", "example"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "skills", "example", "SKILL.md"), "# Example\n");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expectBootstrapPending(tempDir);
  });

  it("completes preseeded workspaces once durable user content exists", async () => {
    const tempDir = await makePreseededWorkspace();
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    expect(readWorkspaceStateSnapshot(tempDir).setup.setupCompletedAt).toMatch(
      /\d{4}-\d{2}-\d{2}T/,
    );
  });
});
