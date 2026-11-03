# Executed simulator proof — openclaw/openclaw#191474 (issue #191449)

Real execution of the regression this PR adds, on a real iOS simulator, at the PR head and
against main's screen-wide interaction lock. Nothing here is projected or inferred from source:
the numbers and images below come out of an `xcodebuild test-without-building` run.

- **PR**: https://github.com/openclaw/openclaw/pull/191474
- **PR head proven**: `2d584dfbf6774a422dff07978c8ef99f1683c2b4`
  (`git rev-parse HEAD` in the job: `head proven: c8f0e75fb99f71c7429ed1f3e3a8157b38fc1649 (PR head 2d584dfbf6774a422dff07978c8ef99f1683c2b4)`;
  `c8f0e75fb99` is that PR head plus the three harness changes listed below)
- **Job**: https://github.com/LiuwqGit/openclaw/actions/runs/41625312234/job/125881057690
- **Host**: macOS 26.6.2, Xcode 26.6 (Build 17F113), Apple Swift 6.3.3, GitHub-hosted `macos-latest` (arm64)
- **Simulator**: iPhone Air, iOS 26.5 runtime, `1F0A9C4B-2DFC-444E-B162-696E5078A72B`
- **Test**: `-only-testing:OpenClawTests/ChatProTabRecoveryControlsTests`

## Result

| Variant | Build | Execution |
|---|---|---|
| PR head `2d584dfbf67` | SUCCEEDED | **GREEN** (xcodebuild exit 0, both test methods passed) |
| PR head with main's screen-wide `.disabled` re-applied to `content` | SUCCEEDED | **RED** (xcodebuild exit 65, 6 failed assertions) |

The reverted variant is exactly one line, main's placement of the same unchanged lock expression
(`logs/behaviour-revert.patch`):

```diff
     var body: some View {
         self.content
+            .disabled(self.isChatMutationLocked)
```

Rendered states the regression read back out of the simulator (`logs/control-states-*.txt`):

```text
PR head                        main's screen-wide lock
toolbarItems: 3                toolbarItems: 3
toolbarInteractive: 3          toolbarInteractive: 0
toolbarDimmed: 0               toolbarDimmed: 3
lockedChatControls: 4          lockedChatControls: 4
composerRendered: true         composerRendered: true
```

Failing assertions in the reverted run (`logs/test-reverted-red.log`), all three bar items —
the sidebar toggle, the gateway status button and Chat actions:

```text
ChatProTabRecoveryControlsTests.swift:147: error: XCTAssertTrue failed - Toolbar item 0 must stay tappable while the automatic reconnect retries.
ChatProTabRecoveryControlsTests.swift:150: error: XCTAssertFalse failed - Toolbar item 0 must not render dimmed while the automatic reconnect retries.
ChatProTabRecoveryControlsTests.swift:147: error: XCTAssertTrue failed - Toolbar item 1 must stay tappable while the automatic reconnect retries.
ChatProTabRecoveryControlsTests.swift:150: error: XCTAssertFalse failed - Toolbar item 1 must not render dimmed while the automatic reconnect retries.
ChatProTabRecoveryControlsTests.swift:147: error: XCTAssertTrue failed - Toolbar item 2 must stay tappable while the automatic reconnect retries.
ChatProTabRecoveryControlsTests.swift:150: error: XCTAssertFalse failed - Toolbar item 2 must not render dimmed while the automatic reconnect retries.
```

The chat surface stays locked in **both** variants (`lockedChatControls: 4`, composer rendered),
which is the protection the fix must not lose; only the toolbar flips. That is the whole change.

## Media

Both images are `XCTAttachment` screenshots the regression itself took from the simulator window
during the run (`UIGraphicsImageRenderer` + `drawHierarchy(afterScreenUpdates: true)`), 1260×2736:

- `media/screen-pr-head.png` — PR head: toolbar rendered at full strength
- `media/screen-main-screen-wide-lock.png` — main's lock: toolbar dimmed
- `media/toolbar-side-by-side.png` — the navigation-bar band of both, head left / main's lock right
- `media/toolbar-pr-head.png`, `media/toolbar-main-screen-wide-lock.png` — the same crops separately
- `media/screen-difference-amplified.png` — per-pixel absolute difference ×4
- `media/render-comparison.json` — the numbers below

