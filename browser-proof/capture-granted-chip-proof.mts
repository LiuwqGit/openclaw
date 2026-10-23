#!/usr/bin/env node
// Standalone browser-proof capture for openclaw PR #181240.
// Drives the BUILT (shipped) Control UI bundle in Chromium with a mock gateway
// session whose dashboard board contains a granted widget declaring
// netOrigins ["https://api.example.com"] and tools ["health"], then walks the
// real Tab order from the document start and captures:
//   after:  Tab reaching the Granted chip, visible focus indicator, tooltip
//           open with the permission list, Escape dismissal, onward Tab.
//   before: the same walk on the unpatched build — the chip never receives focus.
// Usage: node --import <worktree>/scripts/tsx.mjs capture-granted-chip-proof.mts \
//          --label after --outDir <screenshots-dir> --baseUrl <built-ui-base-url>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const WORKTREE = "/home/0668000710/code/PR/aispace/worktrees/issue-181210";

const requireFromHelper = createRequire(
  path.join(WORKTREE, "ui/src/test-helpers/control-ui-e2e.ts"),
);
const { chromium } = requireFromHelper("playwright");

const { controlUiSessionUrl, installMockGateway } = await import(
  path.join(WORKTREE, "ui/src/test-helpers/control-ui-e2e.ts")
);
const { buildWidgetDocument } = await import(path.join(WORKTREE, "src/canvas/wrap.ts"));
const { resolvePlaywrightChromiumExecutablePath } = await import(
  path.join(WORKTREE, "ui/src/test-helpers/playwright-chromium.ts")
);

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const label = flag("label") ?? "run";
const outDir = flag("outDir");
const distDir = flag("distDir");
if (!outDir || !distDir) {
  console.error("Usage: --label <before|after> --outDir <dir> --distDir <built-ui>");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const shot = (name: string) => path.join(outDir, name);

const { startBundledControlUiE2eServer } = await import(
  path.join(WORKTREE, "ui/src/test-helpers/control-ui-e2e.ts")
);
// Same provisioning as CI/vitest (vitest.ui-e2e.bundled.global-setup.ts): the
// shipped bundle is built with the OPENCLAW_CONTROL_UI_BUILD_INFO define and
// served through vite preview.
const server = await startBundledControlUiE2eServer(distDir);
const baseUrl = server.baseUrl;
console.log(`[proof] built UI served at ${baseUrl}`);

const sessionKey = "agent:main:dashboard:42d71fe0-1234-4567-8901-234567890abc";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
console.log(`[proof] chromium: ${executablePath}`);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
// tsx (esbuild keepNames) instruments evaluate callbacks with __name helpers
// that are absent in page context; register the identity polyfill first so every
// serialized callback (ours and the e2e helpers') can execute in the page.
await page.addInitScript(
  "window.__name = window.__name || ((target) => target);" +
    "window.__async = window.__async || ((self, args, generator) => new Promise((resolve, reject) => {" +
    "  const fulfilled = (value) => { try { step(generator.next(value)); } catch (e) { reject(e); } };" +
    "  const rejected = (value) => { try { step(generator.throw(value)); } catch (e) { reject(e); } };" +
    "  const step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);" +
    "  step((generator = generator.apply(self, args)).next());" +
    "}));",
);

async function activeElementInfo() {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: "body", testId: null, text: "" };
    return {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute("data-test-id"),
      role: el.getAttribute("role"),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
      label: el.getAttribute("aria-label"),
    };
  });
}

async function tooltipState() {
  // Tooltip surfaces live inside the openclaw-tooltip shadow root; Playwright
  // locators pierce shadow DOM, unlike document.querySelectorAll.
  const surfaces = page.locator(".tooltip-surface");
  const count = await surfaces.count();
  const result: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const surface = surfaces.nth(i);
    result.push({
      phase: await surface.getAttribute("data-phase"),
      text: (await surface.textContent())?.trim().replace(/\s+/g, " ").slice(0, 200),
    });
  }
  return result;
}

async function waitForTooltipOpen(timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await tooltipState();
    if (state.some((entry) => (entry as { phase?: string }).phase === "open")) {
      return true;
    }
    await page.waitForTimeout(150);
  }
  return false;
}

const { selectChatLayoutAction } = await import(
  path.join(WORKTREE, "ui/src/test-helpers/chat-layout-menu.ts")
);

