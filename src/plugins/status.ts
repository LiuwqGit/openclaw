import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import {
  buildPluginShapeSummary,
  listPluginOwnedGatewayMethodNames,
  readRegistryArrayElement,
  readRegistryArrayLength,
  readRegistryRecordField,
  registryEntryMatchesPluginId,
  type PluginCapabilityEntry,
  type PluginInspectShape,
} from "./inspect-shape.js";
import { loadOpenClawPlugins } from "./loader.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import {
  buildPluginDependencyStatus,
  type PluginDependencyEntry,
  type PluginDependencyStatus,
} from "./status-dependencies.js";
import type { PluginHookName, PluginLogger } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export {
  buildPluginRegistrySnapshotReport,
  type PluginRegistryStatusReport,
} from "./status-snapshot.js";
export type { PluginCapabilityKind, PluginInspectShape } from "./inspect-shape.js";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "legacy-before-agent-start" | "hook-only" | "deprecated-memory-embedding-provider-api";
  compatCode: PluginCompatCode;
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};

export type PluginInspectReport = {
  workspaceDir?: string;
  plugin: PluginRegistry["plugins"][number];
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: PluginCapabilityEntry[];
  typedHooks: Array<{
    name: PluginHookName;
    priority?: number;
  }>;
  customHooks: Array<{
    name: string;
    events: string[];
  }>;
  tools: Array<{
    names: string[];
    optional: boolean;
  }>;
  commands: string[];
  cliCommands: string[];
  services: string[];
  gatewayDiscoveryServices: string[];
  gatewayMethods: string[];
  mcpServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  lspServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  httpRouteCount: number;
  bundleCapabilities: string[];
  diagnostics: PluginDiagnostic[];
  policy: {
    allowPromptInjection?: boolean;
    allowConversationAccess?: boolean;
    hookTimeoutMs?: number;
    hookTimeouts?: Record<string, number>;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
};

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart"> & {
    hasRuntimeMemoryEmbeddingProviderRegistration: boolean;
  },
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
  if (inspect.usesLegacyBeforeAgentStart) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "legacy-before-agent-start",
      compatCode: "legacy-before-agent-start",
      severity: "warn",
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    });
  }
  if (inspect.shape === "hook-only") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "hook-only",
      compatCode: "hook-only-plugin-shape",
      severity: "info",
      message:
        "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
    });
  }
  const usesMemoryEmbeddingProviderApi =
    inspect.plugin.memoryEmbeddingProviderIds.length > 0 ||
    (inspect.plugin.contracts?.memoryEmbeddingProviders?.length ?? 0) > 0 ||
    inspect.hasRuntimeMemoryEmbeddingProviderRegistration;
  if (usesMemoryEmbeddingProviderApi && inspect.plugin.origin !== "bundled") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "deprecated-memory-embedding-provider-api",
      compatCode: "deprecated-memory-embedding-provider-api",
      severity: "warn",
      message:
        "uses deprecated memory-specific embedding provider API; use api.registerEmbeddingProvider and contracts.embeddingProviders for new embedding providers.",
    });
  }
  return warnings;
}

function resolveReportedPluginVersion(
  plugin: PluginRegistry["plugins"][number],
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return plugin.version;
  }
  return (
    normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
    normalizeOpenClawVersionBase(plugin.version) ??
    plugin.version
  );
}

type PluginReportParams = {
  config?: OpenClawConfig;
  effectiveOnly?: boolean;
  onlyPluginIds?: readonly string[];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  resolvedConfig?: OpenClawConfig;
};

function readRegistryStringField(value: unknown, field: string): string | undefined {
  const read = readRegistryRecordField(value, field);
  return read.ok && typeof read.value === "string" ? read.value : undefined;
}

function readRegistryNumberField(value: unknown, field: string): number | undefined {
  const read = readRegistryRecordField(value, field);
  return read.ok && typeof read.value === "number" ? read.value : undefined;
}

function readRegistryBooleanField(value: unknown, field: string): boolean | undefined {
  const read = readRegistryRecordField(value, field);
  return read.ok && typeof read.value === "boolean" ? read.value : undefined;
}

