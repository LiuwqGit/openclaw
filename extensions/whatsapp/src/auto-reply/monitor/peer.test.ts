import { describe, expect, it } from "vitest";
import type { WhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { resolvePeerId } from "./peer.js";

function createMessage(params: {
  kind: "direct" | "group";
  conversationId: string;
  senderId: string;
  dmSenderId: string;
}): WebInboundMessage {
  const admission = {
    accountId: "default",
    account: { accountId: "default", authDir: "/tmp/auth", enabled: true, sendReadReceipts: true },
    conversation: {
      kind: params.kind,
      id: params.conversationId,
      groupSessionId: params.conversationId,
      requireMention: false,
    },
    sender: {
      id: params.senderId,
      dmSenderId: params.dmSenderId,
      isSamePhone: false,
      isDmSenderSamePhone: false,
    },
    senderAccess: { allowed: true, decision: "allowed" },
    resolvedPolicy: {},
  } as unknown as WhatsAppInboundAdmission;

  return {
    admission,
    event: {},
    payload: { body: "hello" },
    platform: {
      chatJid: params.conversationId,
      recipientJid: "+15550000000",
      sender: { e164: "+19999999999" },
      sendComposing: async () => undefined,
      reply: async () => ({ ok: true }),
      sendMedia: async () => ({ ok: true }),
    },
    from: params.kind === "group" ? "mutable@g.us" : "+19999999999",
    conversationId: params.kind === "group" ? "mutable@g.us" : "+19999999999",
    accountId: "default",
    accessControlPassed: true,
    chatType: params.kind,
  };
}

describe("resolvePeerId", () => {
  it("uses admitted direct sender identity instead of mutable message sender fields", () => {
    const msg = createMessage({
      kind: "direct",
      conversationId: "+15550001111",
      senderId: "+15550002222",
      dmSenderId: "+15550002222",
    });

    expect(resolvePeerId(msg)).toBe("+15550002222");
  });

  it("uses admitted group conversation identity instead of mutable message fields", () => {
    const msg = createMessage({
      kind: "group",
      conversationId: "1203630@g.us",
      senderId: "+15550002222",
      dmSenderId: "1203630@g.us",
    });

    expect(resolvePeerId(msg)).toBe("1203630@g.us");
  });
});
