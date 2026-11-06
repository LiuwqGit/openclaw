#!/usr/bin/env bash
# Evidence harness for openclaw/openclaw#193809 (issue #193789) — one phase per
# invocation, so a later phase that runs out of job time cannot take the earlier
# evidence with it.
#
#   prepare    : toolchain report, dependencies, project generation, simulator
#   build-head : build the PR head (75f55a6c7c75) for testing
#   test-head  : execute SessionsPartialLoadUITests at the PR head (expected GREEN)
#   build-base : replace the two fixed sources with upstream main's versions, rebuild
#   test-base  : execute the same UITest against the unfixed base  (expected RED)
#
# Evidence branch only: none of this is part of the PR diff.
set -uo pipefail

phase="${1:?usage: sessions-partial-phase.sh prepare|build-head|test-head|build-base|test-base}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
GITHUB_ENV="${GITHUB_ENV:-/dev/null}"
GITHUB_PATH="${GITHUB_PATH:-/dev/null}"
HEAD_SHA="${HEAD_SHA:?}"
FIX_FILES="${FIX_FILES:-apps/ios/Sources/Design/CommandCenterTab.swift apps/ios/Sources/RootSidebarModel.swift}"
TEST_SELECTOR="${TEST_SELECTOR:--only-testing:OpenClawUITests/CommandSessionsPartialRosterUITests}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
PROOF_DIR="${PROOF_DIR:-$RUNNER_TEMP/proof}"
DERIVED_DATA="${DERIVED_DATA:-$RUNNER_TEMP/DerivedData}"
STATE_FILE="$PROOF_DIR/simulator-id.txt"
BUILD_BUDGET="${BUILD_BUDGET:-5400}"
TEST_BUDGET="${TEST_BUDGET:-1800}"

mkdir -p "$PROOF_DIR"
log() { printf '\n=== [%s] %s ===\n' "$(date -u +%H:%M:%S)" "$*"; }
note() { printf '%s\n' "$*" | tee -a "$PROOF_DIR/summary.txt"; }

# macOS images ship neither timeout(1) nor gtimeout(1) reliably, so bound a command
# with a watchdog subshell instead.
run_bounded() {
  local budget="$1" log_path="$2"
  shift 2
  "$@" > "$log_path" 2>&1 &
  local command_pid=$!
  (
    sleep "$budget"
    kill -TERM "$command_pid" 2>/dev/null || true
    sleep 90
    kill -KILL "$command_pid" 2>/dev/null || true
  ) &
  local watchdog_pid=$!
  local status=0
  wait "$command_pid" || status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  printf '[%s] command finished with exit %s after %ss budget\n' "$(date -u +%H:%M:%S)" "$status" "$budget"
  tail -300 "$log_path"
  return "$status"
}

read_simulator() {
  [[ -f "$STATE_FILE" ]] && IOS_SIMULATOR_ID="$(cat "$STATE_FILE")"
  if [[ -z "${IOS_SIMULATOR_ID:-}" ]]; then
    echo "::error::no simulator recorded; run the prepare phase first"
    exit 1
  fi
  export IOS_SIMULATOR_ID
  export PATH="$RUNNER_TEMP/openclaw-swift-tools:$PATH"
  # The loopback Gateway fixture supplies the 205-session roster plus /partial and
  # /complete controls; xcodebuild forwards TEST_RUNNER_-prefixed env to XCTest.
  export FIXTURE_PORT="${FIXTURE_PORT:-19876}"
  export TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE="${TEST_RUNNER_OPENCLAW_IOS_LIVE_SETUP_CODE:-{\"url\":\"ws://127.0.0.1:${FIXTURE_PORT}\",\"token\":\"synthetic-navigation-token\"}}"
  export TEST_RUNNER_OPENCLAW_IOS_APPROVAL_FIXTURE_URL="${TEST_RUNNER_OPENCLAW_IOS_APPROVAL_FIXTURE_URL:-http://127.0.0.1:${FIXTURE_PORT}}"
  xcrun simctl bootstatus "$IOS_SIMULATOR_ID" -b
  fixture_state="$(curl -sf "http://127.0.0.1:${FIXTURE_PORT}/" 2>/dev/null || true)"
  [[ -n "$fixture_state" ]] || { echo "::error::loopback Gateway fixture not responding on port $FIXTURE_PORT"; exit 1; }
  echo "fixture state: ${fixture_state:0:200}"
}

