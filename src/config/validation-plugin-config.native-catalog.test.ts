import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../plugins/manifest-registry.types.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { validateExplicitPluginConfig } from "./validation-plugin-config.js";

const roots = createTempDirTracker();
afterEach(() => {
  vi.unstubAllEnvs();
  roots.cleanup();
});

function collectPluginValidation({
  config,
  registry = { plugins: [], diagnostics: [] },
  knownIds = new Set<string>(),
}: {
  config: OpenClawConfig;
  registry?: PluginManifestRegistry;
  knownIds?: Set<string>;
}): { issues: ConfigValidationIssue[]; warnings: ConfigValidationIssue[] } {
  const home = roots.make("openclaw-catalog-preference-warnings-");
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", home);
  const warnings: ConfigValidationIssue[] = [];
  const issues: ConfigValidationIssue[] = [];
  validateExplicitPluginConfig({
    raw: config,
    config,
    env: { HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: home },
    applyDefaults: false,
    registry,
    knownIds,
    normalizedPlugins: normalizePluginsConfig(config.plugins),
    ensureCompatPluginIds: () => new Set(),
    ensureOverriddenPluginIds: () => new Set(),
    replacePluginEntryConfig: () => {
      throw new Error("An absent plugin cannot replace config through its schema");
    },
    issues,
    warnings,
  });
  return { issues, warnings };
}

function missingPluginWarningPaths(config: OpenClawConfig): string[] {
  const { issues, warnings } = collectPluginValidation({ config });
  expect(issues).toEqual([]);
  return warnings.map(({ path }) => path);
}

function bundledRecord(id: string, enabledByDefault: boolean): PluginManifestRecord {
  return {
    id,
    channels: [],
    cliBackends: [],
    enabledByDefault,
    format: "bundle",
    hooks: [],
    manifestPath: `/bundled/${id}/openclaw.plugin.json`,
    origin: "bundled",
    providers: [],
    rootDir: `/bundled/${id}`,
    skills: [],
    source: `/bundled/${id}/index.js`,
  };
}

describe("native catalog preferences without installed plugins", () => {
  it("does not diagnose first-write privacy defaults as missing plugins", () => {
    const config = initializeNativeSessionCatalogPreferences({});
    expect(missingPluginWarningPaths(config)).toEqual([]);
  });

  const explicitUsageCases: Array<{
    name: string;
    config: OpenClawConfig;
    warningPath: string;
  }> = [
    {
      name: "explicit enablement",
      config: { plugins: { entries: { anthropic: { enabled: true } } } },
      warningPath: "plugins.entries.anthropic",
    },
    {
      name: "independent allowlist selection",
      config: { plugins: { allow: ["anthropic"] } },
      warningPath: "plugins.allow",
    },
    {
      name: "additional authored plugin configuration",
      config: {
        plugins: { entries: { anthropic: { config: { additionalSetting: "authored" } } } },
      },
      warningPath: "plugins.entries.anthropic",
    },
    {
      name: "an undeclared plugin with the same setting shape",
      config: {
        plugins: {
          entries: { "external-fixture": { config: { sessionCatalog: { enabled: false } } } },
        },
      },
      warningPath: "plugins.entries.external-fixture",
    },
  ];
  it.each(explicitUsageCases)(
    "retains missing-plugin warnings for $name",
    ({ config, warningPath }) => {
      const initialized = initializeNativeSessionCatalogPreferences(config);
      expect(missingPluginWarningPaths(initialized)).toEqual([warningPath]);
    },
  );
});

// The shipped catalogs differ only in default enablement: anthropic is enabled by
// default, codex is bundled and disabled by default. Both receive the same
// first-write opt-out seed, so only codex can reach the disabled-config warning.
const shippedCatalogRegistry: PluginManifestRegistry = {
  diagnostics: [],
  plugins: [bundledRecord("anthropic", true), bundledRecord("codex", false)],
};
const shippedCatalogKnownIds = new Set(["anthropic", "codex"]);

describe("native catalog preferences for a bundled but disabled plugin", () => {
  it("does not report the first-write opt-out as ineffective config", () => {
    const config = initializeNativeSessionCatalogPreferences({});
    const { issues, warnings } = collectPluginValidation({
      config,
      registry: shippedCatalogRegistry,
      knownIds: shippedCatalogKnownIds,
    });
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("retains the ineffective-config warning for authored codex settings", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          codex: {
            config: {
              sessionCatalog: { enabled: false },
              codexDynamicToolsLoading: "direct",
            },
          },
        },
      },
    };
    const { issues, warnings } = collectPluginValidation({
      config,
      registry: shippedCatalogRegistry,
      knownIds: shippedCatalogKnownIds,
    });
    expect(issues).toEqual([]);
    expect(warnings.map(({ path }) => path)).toEqual(["plugins.entries.codex"]);
  });
});
