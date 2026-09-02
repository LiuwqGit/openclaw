import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { asOptionalObjectRecord as readLegacyObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type MemoryFtsTokenizer = "unicode61" | "trigram";

export function resolveConfiguredAgentIds(config: unknown): string[] {
  const agents = readLegacyObjectRecord(readLegacyObjectRecord(config)?.agents);
  const entries = readLegacyObjectRecord(agents?.entries);
  const listedIds = Array.isArray(agents?.list)
    ? agents.list.flatMap((entry) => {
        const id = readLegacyObjectRecord(entry)?.id;
        return typeof id === "string" ? [id] : [];
      })
    : [];
  const ids = new Set([...Object.keys(entries ?? {}), ...listedIds].map(normalizeAgentId));
  return ids.size > 0 ? [...ids] : [normalizeAgentId(undefined)];
}

function readAgentMemorySearch(
  config: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = readLegacyObjectRecord(readLegacyObjectRecord(config)?.agents);
  const keyedEntries = readLegacyObjectRecord(agents?.entries);
  const keyedEntry = keyedEntries
    ? Object.entries(keyedEntries).find(([id]) => normalizeAgentId(id) === agentId)?.[1]
    : undefined;
  const keyedSearch = readLegacyObjectRecord(
    readLegacyObjectRecord(readLegacyObjectRecord(keyedEntry)?.memory)?.search,
  );
  if (keyedSearch) {
    return keyedSearch;
  }
  const entries = Array.isArray(agents?.list) ? agents.list : [];
  const entry = entries
    .map(readLegacyObjectRecord)
    .find(
      (candidate) =>
        normalizeAgentId(typeof candidate?.id === "string" ? candidate.id : undefined) === agentId,
    );
  return readLegacyObjectRecord(readLegacyObjectRecord(entry?.memory)?.search);
}

function readMemorySearchLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  const cfg = readLegacyObjectRecord(config);
  return [
    readAgentMemorySearch(config, agentId),
    readLegacyObjectRecord(readLegacyObjectRecord(cfg?.memory)?.search),
    // Doctor still inspects the retired root shape to migrate its persisted sidecar path.
    readLegacyObjectRecord(cfg?.memorySearch),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function readStoreLayers(config: unknown, agentId: string): Record<string, unknown>[] {
  return readMemorySearchLayers(config, agentId).flatMap((search) => {
    const store = readLegacyObjectRecord(search.store);
    return store ? [store] : [];
  });
}

function firstDefined(layers: Record<string, unknown>[], key: string): unknown {
  return layers.find((layer) => layer[key] !== undefined)?.[key];
}

function readNestedStoreLayers(
  config: unknown,
  agentId: string,
  key: string,
): Record<string, unknown>[] {
  return readStoreLayers(config, agentId).flatMap((store) => {
    const nested = readLegacyObjectRecord(store[key]);
    return nested ? [nested] : [];
  });
}

export function readMemorySearchVectorExtensionPath(
  config: unknown,
  agentId: string,
): string | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "extensionPath");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function readMemorySearchVectorEnabled(config: unknown, agentId: string): boolean {
  if (readMemorySearchProvider(config, agentId) === "none") {
    return false;
  }
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "vector"), "enabled");
  return typeof raw === "boolean" ? raw : true;
}

function readMemorySearchProvider(config: unknown, agentId: string): string | undefined {
  const raw = firstDefined(readMemorySearchLayers(config, agentId), "provider");
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function readLegacyMemorySearchStorePaths(config: unknown, agentId: string): string[] {
  return [
    ...new Set(
      readStoreLayers(config, agentId).flatMap((store) =>
        typeof store.path === "string" && store.path.trim() ? [store.path.trim()] : [],
      ),
    ),
  ];
}

export function readMemorySearchFtsTokenizer(
  config: unknown,
  agentId: string,
): MemoryFtsTokenizer | undefined {
  const raw = firstDefined(readNestedStoreLayers(config, agentId, "fts"), "tokenizer");
  return raw === "unicode61" || raw === "trigram" ? raw : undefined;
}
