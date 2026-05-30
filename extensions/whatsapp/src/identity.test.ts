import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMentionIdentities,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
} from "./identity.js";
import type { WhatsAppInboundAdmission } from "./inbound/admission.js";

function admissionForSender(
  senderId: string,
  account?: Partial<WhatsAppInboundAdmission["account"]>,
): WhatsAppInboundAdmission {
  return {
    accountId: "default",
    account: {
      accountId: "default",
      authDir: "/tmp/auth",
      enabled: true,
      sendReadReceipts: true,
      ...account,
    },
    conversation: {
      kind: "direct",
      id: "+15550001111",
      groupSessionId: "+15550001111",
      requireMention: false,
    },
    sender: {
      id: senderId,
      dmSenderId: senderId,
      isSamePhone: false,
      isDmSenderSamePhone: false,
    },
    senderAccess: { allowed: true, decision: "allowed" },
    resolvedPolicy: {},
  } as unknown as WhatsAppInboundAdmission;
}

function senderIdentityForAdmissionId(senderId: string) {
  return getSenderIdentity({
    admission: admissionForSender(senderId),
    platform: {},
  });
}

async function withTempAuthDir<T>(fn: (authDir: string) => Promise<T>): Promise<T> {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-identity-"));
  try {
    return await fn(authDir);
  } finally {
    await fs.rm(authDir, { recursive: true, force: true });
  }
}

describe("WhatsApp sender identity", () => {
  it("does not coerce unresolved LID senders into phone numbers", () => {
    const sender = senderIdentityForAdmissionId("999999@lid");

    expect(sender).toMatchObject({
      jid: null,
      lid: "999999@lid",
      e164: null,
    });
  });

  it("keeps phone admission ids as the comparable phone identity", () => {
    const sender = senderIdentityForAdmissionId("+15550001111");

    expect(sender).toMatchObject({
      jid: null,
      lid: null,
      e164: "+15550001111",
    });
  });

  it("uses admitted account authDir for default LID normalization", async () => {
    await withTempAuthDir(async (authDir) => {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );

      const source = {
        admission: admissionForSender("777@lid", { authDir }),
        group: {
          mentions: {
            jids: ["777@lid"],
          },
        },
        platform: {
          sender: {},
          selfJid: "777@lid",
        },
        quote: {
          body: "quoted",
          sender: {
            jid: "777@lid",
          },
        },
      };

      expect(getSenderIdentity(source).e164).toBe("+1777");
      expect(getSelfIdentity(source).e164).toBe("+1777");
      expect(getReplyContext(source)?.sender?.e164).toBe("+1777");
      expect(getMentionIdentities(source)).toMatchObject([{ e164: "+1777" }]);
    });
  });
});
