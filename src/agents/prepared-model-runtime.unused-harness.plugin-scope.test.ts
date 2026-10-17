import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { clearActivePluginRegistry, disposePluginRegistryInstances } from "../plugins/runtime.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

// Exercise the real agent-turn acquisition path: the scoped metadata snapshot decides
// which installed plugins the registry loader evaluates and captures. An installed
// harness plugin that no selection or configured runtime resolves to must stay out.
beforeEach(useNoBundledPlugins);
afterEach(async () => {
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

type TurnFixtures = {
  config: OpenClawConfig;
  providerDir: string;
};

function writeTurnFixtures(routeHarnessRuntime = false): TurnFixtures {
  const provider = writePlugin({
    id: "openai",
    registration: 'api.registerProvider({ id: "openai", label: "Fixture", auth: [] });',
  });
  writeFileSync(
    path.join(provider.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: "openai", providers: ["openai"], configSchema: { type: "object" } }),
  );
  const harness = writePlugin({
    id: "codex",
    registration: `api.registerAgentHarness({ id: "codex", label: "Fixture",
      supports: () => ({ supported: true }), runAttempt: async () => {} });`,
  });
  writeFileSync(
    path.join(harness.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "codex",
      activation: { onAgentHarnesses: ["codex"] },
      configSchema: { type: "object" },
    }),
  );
  const config: OpenClawConfig = {
    ...(routeHarnessRuntime
      ? {
          agents: {
            defaults: {
              models: { "openai/gpt-5": { agentRuntime: { id: "codex" } } },
            },
          },
        }
      : {}),
    plugins: {
      allow: [provider.id, harness.id],
      load: { paths: [provider.file, harness.file] },
      entries: { [provider.id]: { enabled: true }, [harness.id]: { enabled: true } },
    },
  };
  return { config, providerDir: provider.dir };
}

function loadedPluginIds(registry: PluginRegistry | undefined) {
  return (
    registry?.plugins
      .filter((record) => record.status === "loaded")
      .map((record) => record.id)
      .toSorted() ?? []
  );
}

async function acquireTurnRegistry(fixtures: TurnFixtures) {
  const input: PreparedModelRuntimeInput = {
    agentDir: fixtures.providerDir,
    config: fixtures.config,
    workspaceDir: fixtures.providerDir,
    loadRuntimePlugins: true,
    runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5" }],
  };
  const metadataSnapshot = prepareOwnedPluginLoadContext(input, process.env, undefined);
  const registries = await prepareWorkspacePluginRegistries(input, metadataSnapshot, () => {});
  return { metadataSnapshot, registries };
}

it("does not evaluate or capture an installed harness plugin no agent selects", async () => {
  const fixtures = writeTurnFixtures();
  const { metadataSnapshot, registries } = await acquireTurnRegistry(fixtures);
  expect(metadataSnapshot.pluginIds).toEqual(["openai"]);
  const { runtimePluginRegistry: registry } = registries;
  expect(loadedPluginIds(registry)).toEqual(["openai"]);
  if (registry) {
    await disposePluginRegistryInstances(registry);
  }
});

it("still prepares the harness plugin when the routed runtime selects it", async () => {
  const fixtures = writeTurnFixtures(true);
  const { metadataSnapshot, registries } = await acquireTurnRegistry(fixtures);
  expect(metadataSnapshot.pluginIds).toEqual(["codex", "openai"]);
  const { runtimePluginRegistry: registry } = registries;
  expect(loadedPluginIds(registry)).toEqual(["codex", "openai"]);
  if (registry) {
    await disposePluginRegistryInstances(registry);
  }
});
