// Document attachment downloads must stay visible at rest on hover-capable
// pointers, while media downloads keep deferring to hover.
import { render } from "lit";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../../test-helpers/control-ui-e2e.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeDownloadVisibility = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

// Renders the real card through the production Lit renderer, then measures
// the painted download control inside a hover-capable browser.
async function restDownloadState(
  options: Parameters<typeof renderCompactAttachmentCard>[0],
): Promise<{ opacity: string; pointerEvents: string }> {
  const host = document.createElement("div");
  render(renderCompactAttachmentCard(options), host);
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
      <html>
        <head><style>${readStyleSheet("ui/src/styles/chat/message-layout.css")}</style></head>
        <body><div class="chat-group-messages">${host.innerHTML}</div></body>
      </html>`);
    return await page.evaluate(() => {
      const download = document.querySelector<HTMLElement>(
        ".chat-assistant-attachment-card__download",
      )!;
      const style = getComputedStyle(download);
      return { opacity: style.opacity, pointerEvents: style.pointerEvents };
    });
  } finally {
    await page.close().catch(() => {});
  }
}

describeDownloadVisibility("attachment download visibility", () => {
  it("keeps a document download visible and clickable without hovering", async () => {
    expect(
      await restDownloadState({
        kind: "document",
        label: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 1_572_864,
        downloadHref: "/api/chat/media/outgoing/agent%3Amain%3Amain/bundle.zip",
        onExpand: () => {},
      }),
    ).toEqual({ opacity: "1", pointerEvents: "auto" });
  });

  it("keeps media downloads hover-only when an expand action exists", async () => {
    expect(
      await restDownloadState({
        kind: "audio",
        label: "clip.mp3",
        mimeType: "audio/mpeg",
        downloadHref: "/api/chat/media/outgoing/agent%3Amain%3Amain/clip.mp3",
        onExpand: () => {},
      }),
    ).toEqual({ opacity: "0", pointerEvents: "none" });
  });
});
