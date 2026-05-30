import type { PluginRegistry } from "./registry.js";
import { hasKind } from "./slots.js";

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "embedding"
  | "speech"
  | "realtime-transcription"
  | "realtime-voice"
  | "media-understanding"
  | "transcript-source"
  | "image-generation"
  | "video-generation"
  | "music-generation"
  | "web-search"
  | "agent-harness"
  | "context-engine"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCapabilityEntry = {
  kind: PluginCapabilityKind;
  ids: string[];
};

export type PluginShapeSummary = {
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
  usesLegacyBeforeAgentStart: boolean;
};

function buildPluginCapabilityEntries(
  plugin: PluginRegistry["plugins"][number],
): PluginCapabilityEntry[] {
  return [
    { kind: "cli-backend" as const, ids: plugin.cliBackendIds ?? [] },
    { kind: "text-inference" as const, ids: plugin.providerIds },
    { kind: "embedding" as const, ids: plugin.embeddingProviderIds },
    { kind: "speech" as const, ids: plugin.speechProviderIds },
    { kind: "realtime-transcription" as const, ids: plugin.realtimeTranscriptionProviderIds },
    { kind: "realtime-voice" as const, ids: plugin.realtimeVoiceProviderIds },
    { kind: "media-understanding" as const, ids: plugin.mediaUnderstandingProviderIds },
    { kind: "transcript-source" as const, ids: plugin.transcriptSourceProviderIds },
    { kind: "image-generation" as const, ids: plugin.imageGenerationProviderIds },
    { kind: "video-generation" as const, ids: plugin.videoGenerationProviderIds },
    { kind: "music-generation" as const, ids: plugin.musicGenerationProviderIds },
    { kind: "web-search" as const, ids: plugin.webSearchProviderIds },
    { kind: "agent-harness" as const, ids: plugin.agentHarnessIds },
    {
      kind: "context-engine" as const,
      ids:
        plugin.status === "loaded" && hasKind(plugin.kind, "context-engine")
          ? (plugin.contextEngineIds ?? [])
          : [],
    },
    { kind: "channel" as const, ids: plugin.channelIds },
  ].filter((entry) => entry.ids.length > 0);
}

function derivePluginInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayDiscoveryServiceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayDiscoveryServiceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

function readRecordField(
  value: unknown,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return { ok: false };
    }
    return { ok: true, value: (value as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function readArrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function readArrayElement(
  value: unknown,
  index: number,
): { ok: true; value: unknown } | { ok: false } {
  return readRecordField(value, String(index));
}

export function listPluginOwnedGatewayMethodNames(params: {
  descriptors: unknown;
  pluginId: string;
}): string[] {
  const length = readArrayLength(params.descriptors);
  if (length === undefined) {
    return [];
  }
  const names: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = readArrayElement(params.descriptors, index);
    if (!descriptor.ok) {
      continue;
    }
    const owner = readRecordField(descriptor.value, "owner");
    if (!owner.ok) {
      continue;
    }
    const ownerKind = readRecordField(owner.value, "kind");
    if (!ownerKind.ok || ownerKind.value !== "plugin") {
      continue;
    }
    const ownerPluginId = readRecordField(owner.value, "pluginId");
    if (!ownerPluginId.ok || ownerPluginId.value !== params.pluginId) {
      continue;
    }
    const name = readRecordField(descriptor.value, "name");
    if (name.ok && typeof name.value === "string") {
      names.push(name.value);
    }
  }
  return names;
}

export function buildPluginShapeSummary(params: {
  plugin: PluginRegistry["plugins"][number];
  report: Pick<PluginRegistry, "hooks" | "typedHooks" | "tools" | "gatewayMethodDescriptors">;
}): PluginShapeSummary {
  const capabilities = buildPluginCapabilityEntries(params.plugin);
  const typedHookCount = params.report.typedHooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const customHookCount = params.report.hooks.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const toolCount = params.report.tools.filter(
    (entry) => entry.pluginId === params.plugin.id,
  ).length;
  const gatewayMethodCount = listPluginOwnedGatewayMethodNames({
    descriptors: params.report.gatewayMethodDescriptors,
    pluginId: params.plugin.id,
  }).length;
  const capabilityCount = capabilities.length;
  const shape = derivePluginInspectShape({
    capabilityCount,
    typedHookCount,
    customHookCount,
    toolCount,
    commandCount: params.plugin.commands.length,
    cliCount: params.plugin.cliCommands.length,
    serviceCount: params.plugin.services.length,
    gatewayDiscoveryServiceCount: params.plugin.gatewayDiscoveryServiceIds.length,
    gatewayMethodCount,
    httpRouteCount: params.plugin.httpRoutes,
  });

  return {
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
    usesLegacyBeforeAgentStart: params.report.typedHooks.some(
      (entry) => entry.pluginId === params.plugin.id && entry.hookName === "before_agent_start",
    ),
  };
}
