import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

/** Local Ollama keeps a credential marker instead of a key, so readiness stays unknown. */
const localOllamaConfig = {
  models: {
    providers: {
      ollama: { baseUrl: "http://127.0.0.1:11434", apiKey: "ollama-local" },
    },
  },
} satisfies OpenClawConfig;

it("keeps unknown readiness unpublished instead of asserting unavailability", async () => {
  const result = await listModels({
    cfg: localOllamaConfig,
    catalog: [providerCatalogEntry("ollama", "glm-5.3:cloud")],
    catalogComplete: true,
  });

  const model = result.models.find((row) => row.provider === "ollama");
  expect(model).toBeDefined();
  expect(model).not.toHaveProperty("available");
  expect(model?.unavailableReason).toBeUndefined();
});

it("still reports a determinate missing-auth verdict as unavailable", async () => {
  const result = await listModels({
    catalog: [providerCatalogEntry("ollama", "glm-5.3:cloud")],
    catalogComplete: true,
  });

  const model = result.models.find((row) => row.provider === "ollama");
  expect(model).toMatchObject({ available: false, unavailableReason: "missing-auth" });
});
