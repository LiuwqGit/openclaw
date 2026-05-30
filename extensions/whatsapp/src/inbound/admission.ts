import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type {
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  ReplyToMode,
} from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedWhatsAppInboundPolicy } from "../inbound-policy.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";

type WhatsAppInboundSenderAdmissionProjection = Pick<
  ResolvedChannelMessageIngress["senderAccess"],
  | "allowed"
  | "decision"
  | "reasonCode"
  | "effectiveAllowFrom"
  | "effectiveGroupAllowFrom"
  | "providerMissingFallbackApplied"
>;

export type WhatsAppInboundCommandAuthorization = Pick<
  ResolvedChannelMessageIngress["commandAccess"],
  "authorized" | "reasonCode"
> & {
  evaluated: boolean;
};

export type WhatsAppInboundCommandAccess = WhatsAppInboundCommandAuthorization & {
  requested: boolean;
  shouldBlockControlCommand: boolean;
};

export type WhatsAppInboundGroupAllowlistPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
};

export type WhatsAppInboundContextVisibilityPolicy = {
  mode?: ContextVisibilityMode;
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
  requireMention: boolean;
  groupAllowlist: WhatsAppInboundGroupAllowlistPolicy;
};

export type WhatsAppInboundResolvedPolicy = {
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  configuredAllowFrom: string[];
  dmAllowFrom: string[];
  groupAllowFrom: string[];
  providerMissingFallbackApplied: boolean;
  requireMention: boolean;
  groupAllowlist: WhatsAppInboundGroupAllowlistPolicy;
  contextVisibility: WhatsAppInboundContextVisibilityPolicy;
  commandAuthorization: WhatsAppInboundCommandAuthorization;
  systemPrompt?: string;
};

/**
 * Accepted inbound facts resolved once by access control.
 *
 * Admission owns account, sender, conversation, accepted policy, prompt, and
 * context facts. Route lifecycle, audio preflight, receipt feedback, and other
 * post-admission processing state belong to monitor/process handoff types.
 */
export type WhatsAppInboundAdmission = {
  accountId: string;
  isSelfChat: boolean;
  account: {
    accountId: string;
    name?: string;
    authDir: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  conversation: {
    kind: "direct" | "group";
    id: string;
    groupSessionId: string;
    requireMention: boolean;
  };
  sender: {
    id: string;
    dmSenderId: string;
    isSamePhone: boolean;
    isDmSenderSamePhone: boolean;
  };
  senderAccess: WhatsAppInboundSenderAdmissionProjection;
  resolvedPolicy: WhatsAppInboundResolvedPolicy;
};

export function requireWhatsAppInboundAdmission(source: {
  admission?: WhatsAppInboundAdmission;
}): WhatsAppInboundAdmission {
  if (!source.admission) {
    throw new Error("WhatsApp inbound admission is required for accepted inbound messages");
  }
  return source.admission;
}

function copyStringArray(values: readonly string[]): string[] {
  return [...values];
}

function copyAccount(
  account: ResolvedWhatsAppInboundPolicy["account"],
): WhatsAppInboundAdmission["account"] {
  const copied: WhatsAppInboundAdmission["account"] = {
    accountId: account.accountId,
    authDir: account.authDir,
    enabled: account.enabled,
    sendReadReceipts: account.sendReadReceipts,
  };
  if (account.name) {
    copied.name = account.name;
  }
  if (typeof account.selfChatMode === "boolean") {
    copied.selfChatMode = account.selfChatMode;
  }
  if (account.replyToMode) {
    copied.replyToMode = account.replyToMode;
  }
  return copied;
}

function copyCommandAuthorization(
  access: ResolvedChannelMessageIngress["commandAccess"],
): WhatsAppInboundCommandAuthorization {
  return {
    evaluated: access.requested,
    authorized: access.authorized,
    reasonCode: access.reasonCode,
  };
}

function readSystemPrompt(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const systemPrompt = value.systemPrompt;
  return typeof systemPrompt === "string" ? systemPrompt : undefined;
}

function resolvePromptValue(params: {
  specific?: unknown;
  wildcard?: unknown;
}): string | undefined {
  const specific = readSystemPrompt(params.specific);
  if (specific !== undefined) {
    return specific.trim() || undefined;
  }
  const wildcard = readSystemPrompt(params.wildcard);
  return wildcard !== undefined ? wildcard.trim() || undefined : undefined;
}

function resolveDirectSystemPrompt(params: {
  policy: ResolvedWhatsAppInboundPolicy;
  dmSenderId: string;
}): string | undefined {
  const direct = params.policy.account.direct;
  return resolvePromptValue({
    specific: direct?.[params.dmSenderId],
    wildcard: direct?.["*"],
  });
}

function resolveGroupSystemPrompt(params: {
  conversationGroupPolicy: ReturnType<
    ResolvedWhatsAppInboundPolicy["resolveConversationGroupPolicy"]
  >;
}): string | undefined {
  return resolvePromptValue({
    specific: params.conversationGroupPolicy.groupConfig,
    wildcard: params.conversationGroupPolicy.defaultConfig,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function hasBoolean(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "boolean";
}

function hasStringArray(record: Record<string, unknown>, key: string): boolean {
  return (
    Array.isArray(record[key]) &&
    (record[key] as unknown[]).every((item) => typeof item === "string")
  );
}

function hasCommandAuthorizationShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasBoolean(value, "evaluated") &&
    hasBoolean(value, "authorized") &&
    hasString(value, "reasonCode")
  );
}

function hasGroupAllowlistShape(value: unknown): boolean {
  return isRecord(value) && hasBoolean(value, "allowlistEnabled") && hasBoolean(value, "allowed");
}

function hasContextVisibilityShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.mode === undefined ||
      value.mode === "all" ||
      value.mode === "allowlist" ||
      value.mode === "allowlist_quote") &&
    hasString(value, "groupPolicy") &&
    hasStringArray(value, "groupAllowFrom") &&
    hasBoolean(value, "requireMention") &&
    hasGroupAllowlistShape(value.groupAllowlist)
  );
}

function hasResolvedPolicyShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, "dmPolicy") &&
    hasString(value, "groupPolicy") &&
    hasStringArray(value, "configuredAllowFrom") &&
    hasStringArray(value, "dmAllowFrom") &&
    hasStringArray(value, "groupAllowFrom") &&
    hasBoolean(value, "providerMissingFallbackApplied") &&
    hasBoolean(value, "requireMention") &&
    hasGroupAllowlistShape(value.groupAllowlist) &&
    hasContextVisibilityShape(value.contextVisibility) &&
    hasCommandAuthorizationShape(value.commandAuthorization)
  );
}

export function isWhatsAppInboundAdmission(value: unknown): value is WhatsAppInboundAdmission {
  if (!isRecord(value)) {
    return false;
  }

  const account = value.account;
  const conversation = value.conversation;
  const sender = value.sender;
  const senderAccess = value.senderAccess;

  return (
    hasString(value, "accountId") &&
    hasBoolean(value, "isSelfChat") &&
    isRecord(account) &&
    hasString(account, "accountId") &&
    hasString(account, "authDir") &&
    hasBoolean(account, "enabled") &&
    hasBoolean(account, "sendReadReceipts") &&
    isRecord(conversation) &&
    (conversation.kind === "direct" || conversation.kind === "group") &&
    hasString(conversation, "id") &&
    hasString(conversation, "groupSessionId") &&
    hasBoolean(conversation, "requireMention") &&
    isRecord(sender) &&
    hasString(sender, "id") &&
    hasString(sender, "dmSenderId") &&
    hasBoolean(sender, "isSamePhone") &&
    hasBoolean(sender, "isDmSenderSamePhone") &&
    isRecord(senderAccess) &&
    hasBoolean(senderAccess, "allowed") &&
    hasString(senderAccess, "decision") &&
    hasResolvedPolicyShape(value.resolvedPolicy)
  );
}

export function buildWhatsAppInboundAdmission(params: {
  policy: ResolvedWhatsAppInboundPolicy;
  senderAccess: WhatsAppInboundSenderAdmissionProjection;
  commandAccess: ResolvedChannelMessageIngress["commandAccess"];
  isGroup: boolean;
  conversationId: string;
  senderId: string;
  dmSenderId: string;
}): WhatsAppInboundAdmission {
  const groupSessionId = resolveWhatsAppGroupConversationId(params.conversationId);
  const conversationGroupPolicy = params.isGroup
    ? params.policy.resolveConversationGroupPolicy(params.conversationId)
    : { allowlistEnabled: false, allowed: true };
  const requireMention = params.isGroup
    ? params.policy.resolveConversationRequireMention(params.conversationId)
    : false;
  const groupAllowlist = {
    allowlistEnabled: conversationGroupPolicy.allowlistEnabled,
    allowed: conversationGroupPolicy.allowed,
  };
  const systemPrompt = params.isGroup
    ? resolveGroupSystemPrompt({ conversationGroupPolicy })
    : resolveDirectSystemPrompt({
        policy: params.policy,
        dmSenderId: params.dmSenderId,
      });
  const resolvedPolicy: WhatsAppInboundResolvedPolicy = {
    dmPolicy: params.policy.dmPolicy,
    groupPolicy: params.policy.groupPolicy,
    configuredAllowFrom: copyStringArray(params.policy.configuredAllowFrom),
    dmAllowFrom: copyStringArray(params.policy.dmAllowFrom),
    groupAllowFrom: copyStringArray(params.policy.groupAllowFrom),
    providerMissingFallbackApplied: params.policy.providerMissingFallbackApplied,
    requireMention,
    groupAllowlist,
    contextVisibility: {
      mode: params.policy.contextVisibilityMode,
      groupPolicy: params.policy.groupPolicy,
      groupAllowFrom: copyStringArray(params.policy.groupAllowFrom),
      requireMention,
      groupAllowlist: { ...groupAllowlist },
    },
    commandAuthorization: copyCommandAuthorization(params.commandAccess),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };

  return {
    accountId: params.policy.account.accountId,
    isSelfChat: params.policy.isSelfChat,
    account: copyAccount(params.policy.account),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
      groupSessionId,
      requireMention,
    },
    sender: {
      id: params.senderId,
      dmSenderId: params.dmSenderId,
      isSamePhone: params.policy.isSamePhone(params.senderId),
      isDmSenderSamePhone: params.policy.isSamePhone(params.dmSenderId),
    },
    senderAccess: {
      allowed: params.senderAccess.allowed,
      decision: params.senderAccess.decision,
      reasonCode: params.senderAccess.reasonCode,
      effectiveAllowFrom: copyStringArray(params.senderAccess.effectiveAllowFrom),
      effectiveGroupAllowFrom: copyStringArray(params.senderAccess.effectiveGroupAllowFrom),
      providerMissingFallbackApplied: params.senderAccess.providerMissingFallbackApplied,
    },
    resolvedPolicy,
  };
}
