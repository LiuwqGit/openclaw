# Browser behavior proof for PR #181240

Shipped Control UI bundle (vite production build, `startBundledControlUiE2eServer`
provisioning identical to CI's `vitest.ui-e2e.bundled.global-setup.ts`) driven in
headless Chromium via the repo's own mock-gateway e2e harness
(`ui/src/test-helpers/control-ui-e2e.ts`).

Scenario: dashboard session with one granted HTML widget declaring
`netOrigins: ["https://api.example.com"]`, `tools: ["health"]`. The capture
walks the real Tab order from the document start.

## after (patched, PR head db56b8906e6)

- `after-keyboard-recording.webm` — recording: Tab reaches the Granted chip,
  focus indicator + capability tooltip open, Escape dismisses it, Tab moves on.
- `after-02-focus-on-chip-tooltip-open.png` — Tab #24 lands on the chip
  (`document.activeElement` is the chip; computed outline `2px solid`;
  tooltip `data-phase="open"` with "Active widget capabilities / Network:
  https://api.example.com / Tool: health").
- `after-03-escape-dismissed.png` — after Escape the tooltip is no longer open.
- `after-04-onward-tab.png` — next Tab moves focus to the widget menu button.
- `after-capture-log.json` — full Tab sequence + DOM facts.

## before (origin/main build of the same tree, only
`ui/src/components/board/board-widget-capabilities.solid.tsx` reverted)

- `before-02-focus-passes-widget-bar.png` — focus passes the widget bar and
  lands directly on the Widget options button; the chip (`tabindex` absent,
  `aria-label` absent) is skipped. 160 Tab presses never focused the chip.
- `before-capture-log.json` — full sequence proving the chip is unreachable.

Sensitive values: none — all origins/tools are fixture values.
