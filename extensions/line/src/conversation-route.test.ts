// Line tests cover conversation route plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineBindingsAdapter } from "./bindings.js";
import { resolveLineConversationRoute } from "./conversation-route.js";

const lineBindingsPlugin = {
  id: "line",
  bindings: lineBindingsAdapter,
  conversationBindings: {
    defaultTopLevelPlacement: "current",
    supportsCurrentConversationBinding: true,
  },
};

const configuredAcpCfg = (store: string): OpenClawConfig =>
  ({
    session: { store, mainKey: "main", scope: "per-sender" },
    agents: { list: [{ id: "main" }, { id: "codex" }] },
    bindings: [
      { agentId: "main", match: { channel: "line", accountId: "default" } },
      {
        type: "acp",
        agentId: "codex",
        match: {
          channel: "line",
          accountId: "default",
          peer: { kind: "direct", id: "user-1" },
        },
      },
    ],
  }) satisfies OpenClawConfig;

describe("resolveLineConversationRoute", () => {
  let tmpDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: lineBindingsPlugin.id,
          plugin: lineBindingsPlugin,
          source: "test",
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-route-"));
    cfg = configuredAcpCfg(path.join(tmpDir, "sessions.json"));
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it("keeps the configured ACP binding when a stale non-ACP runtime binding exists", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "line",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "user-1"
          ? {
              bindingId: "default:user-1",
              // Stale catch-all row predating the configured ACP binding.
              targetSessionKey: "agent:main:line:default:direct:user-1",
              targetKind: "session",
              conversation: {
                channel: "line",
                accountId: "default",
                conversationId: "user-1",
              },
              status: "active",
              boundAt: 1,
            }
          : null,
      touch,
    });

    const result = resolveLineConversationRoute({
      cfg,
      accountId: "default",
      peerId: "user-1",
      isGroup: false,
    });

    expect(result.route.agentId).toBe("codex");
    expect(result.route.sessionKey).toMatch(/^agent:codex:acp:binding:line:/);
    expect(result.configuredBinding).not.toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });

  it("keeps a live subagent runtime binding over the configured ACP binding", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "line",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "user-1"
          ? {
              bindingId: "default:user-1",
              // Active subagent thread binding created by bindThreadForSubagentSpawn.
              targetSessionKey: "agent:main:subagent:spawn-4",
              targetKind: "subagent",
              conversation: {
                channel: "line",
                accountId: "default",
                conversationId: "user-1",
              },
              status: "active",
              boundAt: Date.now(),
            }
          : null,
      touch,
    });

    const result = resolveLineConversationRoute({
      cfg,
      accountId: "default",
      peerId: "user-1",
      isGroup: false,
    });

    expect(result.route.agentId).toBe("main");
    expect(result.route.sessionKey).toBe("agent:main:subagent:spawn-4");
    expect(result.route.matchedBy).toBe("binding.channel");
    expect(result.configuredBinding).toBeNull();
    expect(touch).toHaveBeenCalled();
  });
});
