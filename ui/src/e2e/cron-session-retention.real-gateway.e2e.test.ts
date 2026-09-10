// Real-Gateway Control UI proof: the Automations Session Retention setting
// (zod union([string(), literal(false)])) edits, saves, and reloads through
// the built Gateway instead of falling back to Raw mode.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI automations session retention with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "cron-session-retention",
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

const requireRecord = createRequireRecord("record", "expected-object-value");

function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

async function revealAdvancedSettings(page: Page): Promise<void> {
  const disclosure = page
    .locator("details.config-advanced-disclosure")
    .filter({ hasText: "Advanced settings" })
    .first();
  await disclosure.waitFor({ state: "visible" });
  if ((await disclosure.getAttribute("open")) === null) {
    await disclosure.locator("summary").click();
  }
  await expect.poll(() => disclosure.getAttribute("open")).not.toBe(null);
}

suite.define(() => {
  it("edits, saves, and reloads the Automations Session Retention union through a real Gateway", async () => {
    const owner = instance;
    if (!owner) {
      throw new Error("Gateway fixture was not started");
    }
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = requireRecord(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const observations: Record<string, unknown>[] = [];
    const redact = (text: string) => text.replaceAll(owner.gatewayToken, "[synthetic token]");
    const readRetention = async (): Promise<unknown> => {
      const result = await owner.cli([
        "--no-color",
        "config",
        "get",
        "cron.sessionRetention",
        "--json",
      ]);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const openRetentionRow = async (page: Page) => {
      await revealAdvancedSettings(page);
      const row = settingsRow(page, "Automations Session Retention");
      await row.waitFor({ state: "visible" });
      const rowText = await row.textContent();
      expect(rowText).not.toContain("Unsupported schema node");
      expect(rowText).not.toContain("Use Raw mode");
      return row.locator("input.settings-input[type='text']");
    };
    try {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          const url = new URL("settings/automation?section=cron", browserUrl);
          url.hash = new URL(browserUrl).hash;
          await page.goto(url.toString());
          await waitForControlUiGatewayReady(page);

          // Before any edit, the retention row renders a text input, not a
          // Raw-mode placeholder.
          const input = await openRetentionRow(page);
          await expect.poll(() => input.inputValue()).toBe("");

          // Save a duration string through the union's string branch.
          await input.fill("7d");
          await input.blur();
          await expect.poll(readRetention).toBe("7d");
          await expect
            .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
            .toContain("Saved");
          observations.push({ step: "saved-duration", config: "7d" });

          // Save the literal false sentinel through the same text input.
          await input.fill("false");
          await input.blur();
          await expect.poll(readRetention).toBe(false);
          observations.push({ step: "saved-literal-false", config: false });

          // Reload: the saved sentinel and the editable control survive a
          // fresh page load served by the same Gateway.
          await page.reload();
          await waitForControlUiGatewayReady(page);
          const reloadedInput = await openRetentionRow(page);
          await expect.poll(() => reloadedInput.inputValue()).toBe("false");
          observations.push({ step: "reloaded-editor", input: "false" });
        },
      );
    } finally {
      await fs.writeFile(
        path.join(suite.artifactDir, "session-retention-observations.json"),
        redact(JSON.stringify(observations, null, 2)),
      );
      await fs.writeFile(path.join(suite.artifactDir, "gateway.log"), redact(owner.logs()));
    }
  }, 120_000);
});