# Ad-hoc signing, not CODE_SIGNING_ALLOWED=NO: an unsigned simulator build has no
# entitlements, so the app-group container the fixture transport relies on is
# unavailable (openclaw/openclaw#191474 observed Keychain -34018 without it).
xcodebuild_args=(
  -project apps/ios/OpenClaw.xcodeproj
  -scheme OpenClawUITests
  -configuration Debug
  CODE_SIGNING_ALLOWED=YES
  CODE_SIGNING_REQUIRED=NO
  CODE_SIGN_STYLE=Manual
  CODE_SIGN_IDENTITY=-
  DEVELOPMENT_TEAM=
  PROVISIONING_PROFILE_SPECIFIER=
  COMPILER_INDEX_STORE_ENABLE=NO
  ARCHS=arm64
  ONLY_ACTIVE_ARCH=YES
)
destination() { printf 'platform=iOS Simulator,id=%s' "$IOS_SIMULATOR_ID"; }

case "$phase" in
  prepare)
    log "Host, Xcode and simulator inventory"
    sw_vers || true
    uname -a
    ls -d /Applications/Xcode*.app 2>/dev/null || true
    newest_xcode="$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)"
    [[ -n "$newest_xcode" ]] && sudo xcode-select -s "$newest_xcode/Contents/Developer"
    xcode-select -p
    xcodebuild -version | tee "$PROOF_DIR/toolchain.txt"
    swift --version 2>&1 | tee -a "$PROOF_DIR/toolchain.txt"
    {
      echo "xcrun simctl list runtimes"
      xcrun simctl list runtimes
      echo
      echo "xcrun simctl list devices available"
      xcrun simctl list devices available
    } > "$PROOF_DIR/simulator-inventory.txt" 2>&1
    cat "$PROOF_DIR/simulator-inventory.txt"
    note "host: $(sw_vers -productVersion 2>/dev/null) / $(xcodebuild -version | paste -sd ' ' -)"
    note "head proven: $(git rev-parse HEAD) (PR head $HEAD_SHA)"

    log "Fetch upstream main for the RED build (fix absent)"
    git remote remove upstream 2>/dev/null || true
    git remote add upstream "$UPSTREAM_URL"
    git fetch --depth=1 upstream main
    BASE_SHA="$(git rev-parse upstream/main)"
    note "base proven: upstream/main $BASE_SHA"
    printf '%s' "$BASE_SHA" > "$PROOF_DIR/base-sha.txt"

    log "Node and pnpm"
    node --version
    if ! command -v pnpm >/dev/null 2>&1; then
      corepack enable || npm install --global pnpm@12.15.0
      corepack prepare pnpm@12.15.0 --activate || npm install --global pnpm@12.15.0
    fi
    pnpm --version

    log "Native asset dependencies"
    CI=true pnpm install --frozen-lockfile --prefer-offline --optional \
      --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
      --config.ignore-scripts=false --config.engine-strict=false \
      --config.enable-pre-post-scripts=true --config.side-effects-cache=true 2>&1 | tail -20

    log "xcodegen and the pinned Swift tools"
    tools_dir="$RUNNER_TEMP/openclaw-swift-tools"
    ./scripts/install-xcodegen.sh "$tools_dir"
    ./scripts/install-swift-tools.sh "$tools_dir"
    echo "$tools_dir" >> "$GITHUB_PATH"
    export PATH="$tools_dir:$PATH"
    xcodegen --version && swiftformat --version && swiftlint version 2>&1 | head -1

    # The watch app target builds the WatchRTC Rust static libraries. This harness
    # proves the Sessions screen partial-roster behavior, not the companion watch app,
    # and a fork runner has no WatchRTC cargo cache.
    log "Drop the embedded watch app from the generated project (harness only)"
    python3 - <<'PY' | tee "$PROOF_DIR/project-patch.txt"
import pathlib
import sys

spec = pathlib.Path("apps/ios/project.yml")
text = spec.read_text()
marker = "\ntargets:\n  OpenClaw:\n    type: application\n"
start = text.index(marker)
end = text.index("\n  OpenClawShareExtension:", start)
block = text[start:end]
dependency = "      - target: OpenClawWatchApp\n"
count = block.count(dependency)
if count != 1:
    sys.exit(f"expected exactly one watch dependency in the OpenClaw target, found {count}")
