import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { normalizeE164 } from "../../text-runtime.js";

export function resolveDirectPeerId(params: {
  msg: WebInboundMessage;
  normalizeE164?: (value: string) => string | null;
}) {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.conversation.kind === "group") {
    return undefined;
  }
  const dmSenderId = admission.sender.dmSenderId;
  const normalize = params.normalizeE164 ?? normalizeE164;
  return normalize(dmSenderId) ?? dmSenderId;
}

export function resolvePeerId(msg: WebInboundMessage) {
  const admission = requireWhatsAppInboundAdmission(msg);
  return resolveDirectPeerId({ msg }) ?? admission.conversation.id;
}