function readRegistryStringArray(value: unknown): string[] | undefined {
  const length = readRegistryArrayLength(value);
  if (length === undefined) {
    return undefined;
  }
  const entries: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(value, index);
    if (entry.ok && typeof entry.value === "string") {
      entries.push(entry.value);
    }
  }
  return entries;
}

function readRegistryStringArrayField(value: unknown, field: string): string[] {
  const read = readRegistryRecordField(value, field);
  return read.ok ? (readRegistryStringArray(read.value) ?? []) : [];
}

function readPluginStatus(value: unknown): PluginRecord["status"] {
  const status = readRegistryStringField(value, "status");
  return status === "loaded" || status === "disabled" || status === "error" ? status : "error";
}

function readPluginOrigin(value: unknown): PluginRecord["origin"] {
  const origin = readRegistryStringField(value, "origin");
  return origin === "bundled" ||
    origin === "workspace" ||
    origin === "global" ||
    origin === "config"
    ? origin
    : "workspace";
}

function readPluginFormat(value: unknown): PluginRecord["format"] | undefined {
  const format = readRegistryStringField(value, "format");
  return format === "openclaw" || format === "bundle" ? format : undefined;
}

function readPluginBundleFormat(value: unknown): PluginRecord["bundleFormat"] | undefined {
  const bundleFormat = readRegistryStringField(value, "bundleFormat");
  return bundleFormat === "codex" || bundleFormat === "claude" || bundleFormat === "cursor"
    ? bundleFormat
    : undefined;
}

function readPluginKind(value: unknown): PluginRecord["kind"] | undefined {
  const kind = readRegistryRecordField(value, "kind");
  if (!kind.ok) {
    return undefined;
  }
  if (typeof kind.value === "string") {
    return kind.value as PluginRecord["kind"];
  }
  return readRegistryStringArray(kind.value) as PluginRecord["kind"] | undefined;
}

function readPluginDateField(value: unknown, field: string): Date | undefined {
  const read = readRegistryRecordField(value, field);
  return read.ok && read.value instanceof Date ? read.value : undefined;
}

function copyRegistryJsonLikeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  const length = readRegistryArrayLength(value);
  if (length !== undefined) {
    const arrayValue = value as object;
    if (seen.has(arrayValue)) {
      return undefined;
    }
    seen.add(arrayValue);
    const entries: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = readRegistryArrayElement(value, index);
      if (entry.ok) {
        entries.push(copyRegistryJsonLikeValue(entry.value, seen));
      }
    }
    seen.delete(arrayValue);
    return entries;
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    seen.delete(value);
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readRegistryRecordField(value, key);
    if (read.ok) {
      const copied = copyRegistryJsonLikeValue(read.value, seen);
      if (copied !== undefined) {
        record[key] = copied;
      }
    }
  }
  seen.delete(value);
  return record;
}

function readPluginJsonLikeObjectField(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  const read = readRegistryRecordField(value, field);
  if (!read.ok) {
    return undefined;
  }
  const copied = copyRegistryJsonLikeValue(read.value);
  return copied && typeof copied === "object" && !Array.isArray(copied)
    ? (copied as Record<string, unknown>)
    : undefined;
}

function readPluginContracts(value: unknown): PluginRecord["contracts"] | undefined {
  const contracts = readRegistryRecordField(value, "contracts");
  if (!contracts.ok) {
    return undefined;
  }
  const normalized: Record<string, string[]> = {};
  for (const field of [
    "embeddedExtensionFactories",
    "agentToolResultMiddleware",
    "externalAuthProviders",
    "embeddingProviders",
    "memoryEmbeddingProviders",
    "speechProviders",
    "realtimeTranscriptionProviders",
    "realtimeVoiceProviders",
    "mediaUnderstandingProviders",
    "transcriptSourceProviders",
    "documentExtractors",
    "imageGenerationProviders",
    "videoGenerationProviders",
    "musicGenerationProviders",
    "webContentExtractors",
    "webFetchProviders",
    "webSearchProviders",
    "migrationProviders",
    "gatewayMethodDispatch",
    "tools",
  ] as const) {
    const entries = readRegistryStringArrayField(contracts.value, field);
    if (entries.length > 0) {
      normalized[field] = entries;
    }
  }
  return Object.keys(normalized).length > 0
    ? (normalized as NonNullable<PluginRecord["contracts"]>)
    : undefined;
}

