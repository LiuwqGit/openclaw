// Covers Bedrock AWS SDK auth markers and marker-backed discovery secret guardrails.
import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  resolveApiKeyFromCredential,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";

/**
 * Regression tests for #49891 / #50699 / #54274:
 *
 * When the Bedrock provider uses `auth: "aws-sdk"` and no AWS environment
 * variables are set (e.g. EC2 instance role, ECS task role), the
 * normalisation step must NOT inject a fake `apiKey: "AWS_PROFILE"` marker.
 * Doing so poisons the downstream auth resolver and causes
 * "No API key found for amazon-bedrock" errors.
 */
describe("resolveMissingProviderApiKey — aws-sdk auth", () => {
  const baseProvider: ProviderConfig = {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models: [
      {
        id: "anthropic.claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        input: ["text"],
        reasoning: false,
        cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };

  const emptyEnv: NodeJS.ProcessEnv = {};

  it("does NOT inject apiKey when no AWS env vars are set (instance role)", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
    });

    // Provider stays unchanged; instance-role auth must not become a fake apiKey marker.
    expect(result).toBe(baseProvider);
    expect(result.apiKey).toBeUndefined();
  });

  it("does NOT inject apiKey via providerApiKeyResolver when it returns undefined", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
      providerApiKeyResolver: () => undefined,
    });

    expect(result).toBe(baseProvider);
    expect(result.apiKey).toBeUndefined();
  });

  it("injects apiKey marker when AWS_ACCESS_KEY_ID + SECRET are present", () => {
    const envWithKeys: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", // pragma: allowlist secret
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithKeys,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_ACCESS_KEY_ID");
  });

  it("injects apiKey marker when AWS_PROFILE is set", () => {
    const envWithProfile: NodeJS.ProcessEnv = {
      AWS_PROFILE: "my-profile",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithProfile,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_PROFILE");
  });

  it("injects apiKey marker when AWS_BEARER_TOKEN_BEDROCK is set", () => {
    const envWithBearer: NodeJS.ProcessEnv = {
      AWS_BEARER_TOKEN_BEDROCK: "some-bearer-token",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: envWithBearer,
      profileApiKey: undefined,
    });

    expect(result.apiKey).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("skips injection when provider already has apiKey configured", () => {
    const providerWithKey: ProviderConfig = {
      ...baseProvider,
      apiKey: "existing-key",
    };

    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: providerWithKey,
      env: emptyEnv,
      profileApiKey: undefined,
    });

    // Existing apiKey config wins over inferred AWS environment markers.
    expect(result).toBe(providerWithKey);
    expect(result.apiKey).toBe("existing-key");
  });

  it("uses providerApiKeyResolver result when it returns a value", () => {
    const result = resolveMissingProviderApiKey({
      providerKey: "amazon-bedrock",
      provider: baseProvider,
      env: emptyEnv,
      profileApiKey: undefined,
      providerApiKeyResolver: () => "AWS_ACCESS_KEY_ID",
    });

    expect(result.apiKey).toBe("AWS_ACCESS_KEY_ID");
  });
});

describe("provider discovery auth marker guardrails", () => {
  it("suppresses discovery secrets for marker-backed vLLM credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      keyRef: { source: "file", provider: "vault", id: "/vllm/apiKey" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("suppresses discovery secrets for marker-backed Hugging Face credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "huggingface",
      keyRef: { source: "exec", provider: "vault", id: "providers/hf/token" },
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("keeps all-caps plaintext API keys for authenticated discovery", () => {
    const resolved = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "vllm",
      key: "ALLCAPS_SAMPLE",
    });

    expect(resolved?.apiKey).toBe("ALLCAPS_SAMPLE");
    expect(resolved?.discoveryApiKey).toBe("ALLCAPS_SAMPLE");
  });
});

describe("normalizeConfiguredProviderApiKey — env SecretRef persistence", () => {
  const baseProvider: ProviderConfig = {
    baseUrl: "https://factchat.example.com/v1",
    api: "openai-completions",
    apiKey: "${FACTCHAT_API_KEY}",
    models: [
      {
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 32000,
      },
    ],
  };

  it("persists env SecretRefs as bare env-var name markers for models.json (#121543)", () => {
    const secretRefManagedProviders = new Set<string>();

    const result = normalizeConfiguredProviderApiKey({
      providerKey: "custom-factchat",
      provider: baseProvider,
      secretDefaults: undefined,
      profileApiKey: undefined,
      secretRefManagedProviders,
    });

    // The bare env-var name is the persisted marker form: secrets audit and the
    // runtime resolver recognize it as an env reference, never as a literal key.
    expect(result.apiKey).toBe("FACTCHAT_API_KEY");
    expect(secretRefManagedProviders.has("custom-factchat")).toBe(true);
  });

  it("records non-env SecretRefs as managed providers with the non-env marker", () => {
    const secretRefManagedProviders = new Set<string>();

    const result = normalizeConfiguredProviderApiKey({
      providerKey: "custom-vault",
      provider: {
        ...baseProvider,
        apiKey: { source: "file", provider: "vault", id: "/factchat/apiKey" },
      },
      secretDefaults: undefined,
      profileApiKey: undefined,
      secretRefManagedProviders,
    });

    expect(result.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(secretRefManagedProviders.has("custom-vault")).toBe(true);
  });
});
