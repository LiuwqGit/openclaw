// Runner entry policy tests cover resolveImageCompressionPolicyFromConfig merge
// precedence between agents.defaults, configured model metadata, and the bundled
// static catalog. Catalog lookup is mocked for determinism so the merge contract
// is proved without coupling to shipped catalog contents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

const { resolveBundledStaticCatalogModelMock } = vi.hoisted(() => ({
  resolveBundledStaticCatalogModelMock: vi.fn(),
}));

vi.mock("../agents/embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: resolveBundledStaticCatalogModelMock,
}));

import { resolveImageCompressionPolicyFromConfig } from "./runner.entries.js";

function makeCfg(overrides: unknown): OpenClawConfig {
  return overrides as OpenClawConfig;
}

beforeEach(() => {
  resolveBundledStaticCatalogModelMock.mockReset();
  resolveBundledStaticCatalogModelMock.mockReturnValue(undefined);
});

describe("media-understanding resolveImageCompressionPolicyFromConfig", () => {
  it("returns quality-only policy without imageMaxDimensionPx or provider/model", () => {
    const cfg = makeCfg({ agents: { defaults: { imageQuality: "high" } } });
    expect(resolveImageCompressionPolicyFromConfig(cfg)).toEqual({ quality: "high" });
  });

  it("emits agents.defaults.imageMaxDimensionPx as a preferredSidePx entry", () => {
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced", imageMaxDimensionPx: 1024 } },
    });
    expect(resolveImageCompressionPolicyFromConfig(cfg)).toEqual({
      quality: "balanced",
      models: [{ preferredSidePx: 1024 }],
    });
  });

  it("skips model merge when only provider is given (no model id)", () => {
    const cfg = makeCfg({
      models: {
        providers: {
          anthropic: {
            models: [{ id: "claude-sonnet-5", mediaInput: { image: { maxSidePx: 1234 } } }],
          },
        },
      },
    });
    expect(resolveImageCompressionPolicyFromConfig(cfg, { provider: "anthropic" })).toEqual({
      quality: undefined,
    });
  });

  it("skips model merge when only model is given (no provider)", () => {
    const cfg = makeCfg({
      models: {
        providers: {
          anthropic: {
            models: [{ id: "claude-sonnet-5", mediaInput: { image: { maxSidePx: 1234 } } }],
          },
        },
      },
    });
    expect(resolveImageCompressionPolicyFromConfig(cfg, { model: "claude-sonnet-5" })).toEqual({
      quality: undefined,
    });
  });

  it("uses configured model mediaInput.image when catalog has no entry", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue(undefined);
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced" } },
      models: {
        providers: {
          "my-vendor": {
            models: [
              {
                id: "vision-9000",
                mediaInput: { image: { maxSidePx: 4096, maxBytes: 5_000_000 } },
              },
            ],
          },
        },
      },
    });
    const policy = resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "my-vendor",
      model: "vision-9000",
    });
    expect(policy.models).toContainEqual({ maxSidePx: 4096, maxBytes: 5_000_000 });
  });

  it("configured limits override catalog limits; catalog fills missing fields", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue({
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, maxPixels: 1_000_000 },
      },
    });
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced", imageMaxDimensionPx: 1024 } },
      models: {
        providers: {
          anthropic: {
            models: [
              {
                id: "claude-sonnet-5",
                mediaInput: { image: { maxBytes: 8_000_000 } },
              },
            ],
          },
        },
      },
    });
    const policy = resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    // Two model entries: [defaults preferredSidePx] then merged configured+catalog.
    expect(policy.models).toEqual([
      { preferredSidePx: 1024 },
      {
        maxSidePx: 2576,
        preferredSidePx: 2576,
        maxPixels: 1_000_000,
        maxBytes: 8_000_000,
      },
    ]);
  });

  it("string model entries match by id but yield no object metadata and no models entry", () => {
    resolveBundledStaticCatalogModelMock.mockReturnValue(undefined);
    const cfg = makeCfg({
      agents: { defaults: { imageQuality: "balanced" } },
      models: { providers: { anthropic: { models: ["claude-sonnet-5"] } } },
    });
    const policy = resolveImageCompressionPolicyFromConfig(cfg, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(policy).toEqual({ quality: "balanced" });
  });
});