function readPluginDependencyEntries(value: unknown): PluginDependencyEntry[] {
  const length = readRegistryArrayLength(value);
  if (length === undefined) {
    return [];
  }
  const entries: PluginDependencyEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(value, index);
    if (!entry.ok) {
      continue;
    }
    const name = readRegistryStringField(entry.value, "name");
    const spec = readRegistryStringField(entry.value, "spec");
    if (!name || !spec) {
      continue;
    }
    const resolvedPath = readRegistryStringField(entry.value, "resolvedPath");
    entries.push({
      name,
      spec,
      installed: readRegistryBooleanField(entry.value, "installed") === true,
      optional: readRegistryBooleanField(entry.value, "optional") === true,
      ...(resolvedPath ? { resolvedPath } : {}),
    });
  }
  return entries;
}

function readPluginDependencyStatus(value: unknown): PluginDependencyStatus | undefined {
  const status = readRegistryRecordField(value, "dependencyStatus");
  if (!status.ok) {
    return undefined;
  }
  const dependenciesField = readRegistryRecordField(status.value, "dependencies");
  const optionalDependenciesField = readRegistryRecordField(status.value, "optionalDependencies");
  const dependencies = dependenciesField.ok
    ? readPluginDependencyEntries(dependenciesField.value)
    : [];
  const optionalDependencies = optionalDependenciesField.ok
    ? readPluginDependencyEntries(optionalDependenciesField.value)
    : [];
  const missing = readRegistryStringArrayField(status.value, "missing");
  const missingOptional = readRegistryStringArrayField(status.value, "missingOptional");
  return {
    hasDependencies:
      readRegistryBooleanField(status.value, "hasDependencies") ??
      (dependencies.length > 0 || optionalDependencies.length > 0),
    installed: readRegistryBooleanField(status.value, "installed") ?? missing.length === 0,
    requiredInstalled:
      readRegistryBooleanField(status.value, "requiredInstalled") ?? missing.length === 0,
    optionalInstalled:
      readRegistryBooleanField(status.value, "optionalInstalled") ?? missingOptional.length === 0,
    missing,
    missingOptional,
    dependencies,
    optionalDependencies,
  };
}