spec.write_text(text[:start] + block.replace(dependency, "") + text[end:])
print("removed the OpenClawWatchApp dependency from the OpenClaw target")
PY
    [[ -s "$PROOF_DIR/project-patch.txt" ]] || { echo "::error::watch dependency removal failed"; exit 1; }
    git --no-pager diff -- apps/ios/project.yml | tee "$PROOF_DIR/project-yml.patch"
    git status --short | tee "$PROOF_DIR/harness-tree.txt"

    log "Signing, version, Swift file list and xcodegen"
    ./scripts/ios-configure-signing.sh || echo "::warning::signing configuration reported a problem"
    ./scripts/ios-write-version-xcconfig.sh
    node scripts/ios-write-swift-filelist.mjs
    (cd apps/ios && xcodegen generate)

    log "Root dependencies for the loopback Gateway fixture (ws)"
    CI=true pnpm install --frozen-lockfile --prefer-offline \
      --config.ignore-scripts=false --config.engine-strict=false \
      --config.enable-pre-post-scripts=true --config.side-effects-cache=true 2>&1 | tail -5
    node -e "console.log('ws at', require.resolve('ws'))"

    log "Start the loopback Gateway fixture (205-session roster, /partial + /complete)"
    nohup node scripts/test-ios-shell-gateway.mjs --port="${FIXTURE_PORT:-19876}" \
      > "$PROOF_DIR/fixture-gateway.log" 2>&1 &
    echo $! > "$PROOF_DIR/fixture-gateway.pid"
    fixture_state=""
    for _ in $(seq 1 30); do
      fixture_state="$(curl -sf "http://127.0.0.1:${FIXTURE_PORT:-19876}/" 2>/dev/null || true)"
      [[ -n "$fixture_state" ]] && break
      sleep 1
    done
    fixture_state="$(curl -sf "http://127.0.0.1:${FIXTURE_PORT:-19876}/" 2>/dev/null || true)"
    [[ -n "$fixture_state" ]] || { echo "::error::fixture failed to start"; cat "$PROOF_DIR/fixture-gateway.log"; exit 1; }
    note "fixture: http://127.0.0.1:${FIXTURE_PORT:-19876}/ -> ${fixture_state:0:120}"
    echo "FIXTURE_PORT=${FIXTURE_PORT:-19876}" >> "$GITHUB_ENV"

    log "Select and boot an iOS simulator (deployment target iOS 26.2)"
    IOS_SIMULATOR_ID="$(python3 - <<'PY'
import json, re, subprocess, sys

listing = json.loads(subprocess.run(
    ["xcrun", "simctl", "list", "devices", "available", "--json"],
    check=True, capture_output=True, text=True).stdout)


def version(runtime):
    match = re.search(r"iOS-(\d+)[-.](\d+)", runtime)
    return tuple(int(part) for part in match.groups()) if match else (0, 0)


candidates = []
for runtime, devices in listing.get("devices", {}).items():
    if "iOS" not in runtime or version(runtime) < (26, 2):
        continue
    for device in devices:
        if device.get("isAvailable") and device.get("name", "").startswith("iPhone"):
            candidates.append((version(runtime), device["name"], device["udid"]))
if not candidates:
    sys.exit("no available iPhone simulator with an iOS 26.2+ runtime")
