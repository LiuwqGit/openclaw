import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createChannelPlugin(id: string): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: "Mock Plugin Chat",
      selectionLabel: "Mock Plugin Chat",
      docsPath: `/channels/${id}`,
      blurb: "mock plugin chat channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    outbound: { deliveryMode: "direct" },
  };
}

function createUnreadableChannelPluginId(message: string): ChannelPlugin {
  return Object.defineProperty(
    {
      meta: {
        id: "fuzzplugin-chat",
        label: "Fuzz Plugin Chat",
        selectionLabel: "Fuzz Plugin Chat",
        docsPath: "/channels/fuzzplugin-chat",
        blurb: "unreadable synthetic channel",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      outbound: { deliveryMode: "direct" },
    },
    "id",
    {
      get() {
        throw new Error(message);
      },
    },
  ) as ChannelPlugin;
}

describe("plugin registry channel registrations", () => {
  it("skips unreadable existing channel registrations during duplicate checks", () => {
    const pluginRegistry = createTestRegistry();
    const mockRecord = createPluginRecord({
      id: "mockplugin-channel-registration",
      name: "Mock Plugin Channel Registration",
      source: "/tmp/mockplugin-channel-registration/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registry.channels.push({
      pluginId: "fuzzplugin-runtime-channel",
      pluginName: "Fuzz Plugin Runtime Channel",
      plugin: createUnreadableChannelPluginId("fuzzplugin runtime channel id getter failed"),
      source: "/tmp/fuzzplugin-runtime-channel/index.js",
    });
    pluginRegistry.registry.channelSetups.push({
      pluginId: "fuzzplugin-setup-channel",
      pluginName: "Fuzz Plugin Setup Channel",
      plugin: createUnreadableChannelPluginId("fuzzplugin setup channel id getter failed"),
      source: "/tmp/fuzzplugin-setup-channel/index.js",
      enabled: true,
    });

    expect(() =>
      pluginRegistry.registerChannel(mockRecord, {
        plugin: createChannelPlugin("mockplugin-chat"),
      }),
    ).not.toThrow();

    expect(mockRecord.channelIds).toEqual(["mockplugin-chat"]);
    expect(pluginRegistry.registry.channels.at(-1)?.plugin.id).toBe("mockplugin-chat");
    expect(pluginRegistry.registry.channelSetups.at(-1)?.plugin.id).toBe("mockplugin-chat");
  });
});