function normalizeInspectablePluginRecord(value: unknown): PluginRecord | undefined {
  const id = readRegistryStringField(value, "id");
  if (!id) {
    return undefined;
  }
  const enabled = readRegistryBooleanField(value, "enabled") === true;
  const status = readPluginStatus(value);
  const activationSource = readRegistryStringField(value, "activationSource");
  const failurePhase = readRegistryStringField(value, "failurePhase");
  const contracts = readPluginContracts(value);
  const configUiHints = readPluginJsonLikeObjectField(value, "configUiHints");
  const configJsonSchema = readPluginJsonLikeObjectField(value, "configJsonSchema");
  const dependencyStatus = readPluginDependencyStatus(value);
  return {
    id,
    name: readRegistryStringField(value, "name") ?? id,
    ...(readRegistryStringField(value, "version")
      ? { version: readRegistryStringField(value, "version") }
      : {}),
    ...(readRegistryStringField(value, "packageName")
      ? { packageName: readRegistryStringField(value, "packageName") }
      : {}),
    description: readRegistryStringField(value, "description") ?? "",
    ...(readPluginFormat(value) ? { format: readPluginFormat(value) } : {}),
    ...(readPluginBundleFormat(value) ? { bundleFormat: readPluginBundleFormat(value) } : {}),
    bundleCapabilities: readRegistryStringArrayField(value, "bundleCapabilities"),
    ...(readPluginKind(value) ? { kind: readPluginKind(value) } : {}),
    source: readRegistryStringField(value, "source") ?? "",
    ...(readRegistryStringField(value, "rootDir")
      ? { rootDir: readRegistryStringField(value, "rootDir") }
      : {}),
    origin: readPluginOrigin(value),
    ...(readRegistryStringField(value, "workspaceDir")
      ? { workspaceDir: readRegistryStringField(value, "workspaceDir") }
      : {}),
    trustedOfficialInstall: readRegistryBooleanField(value, "trustedOfficialInstall") === true,
    enabled,
    explicitlyEnabled: readRegistryBooleanField(value, "explicitlyEnabled"),
    activated: readRegistryBooleanField(value, "activated"),
    imported: readRegistryBooleanField(value, "imported"),
    compat: readRegistryStringArrayField(value, "compat") as PluginRecord["compat"],
    ...(activationSource
      ? { activationSource: activationSource as PluginRecord["activationSource"] }
      : {}),
    ...(readRegistryStringField(value, "activationReason")
      ? { activationReason: readRegistryStringField(value, "activationReason") }
      : {}),
    status,
    ...(readRegistryStringField(value, "error")
      ? { error: readRegistryStringField(value, "error") }
      : {}),
    ...(readPluginDateField(value, "failedAt")
      ? { failedAt: readPluginDateField(value, "failedAt") }
      : {}),
    ...(failurePhase === "validation" || failurePhase === "load" || failurePhase === "register"
      ? { failurePhase }
      : {}),
    toolNames: readRegistryStringArrayField(value, "toolNames"),
    hookNames: readRegistryStringArrayField(value, "hookNames"),
    channelIds: readRegistryStringArrayField(value, "channelIds"),
    cliBackendIds: readRegistryStringArrayField(value, "cliBackendIds"),
    providerIds: readRegistryStringArrayField(value, "providerIds"),
    syntheticAuthRefs: readRegistryStringArrayField(value, "syntheticAuthRefs"),
    embeddingProviderIds: readRegistryStringArrayField(value, "embeddingProviderIds"),
    speechProviderIds: readRegistryStringArrayField(value, "speechProviderIds"),
    realtimeTranscriptionProviderIds: readRegistryStringArrayField(
      value,
      "realtimeTranscriptionProviderIds",
    ),
    realtimeVoiceProviderIds: readRegistryStringArrayField(value, "realtimeVoiceProviderIds"),
    mediaUnderstandingProviderIds: readRegistryStringArrayField(
      value,
      "mediaUnderstandingProviderIds",
    ),
    transcriptSourceProviderIds: readRegistryStringArrayField(value, "transcriptSourceProviderIds"),
    imageGenerationProviderIds: readRegistryStringArrayField(value, "imageGenerationProviderIds"),
    videoGenerationProviderIds: readRegistryStringArrayField(value, "videoGenerationProviderIds"),
    musicGenerationProviderIds: readRegistryStringArrayField(value, "musicGenerationProviderIds"),
    webFetchProviderIds: readRegistryStringArrayField(value, "webFetchProviderIds"),
    webSearchProviderIds: readRegistryStringArrayField(value, "webSearchProviderIds"),
    migrationProviderIds: readRegistryStringArrayField(value, "migrationProviderIds"),
    contextEngineIds: readRegistryStringArrayField(value, "contextEngineIds"),
    memoryEmbeddingProviderIds: readRegistryStringArrayField(value, "memoryEmbeddingProviderIds"),
    agentHarnessIds: readRegistryStringArrayField(value, "agentHarnessIds"),
    cliCommands: readRegistryStringArrayField(value, "cliCommands"),
    services: readRegistryStringArrayField(value, "services"),
    gatewayDiscoveryServiceIds: readRegistryStringArrayField(value, "gatewayDiscoveryServiceIds"),
    commands: readRegistryStringArrayField(value, "commands"),
    httpRoutes: readRegistryNumberField(value, "httpRoutes") ?? 0,
    hookCount: readRegistryNumberField(value, "hookCount") ?? 0,
    configSchema: readRegistryBooleanField(value, "configSchema") === true,
    ...(configUiHints ? { configUiHints: configUiHints as PluginRecord["configUiHints"] } : {}),
    ...(configJsonSchema
      ? { configJsonSchema: configJsonSchema as PluginRecord["configJsonSchema"] }
      : {}),
    ...(contracts ? { contracts } : {}),
    memorySlotSelected: readRegistryBooleanField(value, "memorySlotSelected"),
    ...(dependencyStatus ? { dependencyStatus } : {}),
  };
}