candidates.sort(reverse=True)
print(candidates[0][2])
PY
)"
    export IOS_SIMULATOR_ID
    [[ -n "$IOS_SIMULATOR_ID" ]] || { echo "::error::no usable simulator"; exit 1; }
    printf '%s' "$IOS_SIMULATOR_ID" > "$STATE_FILE"
    echo "IOS_SIMULATOR_ID=$IOS_SIMULATOR_ID" >> "$GITHUB_ENV"
    note "simulator: $IOS_SIMULATOR_ID"
    xcrun simctl bootstatus "$IOS_SIMULATOR_ID" -b
    note "RESULT prepare: simulator booted, project generated, fixture listening"
    ;;

  build-head)
    read_simulator
    log "Build the app and the UI test bundle for testing (PR head)"
    status=0
    run_bounded "$BUILD_BUDGET" "$PROOF_DIR/build-head.log" \
      xcodebuild "${xcodebuild_args[@]}" -destination "$(destination)" \
      -derivedDataPath "$DERIVED_DATA" -showBuildTimingSummary build-for-testing || status=$?
    if [[ "$status" -ne 0 ]]; then
      note "RESULT head build: FAILED (exit $status)"
      grep -n "error:" "$PROOF_DIR/build-head.log" | head -40 | tee -a "$PROOF_DIR/summary.txt"
      exit "$status"
    fi
    note "RESULT head build-for-testing: SUCCEEDED"
    ;;

  test-head)
    read_simulator
    log "Execute SessionsPartialLoadUITests at the PR head (expected GREEN)"
    status=0
    run_bounded "$TEST_BUDGET" "$PROOF_DIR/test-head-green.log" \
      xcodebuild "${xcodebuild_args[@]}" -destination "$(destination)" \
      -derivedDataPath "$DERIVED_DATA" \
      -resultBundlePath "$PROOF_DIR/head-green.xcresult" \
      -parallel-testing-enabled NO \
      -collect-test-diagnostics never \
      -test-timeouts-enabled YES \
      -default-test-execution-time-allowance 600 \
      -maximum-test-execution-time-allowance 1200 \
      "$TEST_SELECTOR" test-without-building || status=$?
    grep -E "Test Suite|Test Case|passed|failed" "$PROOF_DIR/test-head-green.log" | tail -40
    if [[ "$status" -eq 0 ]]; then
      note "RESULT head execution: GREEN (xcodebuild exit 0)"
    else
      note "RESULT head execution: FAILED (xcodebuild exit $status)"
      exit "$status"
    fi
    ;;

  build-base)
    read_simulator
    log "Replace the two fixed sources with upstream main's versions (fix absent)"
    BASE_SHA="$(cat "$PROOF_DIR/base-sha.txt")"
    git checkout upstream/main -- $FIX_FILES
    git --no-pager diff --stat -- $FIX_FILES | tee "$PROOF_DIR/behaviour-revert.txt"
    git --no-pager diff -- $FIX_FILES > "$PROOF_DIR/behaviour-revert.patch"
    log "Rebuild with the unfixed base sources"
    status=0
    run_bounded "$BUILD_BUDGET" "$PROOF_DIR/build-base.log" \
      xcodebuild "${xcodebuild_args[@]}" -destination "$(destination)" \
      -derivedDataPath "$DERIVED_DATA" build-for-testing || status=$?
    if [[ "$status" -ne 0 ]]; then
      note "RESULT base build: FAILED (exit $status)"
      grep -n "error:" "$PROOF_DIR/build-base.log" | head -40 | tee -a "$PROOF_DIR/summary.txt"
      git checkout HEAD -- $FIX_FILES
      exit "$status"
    fi
    note "RESULT base build-for-testing: SUCCEEDED (fix removed at upstream/main $BASE_SHA)"
    printf 'ok' > "$PROOF_DIR/base-build.ok"
    ;;

  test-base)
    read_simulator
    if [[ ! -f "$PROOF_DIR/base-build.ok" ]]; then
      note "RESULT base execution: NOT RUN (the base build failed)"
      git checkout HEAD -- $FIX_FILES
      exit 1
    fi
    log "Execute SessionsPartialLoadUITests against the unfixed base (expected RED)"
    status=0
    run_bounded "$TEST_BUDGET" "$PROOF_DIR/test-base-red.log" \
      xcodebuild "${xcodebuild_args[@]}" -destination "$(destination)" \
      -derivedDataPath "$DERIVED_DATA" \
      -resultBundlePath "$PROOF_DIR/base-red.xcresult" \
      -parallel-testing-enabled NO \
      -collect-test-diagnostics never \
      -test-timeouts-enabled YES \
      -default-test-execution-time-allowance 600 \
      -maximum-test-execution-time-allowance 1200 \
      "$TEST_SELECTOR" test-without-building || status=$?
    grep -E "Test Suite|Test Case|passed|failed|XCTAssert" "$PROOF_DIR/test-base-red.log" | tail -40
    git checkout HEAD -- $FIX_FILES
    if [[ "$status" -eq 0 ]]; then
      note "RESULT base execution: UNEXPECTEDLY GREEN — the regression does not discriminate the fix"
      exit 1
    fi
    note "RESULT base execution: RED (xcodebuild exit $status), as required"
    ;;

  *)
    echo "unknown phase: $phase" >&2
    exit 2
    ;;
esac

log "Phase '$phase' summary"
cat "$PROOF_DIR/summary.txt"
