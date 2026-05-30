import { requireWhatsAppInboundAdmission } from "./inbound/admission.js";
import type { WhatsAppInboundAdmission } from "./inbound/admission.js";
import { jidToE164, normalizeE164 } from "./text-runtime.js";

const WHATSAPP_LID_RE = /@(lid|hosted\.lid)$/i;

export type WhatsAppIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
  name?: string | null;
  label?: string | null;
};

export type WhatsAppSelfIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
};

export type WhatsAppReplyContext = {
  id?: string;
  body: string;
  sender?: WhatsAppIdentity | null;
};

type AdmissionIdentitySource = {
  admission?: WhatsAppInboundAdmission;
};

type SenderIdentitySource = AdmissionIdentitySource & {
  platform: {
    sender?: WhatsAppIdentity;
    senderJid?: string;
    senderName?: string;
  };
};

type SelfIdentitySource = AdmissionIdentitySource & {
  platform: {
    self?: WhatsAppSelfIdentity;
    selfJid?: string | null;
    selfLid?: string | null;
    selfE164?: string | null;
  };
};

type ReplyContextSource = AdmissionIdentitySource & {
  quote?: {
    context?: WhatsAppReplyContext;
    id?: string;
    body?: string;
    sender?: {
      displayName?: string;
      jid?: string;
      e164?: string;
    };
  };
};

type MentionIdentitySource = AdmissionIdentitySource & {
  group?: {
    mentions?: {
      text?: string[];
      jids?: string[];
    };
  };
};

function normalizeDeviceScopedJid(jid: string | null | undefined): string | null {
  return jid ? jid.replace(/:\d+/, "") : null;
}

function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid && WHATSAPP_LID_RE.test(jid));
}

function resolveIdentityAuthDir(
  source: AdmissionIdentitySource,
  authDir?: string,
): string | undefined {
  return authDir ?? source.admission?.account.authDir;
}

function resolveAdmittedSenderIdentity(
  senderId: string,
): Pick<WhatsAppIdentity, "jid" | "lid" | "e164"> {
  const normalized = normalizeDeviceScopedJid(senderId.trim());
  if (!normalized) {
    return {};
  }
  if (isLidJid(normalized)) {
    return { lid: normalized };
  }
  if (normalized.includes("@")) {
    return { jid: normalized };
  }
  return { e164: normalized };
}

export function resolveComparableIdentity(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  authDir?: string,
): WhatsAppIdentity {
  const rawJid = normalizeDeviceScopedJid(identity?.jid);
  const rawLid = normalizeDeviceScopedJid(identity?.lid);
  const lid = rawLid ?? (isLidJid(rawJid) ? rawJid : null);
  const jid = rawJid && !isLidJid(rawJid) ? rawJid : null;
  const e164 =
    identity?.e164 != null
      ? normalizeE164(identity.e164)
      : ((jid ? jidToE164(jid, authDir ? { authDir } : undefined) : null) ??
        (lid ? jidToE164(lid, authDir ? { authDir } : undefined) : null));
  return {
    ...identity,
    jid,
    lid,
    e164,
  };
}

export function getComparableIdentityValues(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): string[] {
  const resolved = resolveComparableIdentity(identity);
  return [resolved.e164, resolved.jid, resolved.lid].filter((value): value is string =>
    Boolean(value),
  );
}

export function identitiesOverlap(
  left: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  right: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): boolean {
  const leftValues = new Set(getComparableIdentityValues(left));
  if (leftValues.size === 0) {
    return false;
  }
  return getComparableIdentityValues(right).some((value) => leftValues.has(value));
}

export function getSenderIdentity(msg: SenderIdentitySource, authDir?: string): WhatsAppIdentity {
  const admission = requireWhatsAppInboundAdmission(msg);
  const platformSender = msg.platform.sender;
  const admittedSender = resolveAdmittedSenderIdentity(admission.sender.id);
  const effectiveAuthDir = resolveIdentityAuthDir(msg, authDir);
  return resolveComparableIdentity(
    {
      jid: platformSender?.jid ?? msg.platform.senderJid ?? admittedSender.jid ?? null,
      lid: platformSender?.lid ?? admittedSender.lid ?? null,
      e164: admittedSender.e164 ?? null,
      name: platformSender?.name ?? msg.platform.senderName ?? null,
      label: platformSender?.label ?? null,
    },
    effectiveAuthDir,
  );
}

export function getSelfIdentity(msg: SelfIdentitySource, authDir?: string): WhatsAppSelfIdentity {
  const effectiveAuthDir = resolveIdentityAuthDir(msg, authDir);
  return resolveComparableIdentity(
    msg.platform.self ?? {
      jid: msg.platform.selfJid ?? null,
      lid: msg.platform.selfLid ?? null,
      e164: msg.platform.selfE164 ?? null,
    },
    effectiveAuthDir,
  );
}

export function getReplyContext(
  msg: ReplyContextSource,
  authDir?: string,
): WhatsAppReplyContext | null {
  const effectiveAuthDir = resolveIdentityAuthDir(msg, authDir);
  if (msg.quote?.context) {
    return {
      ...msg.quote.context,
      sender: resolveComparableIdentity(msg.quote.context.sender, effectiveAuthDir),
    };
  }
  if (!msg.quote?.body) {
    return null;
  }
  return {
    id: msg.quote.id,
    body: msg.quote.body,
    sender: resolveComparableIdentity(
      {
        jid: msg.quote.sender?.jid ?? null,
        e164: msg.quote.sender?.e164 ?? null,
        label: msg.quote.sender?.displayName ?? null,
      },
      effectiveAuthDir,
    ),
  };
}

function getMentionJids(msg: MentionIdentitySource): string[] {
  return msg.group?.mentions?.jids ?? msg.group?.mentions?.text ?? [];
}

export function getMentionIdentities(
  msg: MentionIdentitySource,
  authDir?: string,
): WhatsAppIdentity[] {
  const effectiveAuthDir = resolveIdentityAuthDir(msg, authDir);
  return getMentionJids(msg).map((jid) => resolveComparableIdentity({ jid }, effectiveAuthDir));
}

export function getPrimaryIdentityId(identity: WhatsAppIdentity | null | undefined): string | null {
  return identity?.e164 || identity?.jid?.trim() || identity?.lid || null;
}
