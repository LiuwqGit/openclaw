import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

// Network.setCacheDisabled is a session cache toggle: like the other
// TAB_SCOPED_COMMANDS configuration methods, its receipt must survive an
// allowed document change while genuine revocation still rejects it.
const tabId = 7;
const originalUrl = "https://example.com/existing";
const destinationUrl = "https://example.com/destination";

type Frame = {
  seq?: number;
  type?: string;
  message?: string;
  result?: Record<string, unknown>;
};

const releases = new Set<() => void>();

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finish = () => {
    releases.delete(finish);
    release();
  };
  releases.add(finish);
  return { promise, resolve: finish };
}

beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases) {
    release();
  }
  releases.clear();
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

async function setup(mode: "all" | "selected") {
  const harness = await loadBackground({
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: mode,
    },
    initialTabs: [{ id: tabId, url: originalUrl, groupId: 7, windowId: 1 }],
  });
  const socket = harness.relaySockets[0];
  assert(socket);
  await harness.authenticate(socket);
  let seq = 1000;
  const frames = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)) as Frame[];
  const dispatch = (message: Record<string, unknown>) => {
    const id = ++seq;
    socket.receive({ ...message, seq: id });
    return id;
  };
  const response = async (id: number) =>
    await vi.waitFor(() => {
      const frame = frames().find((entry) => entry.seq === id);
      assert(frame, `missing relay reply ${id}`);
      return frame;
    });
  expect(await response(dispatch({ type: "attach", tabId }))).toMatchObject({ type: "result" });
  return { harness, dispatch, response, frames };
}

function holdCacheDisable(harness: Awaited<ReturnType<typeof loadBackground>>) {
  const started = deferred();
  const completed = deferred();
  const native = harness.debuggerSendCommand.getMockImplementation()!;
  harness.debuggerSendCommand.mockImplementation(async (source, method, params) => {
    if (method !== "Network.setCacheDisabled") {
      return await native(source, method, params);
    }
    expect(params).toEqual({ cacheDisabled: true });
    started.resolve();
    await completed.promise;
    return {};
  });
  return { started, complete: completed.resolve };
}

const dispatchCacheDisable = (rig: Awaited<ReturnType<typeof setup>>) =>
  rig.dispatch({
    type: "cdp",
    tabId,
    method: "Network.setCacheDisabled",
    params: { cacheDisabled: true },
  });

// An ordinary navigation to another eligible URL keeps tab authority while
// retiring the previous document (the documented access contract).
function commitAllowedDocument(harness: Awaited<ReturnType<typeof loadBackground>>) {
  harness.updateTab(tabId, { url: destinationUrl, pendingUrl: undefined });
  harness.debuggerEventListener?.({ tabId }, "Page.frameNavigated", {
    frame: { id: "root", loaderId: "destination-loader", url: destinationUrl },
  });
  harness.debuggerEventListener?.({ tabId }, "Page.lifecycleEvent", {
    name: "load",
    frameId: "root",
    loaderId: "destination-loader",
  });
}

describe("Network.setCacheDisabled across allowed document changes", () => {
  it.each(["all", "selected"] as const)(
    "delivers the receipt after an allowed document commit during dispatch (%s mode)",
    async (mode) => {
      const rig = await setup(mode);
      const held = holdCacheDisable(rig.harness);
      const id = dispatchCacheDisable(rig);
      await held.started.promise;
      commitAllowedDocument(rig.harness);
      held.complete();
      expect(await rig.response(id)).toMatchObject({ type: "result", result: {} });
      expect(
        await rig.response(
          rig.dispatch({
            type: "cdp",
            tabId,
            method: "Network.setCacheDisabled",
            params: { cacheDisabled: true },
          }),
        ),
      ).toMatchObject({ type: "result" });
    },
  );

  it.each(["all", "selected"] as const)(
    "delivers the receipt when the allowed document commit follows dispatch completion (%s mode)",
    async (mode) => {
      const rig = await setup(mode);
      const held = holdCacheDisable(rig.harness);
      const id = dispatchCacheDisable(rig);
      await held.started.promise;
      held.complete();
      expect(await rig.response(id)).toMatchObject({ type: "result", result: {} });
      commitAllowedDocument(rig.harness);
      expect(
        await rig.response(
          rig.dispatch({
            type: "cdp",
            tabId,
            method: "Network.setCacheDisabled",
            params: { cacheDisabled: true },
          }),
        ),
      ).toMatchObject({ type: "result" });
    },
  );

  it.each(["all", "selected"] as const)(
    "still rejects the receipt after genuine access revocation (%s mode)",
    async (mode) => {
      const rig = await setup(mode);
      const held = holdCacheDisable(rig.harness);
      const id = dispatchCacheDisable(rig);
      await held.started.promise;
      await sendRuntimeMessage(rig.harness, {
        type: "toggleTabAccess",
        tabId,
        accessMode: mode,
        grant: false,
      });
      held.complete();
      const frame = await rig.response(id);
      expect(frame.type).toBe("error");
      expect(frame.result).toBeUndefined();
    },
  );

  it("still rejects the receipt after the debugger detaches during dispatch", async () => {
    const rig = await setup("selected");
    const held = holdCacheDisable(rig.harness);
    const id = dispatchCacheDisable(rig);
    await held.started.promise;
    rig.harness.debuggerDetachListener?.({ tabId }, "canceled_by_user");
    held.complete();
    const frame = await rig.response(id);
    expect(frame.type).toBe("error");
    expect(frame.result).toBeUndefined();
  });
});
