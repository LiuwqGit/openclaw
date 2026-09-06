// Gateway send and queued-recovery boundary tests for binding precedence.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
} from "../config/sessions/conversation-delivery-store.js";
import { registerConversationAddresses } from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultConversationDeliveryDeps } from "../infra/outbound/conversation-delivery.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { ConversationInputError } from "./conversation-errors.js";
import { assertQueuedConversationDeliveryAttemptAuthorized } from "./conversation-route-ownership.js";
import { runGatewayConversationSend } from "./conversation-send.js";

const address = {
  channel: "line",
  accountId: "default",
  kind: "direct" as const,
  peerId: "user-1",
};

const conversation = {
  ...address,
  conversationRef: buildConversationRef(address),
  target: "line:user-1",
  sessionId: "line-session",
  sessionKey: "agent:main:line:direct:user-1",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
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

function createSendDeps(agentId: string) {
  const dirs = createTempDirTracker();
  const agentDir = path.join(dirs.make("openclaw-gateway-binding-precedence-"), "agents", agentId);
  const scope = { agentId, storePath: path.join(agentDir, "sessions", "sessions.json") };
  onTestFinished(() => {
    closeOpenClawAgentDatabaseByPath(path.join(agentDir, "agent", "openclaw-agent.sqlite"));
    dirs.cleanup();
  });
  registerConversationAddresses(scope, [{ ...conversation, deliveryTarget: conversation.target }]);

  const runMessageActionMock = vi.fn(async (input: Record<string, unknown>) => {
    const onDeliveryIntent = input.onDeliveryIntent as (intent: {
      id: string;
      channel: string;
      to: string;
      durability: "required";
    }) => void;
    onDeliveryIntent({
      id: "queue-1",
      channel: "line",
      to: "line:user-1",
      durability: "required",
    });
    const sent: Extract<MessageActionResult, { kind: "send" }> = {
      kind: "send",
      channel: "line",
      action: "send",
      to: conversation.target,
      handledBy: "core",
      payload: {},
      sendResult: {
        channel: "line",
        to: conversation.target,
        via: "direct",
        mediaUrl: null,
        result: { messageId: "line-outbound-1" },
        deliveryStatus: "sent",
      },
      dryRun: false,
    };
    return sent;
  });

  return {
    ...defaultConversationDeliveryDeps,
    scope,
    config: {
      ...configWithLineAcpBinding(),
      session: { store: scope.storePath },
    },
    resolveConversation: vi.fn(() => conversation),
    runMessageAction: runMessageActionMock as never,
    runMessageActionMock,
  };
}

function registerLineRuntimeBinding(record: SessionBindingRecord): void {
  registerSessionBindingAdapter({
    channel: record.conversation.channel,
    accountId: record.conversation.accountId,
    listBySession: () => [],
    resolveByConversation: (ref) =>
      ref.conversationId === record.conversation.conversationId ? record : null,
    touch: vi.fn(),
  });
}

function staleGenericRuntimeBinding(): SessionBindingRecord {
  // Legacy catch-all row: session-kind target with no bind-API provenance.
  return {
    bindingId: "default:user-1",
    targetSessionKey: "agent:main:line:default:direct:user-1",
    targetKind: "session",
    conversation: { channel: "line", accountId: "default", conversationId: "user-1" },
    status: "active",
    boundAt: 1,
  };
}

describe("gateway send authorization with binding precedence", () => {
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

  it("delivers for the configured ACP owner when only a stale generic runtime record exists", async () => {
    registerLineRuntimeBinding(staleGenericRuntimeBinding());
    const deps = createSendDeps("codex");

    await expect(
      runGatewayConversationSend(
        {
          config: deps.config,
          agentId: "codex",
          senderIsOwner: true,
          operationId: "send-owner",
          conversationRef: conversation.conversationRef,
          message: "hello from the configured owner",
        },
        deps,
      ),
    ).resolves.toEqual({
      status: "sent",
      conversationRef: conversation.conversationRef,
      channel: "line",
      messageId: "line-outbound-1",
      queueId: "queue-1",
    });
    expect(deps.runMessageActionMock).toHaveBeenCalledOnce();
  });

  it("rejects the competing agent before any transport attempt", async () => {
    registerLineRuntimeBinding(staleGenericRuntimeBinding());
    const deps = createSendDeps("main");

    await expect(
      runGatewayConversationSend(
        {
          config: deps.config,
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-competing",
          conversationRef: conversation.conversationRef,
          message: "hello from the competing agent",
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: ConversationInputError.name,
      message: expect.stringContaining("not available to this agent"),
    });
    expect(deps.runMessageActionMock).not.toHaveBeenCalled();
  });

  it("follows a live subagent reassignment through queued delivery recovery", () => {
    registerLineRuntimeBinding(staleGenericRuntimeBinding());
    const configuredOwnerDeps = createSendDeps("codex");
    const reassignedOwnerDeps = createSendDeps("main");

    // Both agents hold a durable queued delivery that has not been sent yet.
    for (const deps of [configuredOwnerDeps, reassignedOwnerDeps]) {
      beginConversationDeliveryOperation(deps.scope, {
        operationId: "send-queued",
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "queued before reassignment",
      });
      markConversationDeliveryQueued(deps.scope, "send-queued", "queue-1");
    }
    const routeFingerprint = resolveConversationRouteFingerprint(conversation);

    // The conversation is reassigned to a live subagent thread binding.
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    registerLineRuntimeBinding({
      bindingId: "default:user-1",
      targetSessionKey: "agent:main:subagent:spawn-4",
      targetKind: "subagent",
      conversation: { channel: "line", accountId: "default", conversationId: "user-1" },
      status: "active",
      boundAt: 2,
    });

    // Queued recovery now authorizes the reassigned owner and rejects the previous one
    // before any transport attempt.
    expect(() =>
      assertQueuedConversationDeliveryAttemptAuthorized({
        config: reassignedOwnerDeps.config,
        agentId: "main",
        operationId: "send-queued",
        routeFingerprint,
        storePath: reassignedOwnerDeps.scope.storePath,
      }),
    ).not.toThrow();
    expect(() =>
      assertQueuedConversationDeliveryAttemptAuthorized({
        config: configuredOwnerDeps.config,
        agentId: "codex",
        operationId: "send-queued",
        routeFingerprint,
        storePath: configuredOwnerDeps.scope.storePath,
      }),
    ).toThrow(PlatformMessageNotDispatchedError);
  });
});
