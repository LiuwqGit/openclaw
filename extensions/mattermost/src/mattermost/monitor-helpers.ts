// Mattermost helper module supports monitor helpers behavior.
import { formatInboundFromLabel as formatInboundFromLabelShared } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys as resolveThreadSessionKeysShared } from "openclaw/plugin-sdk/routing";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";

export { rawDataToString };

export const formatInboundFromLabel = formatInboundFromLabelShared;

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeysShared({
    ...params,
    normalizeThreadId: (threadId) => threadId,
  });
}

/**
 * Strip bot mention from message text while preserving newlines and
 * block-level Markdown formatting (headings, lists, blockquotes).
 */
export function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasMentionRe = new RegExp(`@${escaped}\\b`, "i");
  const leadingMentionRe = new RegExp(`^([\\t ]*)@${escaped}\\b[\\t ]*`, "i");
  const trailingMentionRe = new RegExp(`[\\t ]*@${escaped}\\b[\\t ]*$`, "i");
  const normalizedLines = text.split("\n").map((line) => {
    const hadMention = hasMentionRe.test(line);
    const normalizedLine = line
      .replace(leadingMentionRe, "$1")
      .replace(trailingMentionRe, "")
      .replace(new RegExp(`@${escaped}\\b`, "gi"), "")
      .replace(/(\S)[ \t]{2,}/g, "$1 ");
    return {
      text: normalizedLine,
      mentionOnlyBlank: hadMention && normalizedLine.trim() === "",
    };
  });

  while (normalizedLines[0]?.mentionOnlyBlank) {
    normalizedLines.shift();
  }
  while (normalizedLines.at(-1)?.text.trim() === "") {
    normalizedLines.pop();
  }

  return normalizedLines.map((line) => line.text).join("\n");
}

/** True when an inbound post should be dropped after mention normalization left no body text. */
export function shouldDropEmptyNormalizedMattermostBody(params: {
  bodyText: string;
  wasMentioned: boolean;
  rawText: string;
  botUsername?: string;
}): boolean {
  if (params.bodyText.trim()) {
    return false;
  }
  if (params.wasMentioned) {
    return false;
  }
  const botUsername = params.botUsername?.trim();
  if (!botUsername) {
    return true;
  }
  const normalizedRaw = params.rawText.toLowerCase();
  const normalizedBot = botUsername.toLowerCase();
  return !normalizedRaw.includes(`@${normalizedBot}`);
}
