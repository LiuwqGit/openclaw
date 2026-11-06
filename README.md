# Executed simulator evidence for openclaw/openclaw#193809 (issue #193789)

Fork workflow run (phased, macOS runner, iOS 26.5 simulator):
https://github.com/LiuwqGit/openclaw/actions/runs/42214051310

- Head under test: `8e25134a7200622232e655b30dd9c0f26cff3b10` (this PR's head)
- Base under test: upstream `main` at `f15e8236a999a4d629814714371f49c586bb119a`
  with `apps/ios/Sources/Design/CommandCenterTab.swift` and
  `apps/ios/Sources/RootSidebarModel.swift` reverted to it (fix absent)

## media/

| File | What it shows |
| --- | --- |
| `head-green-sessions-partial-roster.png` | HEAD: 200 retained rows listed with the incomplete-load notice "Showing 200 sessions; 201 total. Refresh to load the rest." and the in-screen Refresh button above the rows |
| `head-green-sessions-recovered.png` | HEAD after one in-screen Refresh tap: header counts 201 sessions, notice cleared |
| `base-red-sessions-partial-roster.png` | BASE: the same 200 rows listed, presented as complete — no notice, no retry |
| `base-red-screen-recording.mp4` | BASE: screen recording of the failing run (notice assertion times out) |
| `sessions-partial-load-trace.txt` | HEAD: XCTAttachment runtime trace (launch args, retained rows, notice, 1 refresh tap, 201-session recovery) |

## logs/

| File | What it shows |
| --- | --- |
| `summary.txt` | Phase summary: head execution GREEN (xcodebuild exit 0), base execution RED (exit 65) |
| `test-head-green.log` | `SessionsPartialLoadUITests` passed at head (42.6 s) |
| `test-base-red.log` | Same test failed at the unfixed base: "Partial roster was presented as complete: no incomplete-load notice" |
