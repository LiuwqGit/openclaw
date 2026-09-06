import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "../infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveConversationRouteEligibilityForAgent } from "./conversation-route-ownership.js";

const baseConversation = {
  accountId: "default",
  channel: "reef",
  kind: "group" as const,
  peerId: "topic-42",
  target: "group:topic-42",
};

function configWithBindings(bindings: NonNullable<OpenClawConfig["bindings"]>): OpenClawConfig {
  return {
    agents: { entries: { main: { default: true }, finance: {} } },
    bindings,
  };
}

describe("resolveConversationRouteEligibilityForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = {
      ...baseConversation,
      routeContextObserved: true as const,
      routeContext: { parentPeerId: "parent-room" },
    };

    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "main", conversation }),
    ).toBe("denied");
    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "finance", conversation }),
    ).toBe("eligible");
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "unrelated-room" } },
      },
    ]);

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, threadId: "topic-7" },
      }),
    ).toBe("eligible");
  });

  it("replays a legacy thread parent binding from its retained route peer", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "main", conversation }),
    ).toBe("denied");
    expect(
      resolveConversationRouteEligibilityForAgent({ config, agentId: "finance", conversation }),
    ).toBe("eligible");
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "*" }, teamId: "finance" },
      },
    ]);

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: baseConversation,
      }),
    ).toBe("denied");

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, routeContextObserved: true },
      }),
    ).toBe("eligible");
  });
});

describe("resolveConversationRouteEligibilityForAgent with LINE-style generic routing", () => {
  const lineConversation = {
    accountId: "default",
    channel: "line",
    kind: "direct" as const,
    peerId: "user-1",
    target: "line:user-1",
  };

  function configWithLineAcpBinding(): OpenClawConfig {
    return {
      agents: { entries: { main: { default: true }, codex: {} } },
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
    };
  }

  function registerLineRuntimeBinding(record: SessionBindingRecord): ReturnType<typeof vi.fn> {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: record.conversation.channel,
      accountId: record.conversation.accountId,
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === record.conversation.conversationId ? record : null,
      touch,
    });
    return touch;
  }

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            id: "line",
            bindings: {
              compileConfiguredBinding: ({ conversationId }) =>
                conversationId ? { conversationId } : null,
              matchInboundConversation: ({ compiledBinding, conversationId }) =>
                conversationId && compiledBinding.conversationId === conversationId
                  ? { conversationId, matchPriority: 2 }
                  : null,
            } satisfies NonNullable<ChannelPlugin["bindings"]>,
          },
        },
      ]),
    );
  });

  afterEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
  });

  it("authorizes the configured ACP owner and rejects the competing agent when only a stale generic runtime record exists", () => {
    const config = configWithLineAcpBinding();
    // Stale catch-all row: a generic session-kind record no live producer can create anymore.
    registerLineRuntimeBinding({
      bindingId: "default:user-1",
      targetSessionKey: "agent:main:line:default:direct:user-1",
      targetKind: "session",
      conversation: { channel: "line", accountId: "default", conversationId: "user-1" },
      status: "active",
      boundAt: 1,
    });

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "codex",
        conversation: lineConversation,
      }),
    ).toBe("eligible");
    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: lineConversation,
      }),
    ).toBe("denied");
  });

  it("follows a live subagent runtime binding instead of the configured ACP owner after reassignment", () => {
    const config = configWithLineAcpBinding();
    // Active subagent thread binding created by bindThreadForSubagentSpawn.
    registerLineRuntimeBinding({
      bindingId: "default:user-1",
      targetSessionKey: "agent:main:subagent:spawn-4",
      targetKind: "subagent",
      conversation: { channel: "line", accountId: "default", conversationId: "user-1" },
      status: "active",
      boundAt: 1,
    });

    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "main",
        conversation: lineConversation,
      }),
    ).toBe("eligible");
    expect(
      resolveConversationRouteEligibilityForAgent({
        config,
        agentId: "codex",
        conversation: lineConversation,
      }),
    ).toBe("denied");
  });
});