function findInspectablePlugin(params: { entries: unknown; id: string }): PluginRecord | undefined {
  for (const plugin of listInspectablePlugins(params.entries)) {
    if (plugin && (plugin.id === params.id || plugin.name === params.id)) {
      return plugin;
    }
  }
  return undefined;
}

function listInspectablePlugins(entries: unknown): PluginRecord[] {
  const length = readRegistryArrayLength(entries);
  if (length === undefined) {
    return [];
  }
  const plugins: PluginRecord[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(entries, index);
    if (!entry.ok) {
      continue;
    }
    const plugin = normalizeInspectablePluginRecord(entry.value);
    if (plugin) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

function listInspectablePluginIds(entries: unknown): string[] {
  return listInspectablePlugins(entries).map((plugin) => plugin.id);
}

function listPluginOwnedTypedHooks(params: {
  entries: unknown;
  pluginId: string;
}): PluginInspectReport["typedHooks"] {
  const length = readRegistryArrayLength(params.entries);
  if (length === undefined) {
    return [];
  }
  const hooks: PluginInspectReport["typedHooks"] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.entries, index);
    if (!entry.ok || !registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      continue;
    }
    const name = readRegistryStringField(entry.value, "hookName");
    if (!name) {
      continue;
    }
    const priority = readRegistryNumberField(entry.value, "priority");
    hooks.push({
      name: name as PluginHookName,
      ...(priority !== undefined ? { priority } : {}),
    });
  }
  return hooks.toSorted((a, b) => a.name.localeCompare(b.name));
}

function listPluginOwnedCustomHooks(params: {
  entries: unknown;
  pluginId: string;
}): PluginInspectReport["customHooks"] {
  const length = readRegistryArrayLength(params.entries);
  if (length === undefined) {
    return [];
  }
  const hooks: PluginInspectReport["customHooks"] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.entries, index);
    if (!entry.ok || !registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      continue;
    }
    const hookEntry = readRegistryRecordField(entry.value, "entry");
    if (!hookEntry.ok) {
      continue;
    }
    const hook = readRegistryRecordField(hookEntry.value, "hook");
    if (!hook.ok) {
      continue;
    }
    const name = readRegistryStringField(hook.value, "name");
    if (!name) {
      continue;
    }
    const eventsField = readRegistryRecordField(entry.value, "events");
    const events = eventsField.ok ? readRegistryStringArray(eventsField.value) : undefined;
    if (!events) {
      continue;
    }
    hooks.push({
      name,
      events: events.toSorted(),
    });
  }
  return hooks.toSorted((a, b) => a.name.localeCompare(b.name));
}

function listPluginOwnedToolSummaries(params: {
  entries: unknown;
  pluginId: string;
}): PluginInspectReport["tools"] {
  const length = readRegistryArrayLength(params.entries);
  if (length === undefined) {
    return [];
  }
  const tools: PluginInspectReport["tools"] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.entries, index);
    if (!entry.ok || !registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      continue;
    }
    const namesField = readRegistryRecordField(entry.value, "names");
    const names = namesField.ok ? readRegistryStringArray(namesField.value) : undefined;
    if (!names) {
      continue;
    }
    tools.push({
      names,
      optional: readRegistryBooleanField(entry.value, "optional") === true,
    });
  }
  return tools;
}

function listPluginOwnedDiagnostics(params: {
  entries: unknown;
  pluginId: string;
}): PluginDiagnostic[] {
  const length = readRegistryArrayLength(params.entries);
  if (length === undefined) {
    return [];
  }
  const diagnostics: PluginDiagnostic[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.entries, index);
    if (!entry.ok || !registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      continue;
    }
    const level = readRegistryStringField(entry.value, "level");
    const message = readRegistryStringField(entry.value, "message");
    if ((level !== "warn" && level !== "error") || !message) {
      continue;
    }
    const source = readRegistryStringField(entry.value, "source");
    diagnostics.push({
      level,
      message,
      pluginId: params.pluginId,
      ...(source ? { source } : {}),
    });
  }
  return diagnostics;
}