Measured over the navigation-bar band (pixels y 190–380 of 2736):

```json
{
  "head":      { "mean_luminance": 242.877, "min": 33.0,  "max": 255.0 },
  "main_lock": { "mean_luminance": 245.832, "min": 140.0, "max": 252.33 }
}
```

The darkest glyph pixel in the band goes from 33 (full-strength icon strokes) to 140 (dimmed),
which is the half-alpha content the renderer publishes for a disabled SwiftUI control;
8445 pixels differ screen-wide, 3.53% of them inside the toolbar band.

## Why this ran outside the PR's own CI

`scripts/ci-build-manifest.mjs` gates every Apple **test** lane behind `!ordinaryPullRequest`
(`runMacos` :366, `runIosBuild` :399), so a fork `pull_request` compiles the iOS sources
(`Build iOS Periphery reports`, build-for-testing) but never executes them; `ios-screenshots`
runs only the four `RELEASE_IOS_SCREENSHOT_TESTS` (`apps/ios/fastlane/Fastfile:1967`). This job
runs the regression in the contributor fork instead, on GitHub-hosted macOS.

## Harness changes (evidence branch only — the PR diff is untouched)

1. `apps/ios/Sources/Proof/Xcode26ToolbarCompatibilityShim.swift` — hosted macOS runners ship at
   most Xcode 26.6 (iOS 26.5 SDK), while the app already calls `axisBehavior`,
   `visibilityPriority` and `\.toolbarVerticalEdge` behind `#available(iOS 27.1, *)`. The shim
   declares that surface as inert stand-ins so the **unmodified** app sources compile. Without it
   the build fails in upstream code, not in this PR's (`ChatProTab.swift:103`, `:764`).
2. `apps/ios/project.yml` — the `OpenClawWatchApp` dependency is removed from the `OpenClaw`
   target (`logs/project-yml.patch`). That target's prebuild script builds the WatchRTC Rust
   static libraries, which this harness does not need and a fork runner has no cargo cache for.
3. Ad-hoc code signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`) instead of an unsigned
   build. An unsigned simulator build carries no entitlements: Keychain writes fail with
   `OSStatus -34018` and the app-group container the gateway registry lives in is unavailable, so
   the fixture cannot persist the saved endpoint and never reaches the retry boundary.

`ChatProTab.swift`, the regression and every other source file are byte-identical to the PR head
in both variants; the only production difference between the two runs is the one-line revert
above. `logs/harness-tree.txt` is the job's own `git status` at build time.

## What this does not prove

- It is a simulator, not the reporter's iPhone, and iOS 26.5 / Xcode 26.6 rather than the
  Xcode 27.1 lane upstream builds with. The iOS 27.1 toolbar branches are shimmed to inert
  stand-ins, so the run exercises the `#available(iOS 27.1, *) == false` path of the bar.
- The regression drives the reported state through the app's own ingress/connection controller
  with an injected unreachable-endpoint probe failure; it does not dial a real dead LAN host.
- The recovery *route* (status button → Gateway settings) is pinned by the source-level guard,
  not by this run: iOS 26 renders bar items into `UIKitBarItemHost` views that publish no
  accessibility identifier, label or element in-process, so a bar item cannot be identified or
  activated from inside the test host. Asserting it needs XCUITest, whose lanes are exactly the
  ones gated behind `!ordinaryPullRequest`.
- Endpoint repair followed by reconnection is not covered by this fixture.

## Files

```text
logs/summary.txt                                     the job's own RESULT lines
logs/test-head-green.log                             xcodebuild test log, PR head (GREEN)
logs/test-reverted-red.log                           xcodebuild test log, main's lock (RED)
logs/control-states-pr-head.txt                      attachment: states read at head
logs/control-states-main-screen-wide-lock.txt        attachment: states read under main's lock
logs/rendered-inventory-pr-head.txt                  attachment: full rendered view inventory
logs/rendered-inventory-main-screen-wide-lock.txt    attachment: same, under main's lock
logs/behaviour-revert.patch                          the one-line revert that produces RED
logs/build-head-tail.log, logs/build-reverted-tail.log
logs/build-head-compiled-files.txt                   the two changed Swift files in the compile
logs/toolchain.txt, logs/simulator-inventory.txt, logs/harness-tree.txt, logs/project-yml.patch
```
