# Executed simulator evidence for openclaw/openclaw#193809 (issue #193789)

Fork workflow run (phased, macOS runner, iOS 26.5 simulator, loopback Gateway fixture):
https://github.com/LiuwqGit/openclaw/actions/runs/42225270644

- Head under test: `3723d9781e51d0830e9ac711fad37241c7889994` (this PR's head)
- Base under test: upstream `main` at `d4ae77eae296` with
  `apps/ios/Sources/Design/CommandCenterTab.swift` and
  `apps/ios/Sources/RootSidebarModel.swift` reverted to it (fix absent)
- Fixture: `node scripts/test-ios-shell-gateway.mjs --port=19876` — the existing
  loopback Gateway with its default 205-session roster; `/partial` rejects every
  later `sessions.list` page, `/complete` restores normal pagination

## media/

| File | What it shows |
| --- | --- |
| `head-green-partial-roster.png` | HEAD under `/partial`: retained sessions stay listed beside the incomplete-load notice "Showing 200 sessions; 205 total. Refresh to load the rest." with the in-screen Refresh control |
| `head-green-complete-roster.png` | HEAD after `/complete` plus one Refresh tap: the header counts 204 visible sessions (205 minus the main conversation) and the notice is gone |
| `base-red-partial-roster.png` | BASE: the same retained rows presented as complete — no notice, no retry |
| `base-red-screen-recording.mp4` | BASE: screen recording of the failing run (notice assertion times out) |
| `sessions-partial-roster-trace.txt` | HEAD: XCTAttachment runtime trace (launch args, fixture, retained rows, notice, Refresh label/identifier, 204-session recovery) |

## logs/

| File | What it shows |
| --- | --- |
| `summary.txt` | Phase summary: head execution GREEN (xcodebuild exit 0), base execution RED (exit 65) |
| `test-head-green.log` | `CommandSessionsPartialRosterUITests` passed at head (115.9 s) through the real paginated `sessions.list` path |
| `test-base-red.log` | Same test failed at the unfixed base: "Retained rows need an incomplete-result notice" |