function hasPluginOwnedMemoryEmbeddingProviderRegistration(params: {
  entries: unknown;
  pluginId: string;
}): boolean {
  const length = readRegistryArrayLength(params.entries);
  if (length === undefined) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const entry = readRegistryArrayElement(params.entries, index);
    if (entry.ok && registryEntryMatchesPluginId(entry.value, params.pluginId)) {
      return true;
    }
  }
  return false;
}

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const rawConfig = params?.config ?? getRuntimeConfig();
  const initialWorkspaceDir =
    params?.workspaceDir ??
    resolveAgentWorkspaceDir(rawConfig, resolveDefaultAgentId(rawConfig), params?.env);
  const metadataSnapshot = !loadModules
    ? loadPluginMetadataSnapshot({
        config: rawConfig,
        env: params?.env ?? process.env,
        workspaceDir: initialWorkspaceDir,
      })
    : undefined;
  const baseContext = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params?.env,
    logger: params?.logger,
    workspaceDir: initialWorkspaceDir,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
  const workspaceDir =
    baseContext.workspaceDir ?? initialWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const config = context.config;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // report the same loaded/disabled status the gateway uses at runtime.  Without
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    workspaceDir,
    env: params?.env,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config,
    pluginIds: bundledProviderIds,
  });
  const onlyPluginIds =
    params?.effectiveOnly === true
      ? resolveEffectivePluginIds({
          config: rawConfig,
          workspaceDir,
          env: params?.env ?? process.env,
        })
      : params?.onlyPluginIds === undefined
        ? undefined
        : [...params.onlyPluginIds];

  const registry = loadModules
    ? tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () =>
          loadOpenClawPlugins(
            buildPluginRuntimeLoadOptions(context, {
              config: runtimeCompatConfig,
              activationSourceConfig: rawConfig,
              workspaceDir,
              env: params?.env,
              loadModules,
              activate: false,
              cache: false,
              onlyPluginIds,
            }),
          ),
        { surface: "status", onlyPluginCount: onlyPluginIds?.length },
      )
    : tracePluginLifecyclePhase(
        "plugin registry snapshot",
        () =>
          loadPluginMetadataRegistrySnapshot({
            config: runtimeCompatConfig,
            activationSourceConfig: rawConfig,
            workspaceDir,
            env: params?.env,
            logger: params?.logger,
            loadModules: false,
            onlyPluginIds,
            manifestRegistry: metadataSnapshot?.manifestRegistry,
            runtimeContext: context,
          }),
        { surface: "status", onlyPluginCount: onlyPluginIds?.length },
      );
  const plugins = listInspectablePlugins(registry.plugins);
  const importedPluginIds = new Set([
    ...(loadModules
      ? plugins
          .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
          .map((plugin) => plugin.id)
      : []),
    ...listImportedRuntimePluginIds(),
    ...listImportedBundledPluginFacadeIds(),
  ]);

  return {
    workspaceDir,
    ...registry,
    plugins: plugins.map((plugin) =>
      Object.assign({}, plugin, {
        imported: plugin.format !== `bundle` && importedPluginIds.has(plugin.id),
        version: resolveReportedPluginVersion(plugin, params?.env),
        dependencyStatus:
          plugin.dependencyStatus ??
          buildPluginDependencyStatus({
            rootDir: plugin.rootDir,
            dependencies: metadataSnapshot?.byPluginId.get(plugin.id)?.packageDependencies,
            optionalDependencies: metadataSnapshot?.byPluginId.get(plugin.id)
              ?.packageOptionalDependencies,
          }),
      }),
    ),
  };
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