const log: unknown[] = [];

try {
  // 1. Mock gateway + granted dashboard widget (mirrors ui/src/e2e/solo-widget-chrome.e2e.test.ts)
  const frameUrl = new URL("__widget/granted-proof", baseUrl).href;
  await page.route(frameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: buildWidgetDocument(
        "Release status",
        `<style>body{margin:0;background:#102820;color:#ecfff4;font:16px system-ui;min-height:420px}main{padding:36px}h1{font-size:40px;margin:12px 0}</style><main><p>RELEASE OVERVIEW</p><h1>Granted widget used for keyboard proof.</h1><p>Static content; the chip in the widget header lists this widget's granted network origin and host tool.</p></main>`,
      ),
    }),
  );
  const board = {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Overview", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "release-status",
        tabId: "main",
        title: "Release status",
        contentKind: "html",
        sizeW: 6,
        sizeH: 6,
        position: 0,
        grantState: "granted",
        revision: 1,
        declared: { tools: ["health"], netOrigins: ["https://api.example.com"] },
        frameUrl,
      },
    ],
  };
  const gateway = await installMockGateway(page, {
    sessionKey,
    agentModel: "gpt-4.1",
    sessions: [
      {
        key: sessionKey,
        agentId: "main",
        sessionId: "granted-proof-session",
        kind: "direct",
        displayName: "Release overview",
        boardFace: "dashboard",
        boardPresentation: "expanded",
        updatedAt: 1,
        model: "gpt-4.1",
        modelProvider: "openai",
      },
    ],
    operatorScopes: ["operator.read", "operator.write", "operator.approvals"],
    featureMethods: [
      "board.get",
      "board.update",
      "board.widget.grant",
      "chat.metadata",
      "chat.startup",
    ],
    methodResponses: { "board.get": board },
  });
  await page.goto(controlUiSessionUrl(baseUrl, sessionKey, "dashboard"));
  await gateway.waitForRequest("board.get");
  await page.locator(".board-session-surface").waitFor();
  if (await page.locator(".agent-chat__header--mobile").isVisible()) {
    await page.locator('.chat-mobile-host[data-mode="dock"]').waitFor();
    await selectChatLayoutAction(page, "Focus");
    await page.locator('.chat-mobile-host[data-mode="expanded"]').waitFor();
  }
  await page.getByRole("button", { name: "Dashboard options", exact: true }).waitFor();
  // The widget chrome (bar hosting the Granted chip) is visibility:hidden until
  // the widget has focus/hover; presence in the DOM is the render guarantee.
  await page.locator('[data-test-id="board-capabilities-granted"]').waitFor({
    state: "attached",
  });
  console.log("[proof] dashboard rendered with granted widget");

  // 2. Static facts about the chip on this build
  const chipFacts = await page.evaluate(() => {
    const chip = document.querySelector('[data-test-id="board-capabilities-granted"]');
    if (!chip) return null;
    return {
      tag: chip.tagName.toLowerCase(),
      tabindex: chip.getAttribute("tabindex"),
      ariaLabel: chip.getAttribute("aria-label"),
    };
  });
  log.push({ step: "chip-facts", chipFacts });
  console.log(`[proof] chip facts: ${JSON.stringify(chipFacts)}`);

  await page.screenshot({ path: shot(`${label}-01-board-loaded.png`) });

  // 3. Genuine Tab walk from the document start
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
  });
  const sequence: unknown[] = [];
  let chipReachedAt: number | null = null;
  const MAX_TABS = 150;
  for (let i = 1; i <= MAX_TABS; i++) {
    await page.keyboard.press("Tab");
    const info = await activeElementInfo();
    sequence.push({ tab: i, ...info });
    if (info.testId === "board-capabilities-granted") {
      chipReachedAt = i;
      break;
    }
    if (info.tag === "body") continue;
  }
  log.push({ step: "tab-walk", chipReachedAt, sequence });
  console.log(`[proof] chip reached at tab #${chipReachedAt ?? "never (full walk done)"}`);

  if (chipReachedAt === null) {
    // Fallback: focus the widget cell, then Tab into its header (still real
    // sequential navigation, just scoped so the capture cannot run unbounded).
    await page.evaluate(() => {
      const cell = document.querySelector('[data-test-id="board-widget"]');
      (cell as HTMLElement | null)?.focus?.();
    });
    for (let i = 1; i <= 10; i++) {
      await page.keyboard.press("Tab");
      const info = await activeElementInfo();
      sequence.push({ tab: `cell+${i}`, ...info });
      if (info.testId === "board-capabilities-granted") {
        chipReachedAt = -i; // negative marks the scoped fallback
        break;
      }
    }
    console.log(`[proof] scoped fallback chip reached: ${chipReachedAt}`);
  }

  if (chipReachedAt !== null) {
    // 4. Focus indicator + tooltip visible while the chip has keyboard focus
    await page.waitForTimeout(600);
    const tooltipOpened = await waitForTooltipOpen();
    const focusFacts = await page.evaluate(() => {
      const chip = document.querySelector(
        '[data-test-id="board-capabilities-granted"]',
      ) as HTMLElement | null;
      if (!chip) return null;
      const cs = getComputedStyle(chip);
      const rect = chip.getBoundingClientRect();
      return {
        isDocumentActiveElement: document.activeElement === chip,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        boxShadow: cs.boxShadow,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    });
    const tooltipsWhileFocused = await tooltipState();
    log.push({ step: "chip-focused", tooltipOpened, focusFacts, tooltipsWhileFocused });
    console.log(`[proof] tooltip opened on chip focus: ${tooltipOpened}`);
    console.log(`[proof] focus facts: ${JSON.stringify(focusFacts)}`);
    console.log(`[proof] tooltips while focused: ${JSON.stringify(tooltipsWhileFocused)}`);
    await page.screenshot({ path: shot(`${label}-02-focus-on-chip-tooltip-open.png`) });

    // 5. Escape dismisses the tooltip
    await page.keyboard.press("Escape");
    let tooltipDismissed = false;
    for (let i = 0; i < 20; i++) {
      const state = await tooltipState();
      if (!state.some((entry) => (entry as { phase?: string }).phase === "open")) {
        tooltipDismissed = true;
        break;
      }
      await page.waitForTimeout(150);
    }
    const tooltipsAfterEscape = await tooltipState();
    log.push({ step: "after-escape", tooltipDismissed, tooltipsAfterEscape });
    console.log(`[proof] tooltip dismissed by Escape: ${tooltipDismissed}`);
    console.log(`[proof] tooltips after Escape: ${JSON.stringify(tooltipsAfterEscape)}`);
    await page.screenshot({ path: shot(`${label}-03-escape-dismissed.png`) });

    // 6. Onward Tab leaves the chip for the next control
    await page.keyboard.press("Tab");
    const next = await activeElementInfo();
    log.push({ step: "onward-tab", next });
    console.log(`[proof] onward Tab focus: ${JSON.stringify(next)}`);
    await page.screenshot({ path: shot(`${label}-04-onward-tab.png`) });
  } else {
    // BEFORE build: chip is skipped. Capture the moment focus passes through the
    // widget bar (lands on the widget menu button right after the chip).
    let capturedBarPass = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const info = await activeElementInfo();
      const inWidgetBar = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el?.closest?.(".board-widget__bar");
      });
      if (inWidgetBar) {
        const tooltips = await tooltipState();
        log.push({ step: "focus-passed-widget-bar", info, tooltips });
        console.log(`[proof] focus passed widget bar: ${JSON.stringify(info)} tooltips=${JSON.stringify(tooltips)}`);
        await page.screenshot({ path: shot(`${label}-02-focus-passes-widget-bar.png`) });
        capturedBarPass = true;
        break;
      }
    }
    if (!capturedBarPass) {
      await page.screenshot({ path: shot(`${label}-02-no-chip-focus.png`) });
      log.push({ step: "widget-bar-focus-not-captured" });
    }
  }

  fs.writeFileSync(path.join(outDir, `${label}-capture-log.json`), JSON.stringify(log, null, 2));
  console.log(`[proof] done (${label}); artifacts in ${outDir}`);
} finally {
  await context.close().catch(() => {});
  const video = page.video();
  if (video) {
    try {
      const videoPath = await video.path();
      const target = path.join(outDir, `${label}-keyboard-recording.webm`);
      fs.renameSync(videoPath, target);
      console.log(`[proof] recording: ${target}`);
    } catch (error) {
      console.log(`[proof] recording save failed: ${String(error).slice(0, 200)}`);
    }
  }
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
