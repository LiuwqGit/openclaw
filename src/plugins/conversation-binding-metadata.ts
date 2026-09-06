export type PluginBindingMetadata = {
  pluginBindingOwner: "plugin";
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
  bindingAttemptId?: string;
};

/**
 * Provenance stamped on records written by the public generic bind API
 * (`bindGenericCurrentConversation`). Its presence distinguishes intentional SDK
 * bindings from legacy rows persisted by the removed catch-all writer, which never
 * recorded a binding origin.
 */
export const GENERIC_BIND_API_BINDING_ORIGIN = "generic-bind-api";

export function isGenericBindApiBindingMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  // SAFETY: The object guard permits property inspection.
  return (metadata as Record<string, unknown>).bindingOrigin === GENERIC_BIND_API_BINDING_ORIGIN;
}

export function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  // SAFETY: The object guard permits property inspection; required fields are checked below.
  const record = metadata as Record<string, unknown>;
  return (
    record.pluginBindingOwner === "plugin" &&
    typeof record.pluginId === "string" &&
    typeof record.pluginRoot === "string"
  );
}

export function isPluginOwnedSessionBindingRecord(
  record: { metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return isPluginOwnedBindingMetadata(record?.metadata);
}