export function buildPluginInspectReport(params: {
  id: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
  resolvedConfig?: OpenClawConfig;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? getRuntimeConfig();
  const config =
    params.resolvedConfig ??
    resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env: params.env,
      logger: params.logger,
      workspaceDir: params.workspaceDir,
    }).config;
  const report =
    params.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      logger: params.logger,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const plugin = findInspectablePlugin({ entries: report.plugins, id: params.id });
  if (!plugin) {
    return null;
  }
  const pluginId = plugin.id;

  const typedHooks = listPluginOwnedTypedHooks({ entries: report.typedHooks, pluginId });
  const customHooks = listPluginOwnedCustomHooks({ entries: report.hooks, pluginId });
  const tools = listPluginOwnedToolSummaries({ entries: report.tools, pluginId });
  const diagnostics = listPluginOwnedDiagnostics({
    entries: report.diagnostics,
    pluginId,
  });
  const policyEntry = normalizePluginsConfig(config.plugins).entries[pluginId];
  const shapeSummary = buildPluginShapeSummary({ plugin, report });
  const shape = shapeSummary.shape;
  const gatewayMethods = listPluginOwnedGatewayMethodNames({
    descriptors: report.gatewayMethodDescriptors,
    pluginId,
  });

  // Populate MCP server info for bundle-format plugins with a known rootDir.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const mcpSupport = inspectBundleMcpRuntimeSupport({
      pluginId,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    mcpServers = [
      ...mcpSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...mcpSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  // Populate LSP server info for bundle-format plugins with a known rootDir.
  let lspServers: PluginInspectReport["lspServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const lspSupport = inspectBundleLspRuntimeSupport({
      pluginId,
      rootDir: plugin.rootDir,
      bundleFormat: plugin.bundleFormat,
    });
    lspServers = [
      ...lspSupport.supportedServerNames.map((name) => ({
        name,
        hasStdioTransport: true,
      })),
      ...lspSupport.unsupportedServerNames.map((name) => ({
        name,
        hasStdioTransport: false,
      })),
    ];
  }

  const usesLegacyBeforeAgentStart = shapeSummary.usesLegacyBeforeAgentStart;
  const hasRuntimeMemoryEmbeddingProviderRegistration =
    hasPluginOwnedMemoryEmbeddingProviderRegistration({
      entries: report.memoryEmbeddingProviders,
      pluginId,
    });
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
    hasRuntimeMemoryEmbeddingProviderRegistration,
  });
  return {
    workspaceDir: report.workspaceDir,
    plugin,
    shape,
    capabilityMode: shapeSummary.capabilityMode,
    capabilityCount: shapeSummary.capabilityCount,
    capabilities: shapeSummary.capabilities,
    typedHooks,
    customHooks,
    tools,
    commands: [...plugin.commands],
    cliCommands: [...plugin.cliCommands],
    services: [...plugin.services],
    gatewayDiscoveryServices: [...plugin.gatewayDiscoveryServiceIds],
    gatewayMethods,
    mcpServers,
    lspServers,
    httpRouteCount: plugin.httpRoutes,
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    diagnostics,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowConversationAccess: policyEntry?.hooks?.allowConversationAccess,
      hookTimeoutMs: policyEntry?.hooks?.timeoutMs,
      hookTimeouts: policyEntry?.hooks?.timeouts ? { ...policyEntry.hooks.timeouts } : undefined,
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    usesLegacyBeforeAgentStart,
    compatibility,
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const rawConfig = params?.config ?? getRuntimeConfig();
  const config = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params?.env,
    logger: params?.logger,
    workspaceDir: params?.workspaceDir,
  }).config;
  const report =
    params?.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      logger: params?.logger,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    });

  return listInspectablePluginIds(report.plugins)
    .map((id) =>
      buildPluginInspectReport({
        id,
        config: rawConfig,
        logger: params?.logger,
        workspaceDir: params?.workspaceDir,
        env: params?.env,
        resolvedConfig: config,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}

export function buildPluginCompatibilityWarnings(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  report?: PluginStatusReport;
}): PluginCompatibilityNotice[] {
  return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}

export function buildPluginCompatibilitySnapshotNotices(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginCompatibilityNotice[] {
  const report = buildPluginSnapshotReport(params);
  return buildPluginCompatibilityNotices({
    ...params,
    report,
  });
}

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
